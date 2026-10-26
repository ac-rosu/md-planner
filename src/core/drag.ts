// What a Gantt drag does to the schedule, worked out before anything is written: the estimate that
// makes a bar end on the day it was dropped, the other tasks that move with it, and why a bar
// starts later than where it was dropped.
import { UNASSIGNED } from "./calendar";
import { type DayNumber, formatDate, isoWeekday } from "./dates";
import { formatHours } from "./duration";
import { type DepNode } from "./graph";
import { PlanIndex } from "./index";
import { unscheduledCause } from "./lateCause";
import { type Task } from "./model";
import { type Plan } from "./resolve";
import { budgetSplit, startedOn } from "./rollup";
import { type Schedule, schedulePlan, type ScheduleOptions, type TaskSchedule } from "./scheduler";
import { applyEdits } from "./text";
import { type FileEdit, setAttr } from "./writer";

const EPS = 1e-6;

/** An estimated parent whose `@est` changes with a resized subtask, and its new estimate. */
export interface ParentEstimate {
  task: Task;
  est: number;
}

/** A resize worked out: the estimate to write and the schedule after it, or why there is none. */
export type Resize =
  | {
      /** The task's new estimate in hours (whole half hours). */
      est: number;
      /** Parents whose `@est` changes with it (see parentEstimates). */
      parents: ParentEstimate[];
      /** The `@est` edits, all in the task's file. */
      edits: FileEdit[];
      /** The schedule of the plan as it will be after the edits. */
      schedule: Schedule;
    }
  | {
      /**
       * Why nothing is written: more work does not end the bar any later, or it does not end by
       * that day with only the work it gets by then.
       */
      why: string;
    };

/** Schedules a resize may try: one usually, two when other work comes first. */
const RESIZE_TRIES = 4;

/**
 * Drag the end of a bar: the largest estimate (in half hours) with which `task` ends on `finish`,
 * or as close before it as possible, next to the owner's other work and time off and after what it
 * waits for. More work does not always end later: it changes what goes first (what this task waits
 * for is more urgent when it has more work, so the task can start earlier, or later), so nothing
 * here assumes it, and every estimate is checked by scheduling the plan as it will be written. The
 * first try comes from the current schedule: a shorter bar keeps the hours it has by that day; a
 * longer one gets the rest of its last day and every hour of the owner after it, as if it went
 * before their other work. After a try that ends in time, the next one adds the hours left after
 * it up to that day; after one that ends too late, the next one is what it got by then, or half
 * way when it started on another day than the one that fit. So the search stays near the current
 * schedule: an estimate that only fits because it moves the start by days is not looked for. When
 * a shorter bar does not end by that day with only the work it gets there, the notice says what
 * happens then ("it waits longer for T1"), not that no estimate could: another may start it earlier.
 */
export function resizeTo(
  plan: Plan,
  options: ScheduleOptions,
  current: Schedule,
  task: Task,
  finish: DayNumber
): Resize {
  const name = task.id ?? task.title;
  // Its hours per day come from allocations, which carry its id: another task's would count too.
  const shared = sharedIdReason(plan, task);
  if (shared) return { why: shared };
  const ts = current.tasks.get(task);
  if (!ts || ts.start === undefined || ts.finish === undefined)
    return { why: `${name} has no scheduled dates to resize.` };
  const progress = task.progress;
  if (progress !== undefined && progress >= 1)
    return { why: `${name} is at 100% (@progress): whatever its estimate, no work is left.` };
  const cal = current.calendar;
  const key = ts.key;
  const from = cal.nextWorkingDay(Math.max(ts.start, current.start));
  const day = Math.max(from, finish);
  const act = task.act ?? 0;
  const remainingOf = (est: number) =>
    progress !== undefined ? est * (1 - progress) : Math.max(0, est - act);
  /** The largest estimate in half hours that leaves at most `hours` of work. */
  const estimateFor = (hours: number) =>
    Math.floor((progress !== undefined ? hours / (1 - progress) : hours + act) * 2 + EPS) / 2;
  interface Try {
    est: number;
    schedule: Schedule;
    parents: ParentEstimate[];
    edits: FileEdit[];
    /** The task's hours per day. */
    work: Map<DayNumber, number>;
    /** The first day with work on it. */
    first?: DayNumber;
  }
  const tryOf = (
    est: number,
    schedule: Schedule,
    parents: ParentEstimate[] = [],
    edits: FileEdit[] = []
  ): Try => {
    const work = new Map<DayNumber, number>();
    for (const a of schedule.allocations)
      if (a.key === key) work.set(a.day, (work.get(a.day) ?? 0) + a.hours);
    const first = work.size ? Math.min(...work.keys()) : schedule.byKey.get(key)?.start;
    return { est, schedule, parents, edits, work, first };
  };
  /** The task's hours up to the day. */
  const hoursBy = (t: Try) => {
    let hours = 0;
    for (const [d, h] of t.work) if (d <= day) hours += h;
    return hours;
  };
  // The most it got on a day while it still had work left after it: all it can get there (other
  // work came first), where the owner's capacity is only an upper bound.
  const most = new Map<DayNumber, number>();
  const observe = (t: Try) => {
    const end = Math.min(t.schedule.byKey.get(key)?.finish ?? Number.POSITIVE_INFINITY, day + 1);
    for (let d = t.first ?? end; d < end; d++)
      most.set(d, Math.max(most.get(d) ?? 0, t.work.get(d) ?? 0));
  };
  /** The hours it could still get after ending on `end`, up to the day. */
  const roomAfter = (t: Try, end: DayNumber) => {
    let hours = 0;
    for (let d = end; d <= day; d++)
      hours += Math.max(0, (most.get(d) ?? cal.capacity(ts.resource, d)) - (t.work.get(d) ?? 0));
    return hours;
  };
  // The largest estimate known to end in time (a longer bar: the current one), and the smallest
  // known to end too late.
  const now = tryOf(task.est ?? task.budget ?? 0, current);
  observe(now);
  let fit = ts.finish <= day ? now : undefined;
  let late: Try | undefined;
  // A shorter bar is tried first with only the work it gets by that day.
  let byThen: Try | undefined;
  let next = estimateFor(hoursBy(now) + (fit ? roomAfter(now, ts.finish) : 0));
  for (let tries = 0; tries < RESIZE_TRIES; tries++) {
    const above = fit?.est ?? 0;
    const below = late?.est ?? Number.POSITIVE_INFINITY;
    if (next <= above + EPS || next >= below - EPS) {
      // What it got is no guide when it started on another day with more work: try half way.
      if (fit && late && below - above > 0.5 && late.first !== fit.first)
        next = Math.floor(above + below) / 2;
      else break;
    }
    if (remainingOf(next) <= EPS) break;
    const parents = parentEstimates(task, next);
    const edits = estimateEdits(plan, task, next, parents);
    const tried = tryOf(next, scheduleAfter(plan, options, edits), parents, edits);
    byThen ??= tried;
    observe(tried);
    const end = tried.schedule.byKey.get(key)?.finish;
    if (end !== undefined && end <= day) {
      fit = tried;
      next = estimateFor(remainingOf(next) + roomAfter(tried, end));
    } else {
      late = tried;
      next = estimateFor(hoursBy(tried));
    }
  }
  if (fit?.edits.length)
    return { est: fit.est, parents: fit.parents, edits: fit.edits, schedule: fit.schedule };
  if (fit) {
    if (day <= ts.finish) return { why: `${name} already ends ${dragDay(ts.finish)}.` };
    const why = waitReason(plan, current, ts, ts.finish + 1, day + 1);
    return { why: `${name} still ends ${dragDay(ts.finish)}: ${why}.` };
  }
  if (!byThen) {
    // Nothing to try: as it is now, it gets no work by then (or less than half an hour), or it has
    // none left and ends when what it waits for is done.
    const until = now.work.size ? now.first : ts.finish;
    if (until !== undefined && until > day) {
      const why = waitReason(plan, current, ts, from, until);
      const what = !now.work.size ? "ends" : startedOn(task) ? "continues" : "starts";
      return {
        why: `${name} cannot end by ${dragDay(day)}: ${why}, so it ${what} ${dragDay(until)}.`,
      };
    }
    return {
      why: `${name} cannot end by ${dragDay(day)}: it gets only ${formatHours(hoursBy(now))} of work by then.`,
    };
  }
  // With only the work it gets by that day, it ends later. That is not written, so the notice says
  // what happens then, from where the bar starts now, and not where it would start or that no
  // estimate ends it there: another one may, with an earlier start.
  const bts = byThen.schedule.byKey.get(key);
  let why: string;
  if (bts?.unscheduled) {
    const cause = unscheduledCause(plan, byThen.schedule, bts.task);
    why = `it cannot be scheduled${cause ? `, as ${cause}` : ""}`;
  } else if (bts && byThen.first !== undefined && byThen.first > day && now.first !== undefined)
    why = waitReason(plan, byThen.schedule, bts, now.first, byThen.first, current);
  else why = `it gets only ${formatHours(hoursBy(byThen))} of work by that day`;
  return {
    why: `${name} cannot end by ${dragDay(day)} with only the work it gets by that day: then ${why}.`,
  };
}

/**
 * Why a bar cannot be changed from the Gantt: another task has its id. The Gantt and the schedule
 * know a task by its id, so the change could be meant for the other bar, or a resize be measured
 * on the other task.
 */
export function sharedIdReason(plan: Plan, task: Task): string | undefined {
  if (task.id === undefined) return undefined;
  const n = plan.tasks.filter((t) => t.id === task.id).length;
  return n > 1 ? `${n} tasks have the id ${task.id}: give each its own id first.` : undefined;
}

/**
 * The estimated parents whose `@est` changes when `task`'s estimate becomes `est`. A parent's
 * `@est` is the budget of its subtasks: those without an estimate share what the others leave
 * (assignBudgets). So the nearest estimated parent changes by as much as the task when the task's
 * hours are such a share (the budget follows the task), or when its new estimate would change the
 * share of the others; then the same for that parent's own estimated parent, and so on. The other
 * subtasks keep their hours, and the bar ends where it was dropped.
 */
export function parentEstimates(task: Task, est: number): ParentEstimate[] {
  const out: ParentEstimate[] = [];
  let node = task;
  // The node's own estimate before and after (a task without one is not counted as estimated).
  let before = task.est;
  let after = est;
  for (let p = task.parent; p; p = p.parent) {
    if (p.est === undefined) continue;
    const { estimated, logged, unestimated } = budgetSplit(p);
    const others = unestimated.filter((u) => u !== node);
    const share = unestimated.length
      ? Math.max(0, (p.est - estimated - logged) / unestimated.length)
      : 0;
    const used = estimated - (before ?? 0) + after + logged;
    let next: number | undefined;
    if (others.length && share > 0) next = used + share * others.length;
    // They had nothing left to share: they keep nothing.
    else if (others.length) next = p.est - used > EPS ? used : undefined;
    // The task's hours were all that was left of it.
    else if (node === task && task.est === undefined && task.budget !== undefined) next = used;
    if (next === undefined) break;
    next = Math.round(next * 100) / 100; // as written (formatHours)
    if (Math.abs(next - p.est) < EPS) break;
    out.push({ task: p, est: next });
    node = p;
    before = p.est;
    after = next;
  }
  return out;
}

function estimateEdits(plan: Plan, task: Task, est: number, parents: ParentEstimate[]): FileEdit[] {
  const file = plan.file(task.file);
  if (!file) throw new Error(`File not loaded: ${task.file}`);
  const edits = [{ task, est }, ...parents].flatMap((x) =>
    setAttr(file.lines, x.task, "est", formatHours(x.est))
  );
  return edits.length ? [{ path: task.file, edits }] : [];
}

/**
 * The schedule of the plan as it will be after `edits`: every file parsed again, the edited ones
 * from the edited text, so budgets and everything else come out exactly as they will be written.
 */
export function scheduleAfter(plan: Plan, options: ScheduleOptions, edits: FileEdit[]): Schedule {
  const index = new PlanIndex();
  for (const f of plan.files) {
    const own = edits.filter((e) => e.path === f.path).flatMap((e) => e.edits);
    const text = f.lines.serialize();
    index.update(f.path, own.length ? applyEdits(text, own) : text);
  }
  return schedulePlan(index.plan, { ...options, whatIf: undefined });
}

/**
 * Why a task gets no work from `from` until `until` (exclusive) in a schedule, for drag notices:
 * "it waits for T3", "M2 waits for M1 to finish", "its parent T9 has the fixed start 2026-11-05",
 * "nothing is scheduled before today", "Sam has no working hours from Tue 2026-11-17 to Sun
 * 2026-11-22" or "Sam's other work comes first", and what follows until then: "it waits for T3,
 * then Sam's other work comes first". With `before`, the schedule as it is now, `s` is that of a
 * change (less work for the task): "it waits longer for T3, as Priya's other work comes first".
 */
export function waitReason(
  plan: Plan,
  s: Schedule,
  ts: TaskSchedule,
  from: DayNumber,
  until: DayNumber,
  before?: Schedule
): string {
  const reasons: string[] = [];
  let at = from;
  const d = ts.driver;
  if (d && ts.earliest !== undefined && ts.earliest > from) {
    if (d.kind === "start") {
      const date = d.from.start ?? formatDate(ts.earliest);
      reasons.push(
        d.from === ts.task
          ? `its fixed start is ${date}`
          : `${d.from === ts.task.parent ? "its parent " : ""}${taskName(d.from)} has the fixed start ${date}`
      );
    } else {
      // With less work, what it waits for is less urgent, so it goes after someone's other work.
      const longer = before ? " longer" : "";
      const held = before && s.tasks.get(heldBack(before, s, d.on));
      const as = held ? `, as ${otherWork(plan, held.resource)} comes first` : "";
      reasons.push(
        typeof d.declaredBy === "string"
          ? `${d.declaredBy} waits${longer} for ${d.on.milestoneId ?? taskName(d.on)} to finish${as}`
          : `it waits${longer} for ${taskName(d.on)}${as}`
      );
    }
    // The same person's last day on what it waits for, and the weekend after it, go without saying.
    const on = d.kind === "dep" ? s.tasks.get(d.on) : undefined;
    const sameDay = on?.finish === ts.earliest && on.resource === ts.resource;
    at = s.calendar.nextWorkingDay(ts.earliest + (sameDay ? 1 : 0));
  } else if (from < s.start) {
    // Open work starts on the first day of the schedule at the earliest.
    reasons.push(
      `nothing is scheduled before ${s.start === s.today ? "today" : "the project start"}`
    );
    at = s.calendar.nextWorkingDay(s.start);
  }
  const unassigned = ts.resource === UNASSIGNED;
  const who = unassigned ? "" : (plan.personById(ts.resource)?.name ?? ts.resource);
  let open = at;
  while (open < until && s.calendar.capacity(ts.resource, open) <= EPS) open++;
  if (open > at)
    reasons.push(
      `${unassigned ? "there are" : `${who} has`} no working hours ${open - 1 === at ? `on ${dragDay(at)}` : `from ${dragDay(at)} to ${dragDay(open - 1)}`}`
    );
  if (open < until)
    reasons.push(
      open > at ? "other work comes first" : `${otherWork(plan, ts.resource)} comes first`
    );
  return reasons.join(", then ");
}

/**
 * Where a later finish of `task` in `after` comes from: the task itself, or what it waits for
 * when that keeps it from starting where it started in `before`, and so on back. That task's owner
 * does other work first. Tasks are matched by line: `after` may be of the plan parsed again.
 */
function heldBack(before: Schedule, after: Schedule, task: Task): Task {
  const was = byLine(before);
  const seen = new Set<Task>();
  let t = task;
  for (;;) {
    seen.add(t);
    const a = after.tasks.get(t);
    const d = a?.driver;
    if (d?.kind !== "dep" || seen.has(d.on) || a?.earliest === undefined) return t;
    const b = was.get(lineOf(t));
    const first = b && firstWorkDay(before, b);
    if (first === undefined || a.earliest <= first) return t;
    t = d.on;
  }
}

/** The first day with work on the task (the start of a task in progress is its `@started`). */
function firstWorkDay(s: Schedule, ts: TaskSchedule): DayNumber | undefined {
  let first: DayNumber | undefined;
  for (const a of s.allocations)
    if (a.key === ts.key && (first === undefined || a.day < first)) first = a.day;
  return first ?? ts.start;
}

/** "Sam's other work", or "other unassigned work". */
function otherWork(plan: Plan, resource: string): string {
  return resource === UNASSIGNED
    ? "other unassigned work"
    : `${plan.personById(resource)?.name ?? resource}'s other work`;
}

/**
 * The notice after dragging a bar to `dropped`, written as the fixed start `start` (the working day
 * on or after it): where the bar starts and ends after the move, why it starts later than that,
 * and what else moves. "T1: fixed start none → 2026-11-02. It waits for T3, so it starts Thu
 * 2026-11-05. Ends Fri 2026-11-06. Also moves …". When the task already has that fixed start,
 * says so (nothing is written).
 */
export function describeMove(
  plan: Plan,
  before: Schedule,
  after: Schedule,
  task: Task,
  dropped: DayNumber,
  start: DayNumber
): string {
  const name = task.id ?? task.title;
  const date = formatDate(start);
  const now = after.tasks.get(task);
  const later =
    now?.start !== undefined && now.start > start
      ? ` ${capitalize(waitReason(plan, after, now, start, now.start))}, so it starts ${dragDay(now.start)}.`
      : "";
  if (task.start === date)
    return `${name} already has the fixed start ${date}${dropped < start ? ` (${dragDay(dropped)} is not a working day)` : ""}.${later}`;
  let what = `${name}: fixed start ${task.start ?? "none"} → ${date}.`;
  if (now?.unscheduled) {
    const why = unscheduledCause(plan, after, task);
    what += ` It cannot be scheduled${why ? `: ${why}` : ""}.`;
  } else if (later) what += later;
  else if (!task.start)
    // Dragging pins the task; say so the first time, as it stays when the plan changes.
    what += ` It is now pinned: it starts no earlier than that, even when its dependencies finish sooner (right-click → Remove fixed start).`;
  if (now?.finish !== undefined) what += ` Ends ${dragDay(now.finish)}.`;
  return `${what} ${describeMoved(plan, before, task, movedTasks(before, after, task))}`.trim();
}

/**
 * The notice after a resize: the new estimate and end, the parents whose estimate changes with it,
 * and what else moves. "T3: estimate 20h → 12h, ends Thu 2026-10-08. T1: estimate 40h → 32h, so
 * T2 keeps its hours."
 */
export function describeResize(
  plan: Plan,
  before: Schedule,
  task: Task,
  r: Extract<Resize, { est: number }>
): string {
  const name = task.id ?? task.title;
  const estText = (t: Task) =>
    t.attrs.find((a) => a.key === "est")?.value ??
    (t.budget !== undefined ? formatHours(t.budget) : "none");
  const was = before.tasks.get(task);
  const now = byLine(r.schedule).get(lineOf(task));
  // With more work, what it waits for can become more urgent, and the bar start earlier.
  const starts =
    now?.start !== undefined && now.start !== was?.start ? `, starts ${dragDay(now.start)}` : "";
  const ends = now?.finish !== undefined ? `, ends ${dragDay(now.finish)}` : "";
  let text = `${name}: estimate ${estText(task)} → ${formatHours(r.est)}${starts}${ends}.`;
  if (r.parents.length) {
    const changes = list(
      r.parents.map(
        (p) => `${taskName(p.task)}: estimate ${estText(p.task)} → ${formatHours(p.est)}`
      )
    );
    const keep = r.parents.flatMap((p) =>
      budgetSplit(p.task).unestimated.filter((u) => u !== task && u.budget !== undefined)
    );
    // Without others that share it, the task had what was left of the parent's estimate.
    text += keep.length
      ? ` ${changes}, so ${list(keep.map(taskName))} ${keep.length === 1 ? "keeps its" : "keep their"} hours.`
      : ` ${changes}, so its subtasks still add up to it.`;
  }
  return `${text} ${describeMoved(plan, before, task, movedTasks(before, r.schedule, task))}`.trim();
}

export interface MovedTask {
  task: Task;
  /** Working days the finish (or, when only the start moved, the start) moved: + later, − earlier. */
  days: number;
}

/**
 * The scheduled tasks other than `except` whose dates differ between two schedules, matched by
 * file and line (the schedule after a change may come from the plan parsed again).
 */
export function movedTasks(before: Schedule, after: Schedule, except: Task): MovedTask[] {
  const cal = before.calendar;
  const out: MovedTask[] = [];
  const now = byLine(after);
  for (const [task, a] of before.tasks) {
    if (task === except || a.done) continue;
    const b = now.get(lineOf(task));
    if (!b || (a.start === b.start && a.finish === b.finish)) continue;
    const shift = (x?: DayNumber, y?: DayNumber) =>
      x === undefined || y === undefined ? 0 : cal.workingDaysBetween(x, y);
    const days = shift(a.finish, b.finish) || shift(a.start, b.start);
    out.push({ task, days });
  }
  return out.sort((x, y) => Math.abs(y.days) - Math.abs(x.days) || x.task.order - y.task.order);
}

/**
 * Why a task moved when another one was dragged: it waits for it (task dependencies), it is the
 * same person's other work (time freed, or taken by the pinned task), its milestone waits for the
 * dragged task's milestone (`depends:`), or it waits for one of those (knock-on).
 */
export type MoveReason = "waits" | "person" | "milestone" | "knock-on";

export function moveReasons(
  before: Schedule,
  dragged: Task,
  moved: MovedTask[]
): Map<Task, MoveReason> {
  const graph = before.graph;
  const groupsOf = new Map<Task, DepNode[]>();
  for (const g of graph.groups.values())
    for (const m of g.members) groupsOf.set(m, [...(groupsOf.get(m) ?? []), g]);
  /** Leaves that wait for `from`, transitively; through milestone `depends:` too, or not. */
  const waiting = (from: Task, milestones: boolean): Set<Task> => {
    const out = new Set<Task>();
    const seen = new Set<DepNode>();
    const queue = [from];
    for (let i = 0; i < queue.length; i++) {
      const t = queue[i];
      const leaf = graph.leafNode.get(t);
      const nodes: DepNode[] = [...(leaf ? [leaf] : []), ...(groupsOf.get(t) ?? [])];
      for (const n of nodes) {
        if (!milestones && n.kind === "group" && n.key.startsWith("milestone:")) continue;
        if (seen.has(n)) continue;
        seen.add(n);
        for (const d of graph.dependents.get(n) ?? [])
          if (!out.has(d)) {
            out.add(d);
            queue.push(d);
          }
      }
    }
    return out;
  };
  const direct = waiting(dragged, false);
  const viaMilestones = waiting(dragged, true);
  const owner = before.tasks.get(dragged)?.resource;
  const reasons = new Map<Task, MoveReason>();
  for (const m of moved) {
    if (direct.has(m.task)) reasons.set(m.task, "waits");
    else if (before.tasks.get(m.task)?.resource === owner) reasons.set(m.task, "person");
    else if (viaMilestones.has(m.task)) reasons.set(m.task, "milestone");
    else reasons.set(m.task, "knock-on");
  }
  return reasons;
}

/**
 * The other tasks a drag moves, by reason, for the notice: "Also moves T430 (+2 d), which waits
 * for it; Sam's other work: T515 (−5 d) and T516 (−5 d); 25 tasks of M2–M5, which wait for M1 to
 * finish; 3 more after those." Empty when nothing else moves.
 */
export function describeMoved(
  plan: Plan,
  before: Schedule,
  dragged: Task,
  moved: MovedTask[]
): string {
  if (moved.length === 0) return "";
  const reasons = moveReasons(before, dragged, moved);
  const of = (r: MoveReason) => moved.filter((m) => reasons.get(m.task) === r);
  const name = (m: MovedTask) => {
    const id = taskName(m.task);
    return m.days === 0 ? id : `${id} (${m.days > 0 ? "+" : "−"}${Math.abs(m.days)} d)`;
  };
  const parts: string[] = [];
  const waits = of("waits");
  if (waits.length)
    parts.push(`${list(waits.map(name))}, which ${waits.length === 1 ? "waits" : "wait"} for it`);
  const person = of("person");
  if (person.length)
    parts.push(
      `${otherWork(plan, before.tasks.get(dragged)!.resource)}: ${list(person.map(name))}`
    );
  const milestone = of("milestone");
  if (milestone.length) {
    const ids = [...new Set(milestone.map((m) => m.task.milestoneId ?? "?"))].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true })
    );
    const which =
      ids.length === 1
        ? ids[0]
        : ids.length === 2
          ? `${ids[0]} and ${ids[1]}`
          : `${ids[0]}–${ids[ids.length - 1]}`;
    const what =
      milestone.length <= 3
        ? `${list(milestone.map(name))} of ${which}`
        : `${milestone.length} tasks of ${which}`;
    parts.push(
      `${what}, which ${ids.length === 1 ? "waits" : "wait"} for ${dragged.milestoneId} to finish`
    );
  }
  const knockOn = of("knock-on").length;
  if (knockOn) parts.push(`${knockOn} more after those`);
  return `Also moves ${parts.join("; ")}.`;
}

/**
 * A schedule's tasks by file and line. A drag's edits leave every task on its line, so this finds
 * them in the schedule of the plan parsed again after the edits, also when two tasks share an id.
 */
function byLine(s: Schedule): Map<string, TaskSchedule> {
  const out = new Map<string, TaskSchedule>();
  for (const ts of s.tasks.values()) out.set(lineOf(ts.task), ts);
  return out;
}

function lineOf(t: Task): string {
  return `${t.file}#${t.line}`;
}

/** A task in notices: its id, or its title in quotes. */
function taskName(t: Task): string {
  return t.id ?? `"${t.title}"`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "T1", "T1 and T2", "T1, T2, T3 and 4 more". */
function list(names: string[], shown = 3): string {
  const head = names.slice(0, shown);
  const more = names.length - head.length;
  if (more > 0) return `${head.join(", ")} and ${more} more`;
  if (head.length === 1) return head[0];
  return `${head.slice(0, -1).join(", ")} and ${head[head.length - 1]}`;
}

/** "Fri 2026-11-27" for drag notices: the weekday matters when dragging around weekends. */
export function dragDay(day: DayNumber): string {
  const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][isoWeekday(day) - 1];
  return `${wd} ${formatDate(day)}`;
}
