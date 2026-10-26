// Why a task finishes when it does: the chain of what held it back, followed from the task to the
// root cause (a fixed start, or an owner busy with other work). Used in late-task messages and
// tooltips, so a single wrong date does not hide behind dozens of "late" warnings. Causes are
// worked out once per schedule: diagnostics, the Gantt and the hovers ask for every task.
import { type Calendar } from "./calendar";
import { type DayNumber, formatDate } from "./dates";
import { type DepNode } from "./graph";
import { type Task } from "./model";
import { type Plan } from "./resolve";
import { startedOn } from "./rollup";
import {
  type Allocation,
  type Schedule,
  startAfter,
  type StartDriver,
  type TaskSchedule,
} from "./scheduler";

const EPS = 1e-6;

export interface LateCause {
  /** A fixed start (`@start`), or an owner whose other work came first. */
  kind: "start" | "busy";
  /** The task with the fixed start, or the task whose owner was busy. */
  task: Task;
  /** The fixed start. */
  day?: DayNumber;
  /** The busy resource (lower-case person id or `unassigned`). */
  resource?: string;
  /** The milestones and tasks in between, starting next to the late task. */
  via: string[];
}

/** What kept a task from starting when it could (see `daysOf`). */
interface Days {
  /** The hours of its owner's earliest day that the work it waits for took (see `handedOver`). */
  taken: number;
  /** The working days it waited for its owner's other work. */
  wait: number;
  /** The working days its fixed start kept it back from the day it could otherwise have started. */
  held: number;
}

interface LateCauses {
  causes: Map<Task, LateCause | undefined>;
  days: Map<TaskSchedule, Days>;
  /** Per task: the fixed start it would move without (see `rootOf`). */
  roots: Map<TaskSchedule, TaskSchedule | null>;
  /** Per task: when it would have finished without the fixed start before it (`pushOf`). */
  moved: Map<TaskSchedule, Finish>;
  /** Per task: when it finishes, worked out the same way (see `baseFinish`). */
  finish: Map<TaskSchedule, Finish>;
  /** Per task: the work before it on the day it finished (see `sameDayWork`). */
  sameDay: Map<TaskSchedule, TaskSchedule[]>;
  /** The hours each task got on the day it finished; worked out when first needed. */
  lastDayHours?: Map<Task, number>;
  /** Who worked when; worked out when first needed (see `booked`). */
  booked?: Booked;
}

/** The work as scheduled, by resource and day, by task, and the tasks of each resource. */
interface Booked {
  byDay: Map<string, Map<DayNumber, Allocation[]>>;
  byTask: Map<Task, Allocation[]>;
  byResource: Map<string, TaskSchedule[]>;
}

const lateCauses = new WeakMap<Schedule, LateCauses>();

/**
 * The root cause of a task's start, or undefined when it simply starts as soon as possible. The
 * chain of predecessors is followed to its end. A fixed start on the way is the cause (often a
 * wrong date) when it kept the task back at least as many working days as any wait for an owner's
 * other work between it and the task; otherwise the longest of those waits is, and what came
 * before the fixed start does not matter. What a fixed start keeps the task back is how much
 * earlier the task would finish without it, at most what it kept its own task back: less when an
 * owner after it would have been busy anyway with work that goes first (then that work is the
 * cause), or does not work on those days. A fixed start that held its task back no working day
 * changes nothing: the chain goes on through the dependency that set the day anyway. All delays
 * are working days of the project, so a part-timer's week weighs as much as anyone's.
 */
export function lateCause(schedule: Schedule, task: Task): LateCause | undefined {
  let memo = lateCauses.get(schedule);
  if (!memo) {
    memo = {
      causes: new Map(),
      days: new Map(),
      roots: new Map(),
      moved: new Map(),
      finish: new Map(),
      sameDay: new Map(),
    };
    lateCauses.set(schedule, memo);
  }
  if (!memo.causes.has(task)) memo.causes.set(task, findLateCause(schedule, task, memo));
  return memo.causes.get(task);
}

function findLateCause(schedule: Schedule, task: Task, memo: LateCauses): LateCause | undefined {
  const via: string[] = [];
  // The tasks from the late task back to the current one.
  const chain: TaskSchedule[] = [];
  const seen = new Set<Task>();
  // The longest wait so far, with the length of the chain up to its task.
  let busy: { task: Task; resource: string; days: number; via: number } | undefined;
  for (let t = task; !seen.has(t);) {
    seen.add(t);
    const ts = schedule.tasks.get(t);
    if (!ts || ts.done || ts.earliest === undefined || ts.start === undefined) break;
    chain.push(ts);
    const { wait, held } = daysOf(schedule, memo, ts);
    if (wait > 0 && (!busy || wait > busy.days))
      busy = { task: t, resource: ts.resource, days: wait, via: via.length };
    let d = ts.driver;
    if (d?.kind === "start") {
      if (held > 0) {
        // Still keeping the late task back at least one working day, and as many as the longest
        // wait, makes the fixed start the cause (what it keeps back is `held` at most).
        const needed = Math.max(1, busy?.days ?? 0);
        if (held >= needed && pushOf(schedule, memo, chain) >= needed)
          return { kind: "start", task: d.from, day: ts.earliest, via: trimRoot(via, d.from) };
        break;
      }
      d = d.dep;
    }
    if (!d) break;
    const step =
      typeof d.declaredBy === "string" && d.on.milestoneId !== t.milestoneId
        ? (d.on.milestoneId ?? d.on.id ?? d.on.title)
        : (d.on.id ?? d.on.title);
    if (via[via.length - 1] !== step) via.push(step);
    t = d.on;
  }
  return busy
    ? {
        kind: "busy",
        task: busy.task,
        resource: busy.resource,
        via: trimRoot(via.slice(0, busy.via), busy.task),
      }
    : undefined;
}

/** The chain without its last link when that is the root task itself. */
function trimRoot(via: string[], root: Task): string[] {
  return via[via.length - 1] === (root.id ?? root.title) ? via.slice(0, -1) : via;
}

/**
 * How many working days the task waited for its owner's other work (not started yet, and placed
 * later than the first day its owner could have worked on it), and how many its fixed start kept
 * it back from the day it could otherwise have started. A task without hours needs no capacity: it
 * is done on the first working day of the project it is ready, so it never waits. Worked out once
 * per task: many chains run through the same tasks.
 */
function daysOf(schedule: Schedule, memo: LateCauses, ts: TaskSchedule): Days {
  let days = memo.days.get(ts);
  if (!days) {
    const cal = schedule.calendar;
    const d = ts.driver;
    if (ts.scheduledHours <= EPS) {
      const ready = cal.nextWorkingDay(ts.earliest!);
      const held = d?.kind === "start" ? between(cal, cal.nextWorkingDay(d.otherwise), ready) : 0;
      days = { taken: 0, wait: 0, held };
    } else {
      const taken = handedOver(schedule, memo, ts, ts.earliest!);
      const ready = readyFrom(schedule, ts, ts.earliest!, taken);
      const otherwise =
        d?.kind === "start"
          ? readyFrom(schedule, ts, d.otherwise, handedOver(schedule, memo, ts, d.otherwise))
          : ready;
      days = {
        taken,
        wait: startedOn(ts.task) ? 0 : between(cal, ready, ts.start!),
        held: between(cal, otherwise, ready),
      };
    }
    memo.days.set(ts, days);
  }
  return days;
}

/** The working days of the project in [from, to); at least 1 when `from` is earlier. */
function between(cal: Calendar, from: DayNumber, to: DayNumber): number {
  return from < to ? Math.max(1, cal.workingDaysBetween(from, to)) : 0;
}

/**
 * The first day from `day` on that the task's owner could have worked on it (by its finish at
 * most): one with working hours, and not `day` when the work it waits for took all of them.
 */
function readyFrom(schedule: Schedule, ts: TaskSchedule, day: DayNumber, taken: number): DayNumber {
  const cal = schedule.calendar;
  const first = taken > EPS && taken >= cal.capacity(ts.resource, day) - EPS ? day + 1 : day;
  for (let d = first; d < ts.finish!; d++) if (cal.capacity(ts.resource, d) > 0) return d;
  return Math.max(first, ts.finish!);
}

/**
 * The working days the fixed start of the last task of the chain (the late task back to it) still
 * kept the late task from finishing earlier, at most what it kept its own task back: the day each
 * task on the chain would have finished without it, one after the other (see `finishOn`), against
 * the day it finishes. Worked out once per task.
 */
function pushOf(schedule: Schedule, memo: LateCauses, chain: TaskSchedule[]): number {
  const root = chain[chain.length - 1];
  // Worked out from the fixed start on, so only the tasks after the last one known are left.
  let known = 0;
  while (known < chain.length && !memo.moved.has(chain[known])) known++;
  for (let i = known - 1; i >= 0; i--) {
    const ts = chain[i];
    const finish = baseFinish(schedule, memo, ts, root);
    let start: Start | undefined;
    const d = ts.driver;
    if (ts === root && d?.kind === "start") {
      // Ready when it could otherwise have started, and no longer first for its fixed start.
      const precedence = ts.precedence && [1, ...ts.precedence.slice(1)];
      start = {
        from: d.otherwise,
        taken: handedOver(schedule, memo, ts, d.otherwise),
        precedence,
        root,
        ahead: precedence && passedBy(schedule, memo, ts, precedence),
      };
    } else if (d?.kind !== "start") {
      const { from, taken } = startWithout(schedule, memo, ts, chain[i + 1], root);
      start = { from, taken, precedence: ts.precedence, root };
    }
    // A task its own fixed start holds anyway does not move.
    const moved = start && start.from < ts.earliest! ? finishOn(schedule, memo, ts, start) : finish;
    memo.moved.set(ts, moved.day < finish.day ? moved : finish);
  }
  return Math.min(
    daysOf(schedule, memo, root).held,
    between(schedule.calendar, memo.moved.get(chain[0])!.day, memo.finish.get(chain[0])!.day)
  );
}

/**
 * When the task could have started without the fixed start of `root`, and the hours of that day
 * that the work it waits for would take: when everything it waits for is done (the task before it
 * on the chain as worked out, the others that move with it too as early, the rest as scheduled),
 * and not before its own fixed start.
 */
function startWithout(
  schedule: Schedule,
  memo: LateCauses,
  ts: TaskSchedule,
  before: TaskSchedule,
  root: TaskSchedule
): { from: DayNumber; taken: number } {
  const lastHours = lastDayHours(schedule, memo);
  let from = Math.max(schedule.start, ts.fixedStart ?? schedule.start);
  let taken = 0;
  for (const r of schedule.graph.requirements.get(ts.task) ?? []) {
    let finish: Finish | undefined;
    for (const m of r.node.kind === "leaf" ? [r.node.task] : r.node.members) {
      const ms = schedule.tasks.get(m);
      let f: Finish | undefined;
      if (ms === before) f = memo.moved.get(before);
      else if (ms?.finish !== undefined && rootOf(schedule, memo, ms) !== root)
        f = { day: ms.finish, hours: lastHours.get(m) ?? 0 };
      if (f && (!finish || f.day > finish.day)) finish = f;
    }
    if (!finish) continue;
    const p = r.node.kind === "leaf" ? schedule.tasks.get(r.node.task) : undefined;
    const sameOwner = p?.resource === ts.resource && !p.done;
    const day = startAfter(schedule.calendar, r, finish.day, sameOwner);
    if (day > from) {
      from = day;
      taken = 0;
    }
    if (day === from && sameOwner) taken += finish.hours;
  }
  return { from, taken };
}

/**
 * The task with the fixed start that the task would move without: the first one on the chain of
 * what it waits for, when that held its task back (see `daysOf`) and every task on the way moves
 * with it. Null when there is none, or a task on the way is held by its own fixed start anyway.
 */
function rootOf(schedule: Schedule, memo: LateCauses, ts: TaskSchedule): TaskSchedule | null {
  const path: TaskSchedule[] = [];
  let root: TaskSchedule | null = null;
  for (let t: TaskSchedule | undefined = ts; t && path.length <= schedule.tasks.size;) {
    const known = memo.roots.get(t);
    if (known !== undefined) {
      root = known;
      break;
    }
    path.push(t);
    if (t.done || t.earliest === undefined || t.start === undefined) break;
    const d: StartDriver | undefined = t.driver;
    if (d?.kind === "start") {
      if (daysOf(schedule, memo, t).held > 0) root = t;
      break;
    }
    t = d && schedule.tasks.get(d.on);
  }
  for (const t of path) memo.roots.set(t, root);
  return root;
}

/**
 * The day the task finishes, worked out like the day it would finish otherwise (`finishOn`) from
 * its earliest day: one is weighed against the other.
 */
function baseFinish(
  schedule: Schedule,
  memo: LateCauses,
  ts: TaskSchedule,
  root: TaskSchedule
): Finish {
  let finish = memo.finish.get(ts);
  if (!finish) {
    finish = finishOn(schedule, memo, ts, {
      from: ts.earliest!,
      taken: daysOf(schedule, memo, ts).taken,
      precedence: ts.precedence,
      root,
    });
    memo.finish.set(ts, finish);
  }
  return finish;
}

/** When a task could start, and its place in its owner's work (see `finishOn`). */
interface Start {
  from: DayNumber;
  /** The hours of `from` that the work it waits for takes. */
  taken: number;
  precedence?: number[];
  /** The task with the fixed start it would move without. */
  root: TaskSchedule;
  /** Work that goes first from the task's earliest day on, and its hours from then on. */
  ahead?: Array<{ ts: TaskSchedule; hours: number }>;
}

/** The day a task finishes, and the hours it gets that day. */
interface Finish {
  day: DayNumber;
  hours: number;
}

/**
 * The day the task would finish when ready at `start`: its owner works on it in the hours left by
 * the work that goes first (lower precedence, see `TaskSchedule.precedence`) as scheduled, and by
 * the work `ahead` of it. Not the work that would move with it: behind the same fixed start, and
 * done when the task can start. Not later than its scheduled finish. A task without hours is done
 * on the first working day of the project; planning everyone's work at once (demand) leaves all
 * hours.
 */
function finishOn(schedule: Schedule, memo: LateCauses, ts: TaskSchedule, start: Start): Finish {
  const cal = schedule.calendar;
  if (ts.scheduledHours <= EPS || !start.precedence)
    return { day: Math.min(cal.nextWorkingDay(start.from), ts.finish!), hours: 0 };
  const byDay = booked(schedule, memo).byDay.get(ts.resource);
  const ahead = (start.ahead ?? []).map((w) => ({ ...w }));
  const passed = new Set(ahead.map((w) => w.ts));
  let left = ts.scheduledHours;
  for (let d = start.from; d < ts.finish!; d++) {
    let free = cal.capacity(ts.resource, d) - (d === start.from ? start.taken : 0);
    if (free <= EPS) continue;
    if (schedule.mode === "capacity") {
      // From the task's earliest day on, the work ahead of it gets its hours first.
      const replaced = d >= ts.earliest! && ahead.length > 0;
      for (const a of byDay?.get(d) ?? []) {
        const other = schedule.tasks.get(a.task)!;
        if (
          other !== ts &&
          other.precedence &&
          goesBefore(other.precedence, start.precedence) &&
          !(replaced && passed.has(other)) &&
          !(other.finish! <= ts.earliest! && rootOf(schedule, memo, other) === start.root)
        )
          free -= a.hours;
      }
      if (replaced)
        for (const w of ahead)
          if (w.hours > EPS && w.ts.earliest! <= d && free > EPS) {
            const hours = Math.min(w.hours, free);
            w.hours -= hours;
            free -= hours;
          }
    }
    if (free <= EPS) continue;
    if (left <= free + EPS) return { day: d, hours: left };
    left -= free;
  }
  return { day: ts.finish!, hours: lastDayHours(schedule, memo).get(ts.task) ?? 0 };
}

/**
 * The work of the task's owner that it went before for its fixed start, and that goes first
 * without it (`precedence`): with the hours it had left on the task's earliest day, in order.
 */
function passedBy(
  schedule: Schedule,
  memo: LateCauses,
  ts: TaskSchedule,
  precedence: number[]
): Array<{ ts: TaskSchedule; hours: number }> {
  const b = booked(schedule, memo);
  const passed: Array<{ ts: TaskSchedule; hours: number }> = [];
  for (const other of b.byResource.get(ts.resource) ?? []) {
    if (
      other === ts ||
      !other.precedence ||
      other.earliest! > ts.finish! ||
      !goesBefore(other.precedence, precedence) ||
      goesBefore(other.precedence, ts.precedence!)
    )
      continue;
    let hours = 0;
    for (const a of b.byTask.get(other.task) ?? []) if (a.day >= ts.earliest!) hours += a.hours;
    if (hours > EPS) passed.push({ ts: other, hours });
  }
  return passed.sort((x, y) => (goesBefore(x.ts.precedence!, y.ts.precedence!) ? -1 : 1));
}

function goesBefore(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

function booked(schedule: Schedule, memo: LateCauses): Booked {
  if (!memo.booked) {
    const byDay = new Map<string, Map<DayNumber, Allocation[]>>();
    const byTask = new Map<Task, Allocation[]>();
    for (const a of schedule.allocations) {
      let days = byDay.get(a.resource);
      if (!days) byDay.set(a.resource, (days = new Map()));
      const work = days.get(a.day);
      if (work) work.push(a);
      else days.set(a.day, [a]);
      const mine = byTask.get(a.task);
      if (mine) mine.push(a);
      else byTask.set(a.task, [a]);
    }
    const byResource = new Map<string, TaskSchedule[]>();
    for (const ts of schedule.tasks.values()) {
      const tasks = byResource.get(ts.resource);
      if (tasks) tasks.push(ts);
      else byResource.set(ts.resource, [ts]);
    }
    memo.booked = { byDay, byTask, byResource };
  }
  return memo.booked;
}

/**
 * The hours of its owner's `day` that the work the task waits for took: the tasks of the same
 * owner it waits for that finish that day, and the ones they wait for in turn, each counted once
 * (a parent and its subtask may both wait for the same task).
 */
function handedOver(
  schedule: Schedule,
  memo: LateCauses,
  ts: TaskSchedule,
  day: DayNumber
): number {
  const work = new Set<TaskSchedule>();
  for (const p of sameDayBefore(schedule, ts, day))
    for (const w of sameDayWork(schedule, memo, p)) work.add(w);
  const hours = lastDayHours(schedule, memo);
  let taken = 0;
  for (const w of work) taken += hours.get(w.task) ?? 0;
  return taken;
}

/** The tasks of the same owner that the task waits for and that finish on `day`. */
function sameDayBefore(schedule: Schedule, ts: TaskSchedule, day: DayNumber): TaskSchedule[] {
  const before: TaskSchedule[] = [];
  for (const r of schedule.graph.requirements.get(ts.task) ?? []) {
    const p = r.node.kind === "leaf" ? schedule.tasks.get(r.node.task) : undefined;
    if (p?.resource === ts.resource && p.finish === day) before.push(p);
  }
  return before;
}

/**
 * The task and the work before it on the day it finished (`sameDayBefore`, in turn): only those
 * with hours that day. Worked out once per task, so a long chain of steps without hours that
 * finish on one day costs its length, not its square.
 */
function sameDayWork(schedule: Schedule, memo: LateCauses, ts: TaskSchedule): TaskSchedule[] {
  const known = memo.sameDay.get(ts);
  if (known) return known;
  const hours = lastDayHours(schedule, memo);
  // Iterative depth-first walk: a task is worked out once the tasks before it are.
  const stack = [{ ts, parts: sameDayBefore(schedule, ts, ts.finish!), i: 0 }];
  const onPath = new Set<TaskSchedule>([ts]);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.i < frame.parts.length) {
      const p = frame.parts[frame.i++];
      if (!memo.sameDay.has(p) && !onPath.has(p)) {
        onPath.add(p);
        stack.push({ ts: p, parts: sameDayBefore(schedule, p, p.finish!), i: 0 });
      }
      continue;
    }
    stack.pop();
    onPath.delete(frame.ts);
    const work = new Set<TaskSchedule>((hours.get(frame.ts.task) ?? 0) > 0 ? [frame.ts] : []);
    for (const p of frame.parts) for (const w of memo.sameDay.get(p) ?? []) work.add(w);
    memo.sameDay.set(frame.ts, [...work]);
  }
  return memo.sameDay.get(ts)!;
}

/** The hours each task got on the day it finished. */
function lastDayHours(schedule: Schedule, memo: LateCauses): Map<Task, number> {
  if (!memo.lastDayHours) {
    const hours = new Map<Task, number>();
    for (const a of schedule.allocations)
      if (a.day === schedule.tasks.get(a.task)?.finish)
        hours.set(a.task, (hours.get(a.task) ?? 0) + a.hours);
    memo.lastDayHours = hours;
  }
  return memo.lastDayHours;
}

/** "Held back by the fixed start 2027-10-19 of T462 (via M1 → T411)." */
export function describeLateCause(plan: Plan, task: Task, cause: LateCause): string {
  const name = (t: Task) => t.id ?? `"${t.title}"`;
  let root: string;
  if (cause.kind === "start") {
    const date = cause.day !== undefined ? formatDate(cause.day) : (cause.task.start ?? "");
    root =
      cause.task === task
        ? `its own fixed start ${date}`
        : `the fixed start ${date} of ${name(cause.task)}`;
  } else {
    const r = cause.resource ?? "";
    const who = r === "unassigned" ? "the unassigned pool" : (plan.personById(r)?.name ?? r);
    root =
      cause.task === task
        ? `${who} having other work first`
        : `${who} having other work before ${name(cause.task)}`;
  }
  const shown = cause.via.slice(0, 3).join(" → ") + (cause.via.length > 3 ? " → …" : "");
  return `Held back by ${root}${cause.via.length ? ` (via ${shown})` : ""}.`;
}

/** The nearest task that cannot be scheduled by itself, and how many steps away it is. */
interface Nearest {
  root: Task;
  steps: number;
}

interface UnscheduledCauses {
  plan: Plan;
  causes: Map<Task, string | undefined>;
  nearest: Map<DepNode, Nearest | null>;
}

const unscheduledCauses = new WeakMap<Schedule, UnscheduledCauses>();

/**
 * Why a task has no dates, in words: "Jordan has no working hours from 2026-12-24 on
 * (capacityFrom: 2026-12-24 0h/week)", or for the tasks behind it "it waits for T422, which
 * cannot be scheduled because Jordan has …". Undefined when the task is scheduled.
 */
export function unscheduledCause(plan: Plan, schedule: Schedule, task: Task): string | undefined {
  let memo = unscheduledCauses.get(schedule);
  if (!memo || memo.plan !== plan) {
    memo = { plan, causes: new Map(), nearest: new Map() };
    unscheduledCauses.set(schedule, memo);
  }
  if (!memo.causes.has(task)) memo.causes.set(task, findUnscheduledCause(memo, schedule, task));
  return memo.causes.get(task);
}

function findUnscheduledCause(
  memo: UnscheduledCauses,
  schedule: Schedule,
  task: Task
): string | undefined {
  const ts = schedule.tasks.get(task);
  switch (ts?.unscheduled) {
    case undefined:
      return undefined;
    case "cycle":
      return "it is part of a circular dependency";
    case "blocked-by-cycle":
      return "it depends on tasks in a circular dependency";
    case "horizon":
      return noCapacity(memo.plan, schedule, task);
    case "waits-for-unscheduled": {
      const root = unscheduledRoot(schedule, task, memo.nearest);
      if (!root) return "it waits for a task that cannot be scheduled";
      const why = unscheduledCause(memo.plan, schedule, root);
      return `it waits for ${root.id ?? `"${root.title}"`}, which cannot be scheduled${why ? ` because ${why}` : ""}`;
    }
  }
}

/**
 * The nearest task this one (transitively) waits for that cannot be scheduled by itself: fewest
 * steps, then first in the order of the dependencies. Every task and group is worked out once per
 * schedule, so the tasks behind an unschedulable one cost the size of the graph together.
 */
function unscheduledRoot(
  schedule: Schedule,
  task: Task,
  nearest: Map<DepNode, Nearest | null>
): Task | undefined {
  const { graph } = schedule;
  const reason = (t: Task) => schedule.tasks.get(t)?.unscheduled;
  const isRoot = (t: Task) => reason(t) === "horizon" || reason(t) === "cycle";
  // What a node waits for: a waiting task its requirements, a group its tasks.
  const below = (n: DepNode): DepNode[] =>
    n.kind === "group"
      ? n.members.map((m) => graph.leafNode.get(m)!)
      : reason(n.task) && !isRoot(n.task)
        ? (graph.requirements.get(n.task) ?? []).map((r) => r.node)
        : [];
  const resolve = (n: DepNode, parts: DepNode[]): Nearest | null => {
    if (n.kind === "leaf" && isRoot(n.task)) return { root: n.task, steps: 0 };
    const step = n.kind === "leaf" ? 1 : 0;
    let best: Nearest | null = null;
    for (const p of parts) {
      const found = nearest.get(p);
      if (found && (!best || found.steps + step < best.steps))
        best = { root: found.root, steps: found.steps + step };
    }
    return best;
  };
  const node = graph.leafNode.get(task);
  if (!node) return undefined;
  // Iterative depth-first walk: a node is resolved once everything it waits for is.
  const stack: Array<{ node: DepNode; parts: DepNode[]; i: number }> = [
    { node, parts: below(node), i: 0 },
  ];
  const onPath = new Set<DepNode>([node]);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.i < frame.parts.length) {
      const p = frame.parts[frame.i++];
      if (!nearest.has(p) && !onPath.has(p)) {
        onPath.add(p);
        stack.push({ node: p, parts: below(p), i: 0 });
      }
      continue;
    }
    stack.pop();
    onPath.delete(frame.node);
    nearest.set(frame.node, resolve(frame.node, frame.parts));
  }
  return nearest.get(node)?.root;
}

/** "Jordan has no working hours from 2026-12-24 on (capacityFrom: 2026-12-24 0h/week)". */
function noCapacity(plan: Plan, schedule: Schedule, task: Task): string {
  const ts = schedule.tasks.get(task)!;
  const resource = ts.resource;
  if (resource === "unassigned") return "the unassigned pool has no capacity for it";
  const person = plan.personById(resource);
  const who = person?.name ?? resource;
  const from = ts.earliest ?? schedule.start;
  if (schedule.calendar.nextWorkdayOf(resource, from, 3650) !== undefined)
    return `${who} has no capacity for it`;
  // No hours at all from the day it could start: say since when, and why if a capacity change did it.
  const change = person?.capacityChanges
    .filter((c) => c.hours === 0 && c.from <= from)
    .sort((a, b) => b.from - a.from)[0];
  const since = formatDate(change?.from ?? from);
  return `${who} has no working hours from ${since} on${change ? ` (capacityFrom: ${since} 0h/${change.per})` : ""}`;
}
