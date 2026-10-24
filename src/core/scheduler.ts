// Deterministic resource-constrained list scheduler. Same plan + same options (including `today`)
// → same schedule. Works on leaf tasks; parents, sections and milestones roll up.
//
//  1. Dependency graph of leaf tasks (parent dependency = all its leaves, milestone `depends`).
//     Cycles are rejected and left unscheduled.
//  2. Done tasks are fixed at @started → @done; cancelled tasks are ignored.
//  3. Walk days from max(today, project start). Per person, tasks are ready when their
//     dependencies have finished (plus lag) and their @start has been reached.
//  4. Ready tasks are ordered: fixed @start first, then @prio, then least slack against @due or
//     milestone target, then file order.
//  5. The person's free hours of the day go to tasks in that order; tasks span days and share days.
//  6. A task finishes on the day its remaining hours reach 0.
//  7. Per task start/finish and per person-day allocations are recorded.
import { Calendar, type CalendarOptions, UNASSIGNED } from "./calendar";
import { type DayNumber, formatDate, parseDate } from "./dates";
import { buildDepGraph, type DepGraph, type DepNode } from "./graph";
import { isOpen, type Milestone, PRIORITY_RANK, type Section, type Task } from "./model";
import { deadlineOf } from "./queries";
import { type Plan } from "./resolve";
import {
  estimateHours,
  isEffectivelyCancelled,
  isEffectivelyDone,
  isLeaf,
  leavesOf,
  ownerOf,
  progressOf,
  remainingHours,
  startedOn,
} from "./rollup";

export type ScheduleMode = "capacity" | "demand";

export interface ScheduleOptions extends Partial<CalendarOptions> {
  /** ISO date; the schedule never places open work before it. */
  today: string;
  /** capacity: resource-constrained (default); demand: ASAP ignoring capacity (raw overload). */
  mode?: ScheduleMode;
  /** Calendar days simulated after the start before giving up (default 10 years). */
  horizonDays?: number;
}

/**
 * Why a task has no dates: a dependency cycle, waiting on one, no capacity for it (`horizon`), or
 * waiting for a task that itself cannot be scheduled.
 */
export type UnscheduledReason = "cycle" | "blocked-by-cycle" | "horizon" | "waits-for-unscheduled";

export interface TaskSchedule {
  task: Task;
  key: string;
  /** Lower-case person id or `unassigned`. */
  resource: string;
  /** First day with work (or @started for tasks already in progress, @started for done tasks). */
  start?: DayNumber;
  /** Day on which the remaining work reaches 0 (or @done). */
  finish?: DayNumber;
  /** Remaining hours that were scheduled from today. */
  scheduledHours: number;
  done: boolean;
  unscheduled?: UnscheduledReason;
  /** Earliest day the task could start (dependencies + @start), before resource limits. */
  earliest?: DayNumber;
  /** What set `earliest`: the latest-finishing predecessor or the fixed start (none: today). */
  driver?: StartDriver;
  deadline?: DayNumber;
  /** Finish after the deadline (@due, inherited @due or milestone target). */
  late: boolean;
  /** Total slack in working days (CPM); negative when late. */
  slack?: number;
  critical: boolean;
  unassigned: boolean;
  unknownOwner: boolean;
  unestimated: boolean;
}

export type StartDriver =
  /** Waited for `on` (a leaf), through the dependency declared by a task or a milestone. */
  | { kind: "dep"; on: Task; declaredBy: Task | string }
  /** The `@start` of `from` (the task itself or an ancestor). */
  | { kind: "start"; from: Task };

export interface Allocation {
  key: string;
  resource: string;
  day: DayNumber;
  hours: number;
}

export interface RollUp {
  start?: DayNumber;
  finish?: DayNumber;
  hours: number;
  progress: number;
}

export interface MilestoneSchedule extends RollUp {
  id: string;
  target?: DayNumber;
  /** Latest finish of its tasks. */
  forecast?: DayNumber;
  late: boolean;
  /** Working days forecast − target (positive = late). */
  variance?: number;
}

export interface Schedule {
  mode: ScheduleMode;
  today: DayNumber;
  /** First simulated day: max(today, project start). */
  start: DayNumber;
  calendar: Calendar;
  graph: DepGraph;
  tasks: Map<Task, TaskSchedule>;
  byKey: Map<string, TaskSchedule>;
  allocations: Allocation[];
  /** resource → day → hours */
  load: Map<string, Map<DayNumber, number>>;
  parents: Map<Task, RollUp>;
  sections: Map<Section, RollUp>;
  milestones: Map<string, MilestoneSchedule>;
  /** Latest finish of all tasks. */
  finish?: DayNumber;
  /** Reference date of the CPM backward pass (latest milestone target, else finish). */
  reference?: DayNumber;
  criticalPath: Task[];
  /** Resources in scheduling order (team order, then unassigned). */
  resources: string[];
}

const EPS = 1e-6;

export function taskKey(t: Task): string {
  return t.id ?? `${t.file}#${t.line + 1}`;
}

export function schedulePlan(plan: Plan, options: ScheduleOptions): Schedule {
  const mode = options.mode ?? "capacity";
  const calendar = new Calendar(plan.project, plan.people, {
    unassignedCapacity: options.unassignedCapacity ?? 40,
  });
  const graph = buildDepGraph(plan);
  const today = parseDate(options.today);
  if (today === undefined) throw new Error(`Invalid today: ${options.today}`);
  const projectStart = plan.project.start ? parseDate(plan.project.start)! : today;
  const start = Math.max(today, projectStart);
  const horizon = start + (options.horizonDays ?? 3650);
  const hpd = plan.project.hoursPerDay;

  const tasks = new Map<Task, TaskSchedule>();
  const byKey = new Map<string, TaskSchedule>();
  const allocations: Allocation[] = [];
  const load = new Map<string, Map<DayNumber, number>>();
  const resources = [...plan.people.map((p) => p.id.toLowerCase()), UNASSIGNED];

  const addLoad = (resource: string, day: DayNumber, hours: number) => {
    let m = load.get(resource);
    if (!m) load.set(resource, (m = new Map()));
    m.set(day, (m.get(day) ?? 0) + hours);
  };

  // --- Per-leaf setup --------------------------------------------------------------------------
  const remaining = new Map<Task, number>();
  const fixedStart = new Map<Task, DayNumber>();
  const fixedStartFrom = new Map<Task, Task>();
  const deadlineIdx = new Map<Task, number>();
  for (const leaf of graph.leaves) {
    const owner = ownerOf(leaf);
    const known =
      owner !== undefined && (calendar.hasResource(owner) || owner.toLowerCase() === UNASSIGNED);
    const resource = known ? owner!.toLowerCase() : UNASSIGNED;
    const deadline = deadlineOf(plan, leaf);
    const ts: TaskSchedule = {
      task: leaf,
      key: taskKey(leaf),
      resource,
      scheduledHours: 0,
      done: false,
      late: false,
      critical: false,
      unassigned: owner === undefined || owner.toLowerCase() === UNASSIGNED,
      unknownOwner: owner !== undefined && !known,
      unestimated: estimateHours(leaf) === undefined,
      deadline: deadline ? parseDate(deadline) : undefined,
    };
    tasks.set(leaf, ts);
    byKey.set(ts.key, ts);
    if (!isOpen(leaf.status) || isEffectivelyDone(leaf)) {
      fixDone(ts, calendar, allocations, addLoad);
      continue;
    }
    if (graph.cyclic.has(leaf)) {
      ts.unscheduled = "cycle";
      continue;
    }
    remaining.set(leaf, remainingHours(leaf));
    let fs: DayNumber | undefined;
    for (let t: Task | undefined = leaf; t; t = t.parent) {
      const d = t.start ? parseDate(t.start) : undefined;
      if (d !== undefined && (fs === undefined || d > fs)) {
        fs = d;
        fixedStartFrom.set(leaf, t);
      }
    }
    if (fs !== undefined) fixedStart.set(leaf, fs);
    if (ts.deadline !== undefined) deadlineIdx.set(leaf, workIndex(calendar, start, ts.deadline));
  }

  // --- Dependency bookkeeping ------------------------------------------------------------------
  const finishOf = (node: DepNode): DayNumber | null | undefined => {
    // number = finished that day; null = satisfied long ago / never constrains; undefined = not yet.
    if (node.kind === "leaf") {
      const ts = tasks.get(node.task)!;
      if (ts.done) return ts.finish ?? null;
      return ts.finish;
    }
    let max: DayNumber | null = null;
    for (const m of node.members) {
      const ts = tasks.get(m)!;
      if (ts.unscheduled) return undefined;
      const f = ts.done ? (ts.finish ?? null) : ts.finish;
      if (f === undefined) return undefined;
      if (f !== null && (max === null || f > max)) max = f;
    }
    return max;
  };

  /** The member of a node that finished last (the one a successor really waited for). */
  const lastOf = (node: DepNode): Task => {
    if (node.kind === "leaf") return node.task;
    let last = node.members[0];
    for (const m of node.members)
      if ((tasks.get(m)!.finish ?? -Infinity) > (tasks.get(last)!.finish ?? -Infinity)) last = m;
    return last;
  };

  /** Earliest day a ready leaf may start given finished requirements, or undefined if waiting. */
  const earliestDay = (
    leaf: Task,
    resource: string
  ): { day: DayNumber; driver?: StartDriver } | undefined => {
    let earliest = start;
    let driver: StartDriver | undefined;
    for (const r of graph.requirements.get(leaf) ?? []) {
      const f = finishOf(r.node);
      if (f === undefined) return undefined;
      if (f === null) continue;
      const lagDays = Math.ceil(r.lagHours / hpd - EPS);
      const sameResourceSameDay =
        lagDays === 0 &&
        r.node.kind === "leaf" &&
        tasks.get(r.node.task)!.resource === resource &&
        !tasks.get(r.node.task)!.done;
      // Without a lag the successor may start the next day its owner works (an extra working day
      // on a Saturday counts); a lag counts working days of the project calendar.
      const d = sameResourceSameDay
        ? f
        : lagDays === 0
          ? f + 1
          : calendar.addWorkingDays(f + 1, lagDays);
      if (d > earliest) {
        earliest = d;
        driver = { kind: "dep", on: lastOf(r.node), declaredBy: r.declaredBy };
      }
    }
    const fs = fixedStart.get(leaf);
    if (fs !== undefined && fs > earliest) {
      earliest = fs;
      driver = { kind: "start", from: fixedStartFrom.get(leaf)! };
    }
    return { day: earliest, driver };
  };

  // Mark tasks that are on a cycle or wait (transitively) on one. Memoized and iterative, so it
  // stays linear in the size of the graph (milestone dependencies fan out to every member) and
  // safe on deep chains. Every cycle runs through `graph.cyclic`, so the rest is a DAG.
  const waitsOnCycle = new Map<Task, boolean>();
  const depsOf = (leaf: Task): Task[] =>
    (graph.requirements.get(leaf) ?? []).flatMap((r) =>
      r.node.kind === "leaf" ? [r.node.task] : r.node.members
    );
  const resolveCycleWait = (root: Task): boolean => {
    const stack = [{ leaf: root, deps: depsOf(root), i: 0, blocked: graph.cyclic.has(root) }];
    const onPath = new Set<Task>([root]);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (!frame.blocked && frame.i < frame.deps.length) {
        const dep = frame.deps[frame.i++];
        const known = graph.cyclic.has(dep) || waitsOnCycle.get(dep);
        if (known) frame.blocked = true;
        else if (known === undefined && !onPath.has(dep)) {
          onPath.add(dep);
          stack.push({ leaf: dep, deps: depsOf(dep), i: 0, blocked: false });
        }
        continue;
      }
      stack.pop();
      onPath.delete(frame.leaf);
      waitsOnCycle.set(frame.leaf, frame.blocked);
      if (frame.blocked && stack.length > 0) stack[stack.length - 1].blocked = true;
    }
    return waitsOnCycle.get(root)!;
  };
  for (const leaf of remaining.keys()) {
    if (resolveCycleWait(leaf)) tasks.get(leaf)!.unscheduled = "blocked-by-cycle";
  }

  // --- Simulation ------------------------------------------------------------------------------
  // Per resource: `future` holds released tasks by earliest day, `ready` holds eligible tasks by
  // priority. The priority key is independent of the day (the slack term only differs by the
  // current day index, which is the same for all candidates), so heaps keep the order.
  const pending = new Set([...remaining.keys()].filter((t) => !tasks.get(t)!.unscheduled));
  const keyOf = new Map<Task, number[]>();
  const priorityKey = (t: Task): number[] => {
    const di = deadlineIdx.get(t);
    const slack = di === undefined ? Number.POSITIVE_INFINITY : di - remaining.get(t)! / hpd;
    const key = [fixedStart.has(t) ? 0 : 1, PRIORITY_RANK[t.prio], slack, t.order];
    keyOf.set(t, key);
    return key;
  };
  const lessKey = (a: Task, b: Task) => {
    const ka = keyOf.get(a)!;
    const kb = keyOf.get(b)!;
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i];
    return false;
  };
  const queues = new Map<string, { future: Heap<Task>; ready: Heap<Task> }>();
  const queueOf = (resource: string) => {
    let q = queues.get(resource);
    if (!q) {
      q = {
        future: new Heap<Task>(
          (a, b) =>
            tasks.get(a)!.earliest! < tasks.get(b)!.earliest! ||
            (tasks.get(a)!.earliest === tasks.get(b)!.earliest && a.order < b.order)
        ),
        ready: new Heap<Task>(lessKey),
      };
      queues.set(resource, q);
    }
    return q;
  };
  const groupsOf = new Map<Task, DepNode[]>();
  for (const g of graph.groups.values()) {
    for (const m of g.members) {
      const list = groupsOf.get(m);
      if (list) list.push(g);
      else groupsOf.set(m, [g]);
    }
  }

  const released = new Set<Task>();
  const finishTask = (t: Task, day: DayNumber) => {
    const ts = tasks.get(t)!;
    ts.finish = day;
    if (ts.start === undefined) ts.start = day;
    pending.delete(t);
    remaining.set(t, 0);
    // Release the tasks that wait on this one (directly or through a parent/milestone group).
    const nodes: DepNode[] = [graph.leafNode.get(t)!, ...(groupsOf.get(t) ?? [])];
    for (const n of nodes) for (const dep of graph.dependents.get(n) ?? []) tryRelease(dep);
  };
  const tryRelease = (leaf: Task): void => {
    if (released.has(leaf) || !pending.has(leaf)) return;
    const ts = tasks.get(leaf)!;
    const found = earliestDay(leaf, ts.resource);
    if (found === undefined) return;
    const e = found.day;
    ts.earliest = e;
    ts.driver = found.driver;
    released.add(leaf);
    if (remaining.get(leaf)! <= EPS) {
      // Zero-hour tasks (nothing left, or unestimated) need no capacity: they complete on the
      // first working day they are ready.
      finishTask(leaf, calendar.nextWorkingDay(e));
      return;
    }
    queueOf(ts.resource).future.push(leaf);
  };
  for (const leaf of [...pending]) tryRelease(leaf);

  for (let day = start; pending.size > 0 && day <= horizon; day++) {
    for (const resource of resources) {
      const q = queues.get(resource);
      if (!q || (q.future.size === 0 && q.ready.size === 0)) continue;
      const capacity = calendar.capacity(resource, day);
      const promote = () => {
        while (q.future.size > 0 && tasks.get(q.future.peek()!)!.earliest! <= day) {
          const t = q.future.pop()!;
          priorityKey(t);
          q.ready.push(t);
        }
      };
      promote();
      if (capacity <= EPS || q.ready.size === 0) continue;
      const allocate = (t: Task, hours: number) => {
        const ts = tasks.get(t)!;
        if (ts.start === undefined) ts.start = day;
        allocations.push({ key: ts.key, resource, day, hours });
        addLoad(resource, day, hours);
        ts.scheduledHours += hours;
        remaining.set(t, remaining.get(t)! - hours);
      };
      const carry: Task[] = [];
      if (mode === "capacity") {
        let free = capacity;
        while (free > EPS) {
          promote(); // same-person successors released earlier today
          const t = q.ready.pop();
          if (!t) break;
          const hours = Math.min(free, remaining.get(t)!);
          allocate(t, hours);
          free -= hours;
          if (remaining.get(t)! <= EPS) finishTask(t, day);
          else carry.push(t);
        }
      } else {
        // Demand: every eligible task gets the person's full capacity, as if alone.
        const worked = new Set<Task>();
        for (;;) {
          promote();
          const t = q.ready.pop();
          if (!t) break;
          if (worked.has(t)) {
            carry.push(t);
            continue;
          }
          worked.add(t);
          allocate(t, Math.min(capacity, remaining.get(t)!));
          if (remaining.get(t)! <= EPS) finishTask(t, day);
          else carry.push(t);
        }
      }
      for (const t of carry) {
        priorityKey(t);
        q.ready.push(t);
      }
    }
  }
  // A task that was never released waited for work that never finished; the others found no capacity.
  for (const t of pending)
    tasks.get(t)!.unscheduled = released.has(t) ? "horizon" : "waits-for-unscheduled";

  // Tasks under way show their real start (a to-do task's leftover @started is ignored).
  for (const ts of tasks.values()) {
    if (ts.done || ts.unscheduled) continue;
    const startedIso = startedOn(ts.task);
    const started = startedIso ? parseDate(startedIso) : undefined;
    if (started !== undefined && (ts.start === undefined || started < ts.start)) ts.start = started;
    if (ts.finish !== undefined && ts.deadline !== undefined) ts.late = ts.finish > ts.deadline;
  }

  const schedule: Schedule = {
    mode,
    today,
    start,
    calendar,
    graph,
    tasks,
    byKey,
    allocations,
    load,
    parents: new Map(),
    sections: new Map(),
    milestones: new Map(),
    criticalPath: [],
    resources,
  };
  rollUp(plan, schedule);
  computeCriticalPath(plan, schedule);
  return schedule;
}

/**
 * Done tasks are fixed at @started → @done; their actual (or estimated) hours fill the days the
 * person worked in between (their working days, extra working days, not their time off).
 */
function fixDone(
  ts: TaskSchedule,
  calendar: Calendar,
  allocations: Allocation[],
  addLoad: (r: string, d: DayNumber, h: number) => void
): void {
  const t = ts.task;
  ts.done = true;
  const done = t.done ? parseDate(t.done) : undefined;
  const started = t.started ? parseDate(t.started) : undefined;
  ts.finish = done ?? started;
  ts.start = started ?? done;
  if (ts.start !== undefined && ts.finish !== undefined && ts.finish < ts.start)
    ts.start = ts.finish;
  if (t.status !== "done" || ts.start === undefined || ts.finish === undefined) return;
  const hours = t.act ?? estimateHours(t) ?? 0;
  if (hours <= 0) return;
  const days: DayNumber[] = [];
  for (let d = ts.start; d <= ts.finish; d++)
    if (calendar.capacity(ts.resource, d) > 0) days.push(d);
  if (days.length === 0)
    for (let d = ts.start; d <= ts.finish; d++) if (calendar.isWorkingDay(d)) days.push(d);
  if (days.length === 0) days.push(ts.finish);
  for (const d of days) {
    allocations.push({ key: ts.key, resource: ts.resource, day: d, hours: hours / days.length });
    addLoad(ts.resource, d, hours / days.length);
  }
}

/** Working-day index of `day` relative to `origin` (negative before it). */
const indexCache = new WeakMap<Calendar, Map<number, Map<number, number>>>();
export function workIndex(calendar: Calendar, origin: DayNumber, day: DayNumber): number {
  let byOrigin = indexCache.get(calendar);
  if (!byOrigin) indexCache.set(calendar, (byOrigin = new Map()));
  let m = byOrigin.get(origin);
  if (!m) byOrigin.set(origin, (m = new Map()));
  const cached = m.get(day);
  if (cached !== undefined) return cached;
  const v = calendar.workingDaysBetween(origin, day);
  m.set(day, v);
  return v;
}

function rollUp(plan: Plan, s: Schedule): void {
  const leafRoll = (leaves: Task[]): RollUp => {
    let start: DayNumber | undefined;
    let finish: DayNumber | undefined;
    let hours = 0;
    let total = 0;
    let done = 0;
    for (const l of leaves) {
      const ts = s.tasks.get(l);
      if (!ts) continue;
      if (ts.start !== undefined && (start === undefined || ts.start < start)) start = ts.start;
      if (ts.finish !== undefined && (finish === undefined || ts.finish > finish))
        finish = ts.finish;
      const est = estimateHours(l) ?? 0;
      hours += est;
      total += est;
      done += est * progressOf(l);
    }
    const counted = leaves.filter((l) => s.tasks.has(l));
    const progress =
      total > 0
        ? done / total
        : counted.length
          ? counted.filter((l) => l.status === "done").length / counted.length
          : 0;
    return { start, finish, hours, progress };
  };
  for (const t of plan.tasks) {
    if (isLeaf(t) || isEffectivelyCancelled(t)) continue;
    const r = leafRoll(leavesOf(t));
    s.parents.set(t, { ...r, hours: estimateHours(t) ?? r.hours });
  }
  let finish: DayNumber | undefined;
  for (const m of plan.milestones) {
    for (const sec of m.sections)
      s.sections.set(sec, leafRoll(sec.tasks.flatMap((t) => leavesOf(t))));
    const leaves = m.tasks.flatMap((t) => (t.status === "cancelled" ? [] : leavesOf(t)));
    const r = leafRoll(leaves);
    const target = m.target ? parseDate(m.target) : undefined;
    const ms: MilestoneSchedule = {
      ...r,
      id: m.id,
      target,
      forecast: r.finish,
      late:
        m.status !== "cancelled" &&
        target !== undefined &&
        r.finish !== undefined &&
        r.finish > target,
      variance:
        target !== undefined && r.finish !== undefined
          ? s.calendar.workingDaysBetween(target, r.finish)
          : undefined,
    };
    if (m.status === "cancelled") ms.late = false;
    s.milestones.set(m.id, ms);
    if (r.finish !== undefined && (finish === undefined || r.finish > finish)) finish = r.finish;
  }
  s.finish = finish;
}

/**
 * CPM on the scheduled durations. Backward pass from the latest milestone target (or the schedule
 * finish when no milestone has a target); a task's own deadline (@due or milestone target) also
 * caps its late finish. Slack = late start − scheduled start in working days. Critical = slack at or
 * below max(0, minimum slack).
 */
function computeCriticalPath(plan: Plan, s: Schedule): void {
  const cal = s.calendar;
  const targets = plan.milestones
    .filter((m) => m.status !== "cancelled" && m.target)
    .map((m) => parseDate(m.target!)!);
  const reference = targets.length ? Math.max(...targets) : s.finish;
  s.reference = reference;
  if (reference === undefined) return;

  const open = [...s.tasks.values()].filter(
    (ts) => !ts.done && !ts.unscheduled && ts.start !== undefined && ts.finish !== undefined
  );
  const openSet = new Set(open.map((o) => o.task));
  // Successors per leaf (through group nodes too).
  const groupsOf = new Map<Task, DepNode[]>();
  for (const g of s.graph.groups.values())
    for (const m of g.members) groupsOf.set(m, [...(groupsOf.get(m) ?? []), g]);
  const successors = (t: Task): Array<{ task: Task; gapDays: number }> => {
    const out: Array<{ task: Task; gapDays: number }> = [];
    const own = s.tasks.get(t)!;
    const nodes: DepNode[] = [s.graph.leafNode.get(t)!, ...(groupsOf.get(t) ?? [])];
    for (const n of nodes) {
      for (const dep of s.graph.dependents.get(n) ?? []) {
        if (!openSet.has(dep)) continue;
        for (const r of s.graph.requirements.get(dep) ?? []) {
          if (r.node !== n) continue;
          const lagDays = Math.ceil(r.lagHours / plan.project.hoursPerDay - EPS);
          // A same-person successor that the scheduler placed on the predecessor's finish day may
          // stay there; otherwise the successor starts at least one working day later.
          const next = s.tasks.get(dep)!;
          const sameDay =
            lagDays === 0 &&
            n.kind === "leaf" &&
            next.resource === own.resource &&
            next.start === own.finish;
          out.push({ task: dep, gapDays: sameDay ? 0 : 1 + lagDays });
        }
      }
    }
    return out;
  };
  // Reverse topological order over open leaves (Kahn on successor edges).
  const succ = new Map(open.map((o) => [o.task, successors(o.task)]));
  const indegree = new Map<Task, number>(open.map((o) => [o.task, 0]));
  for (const list of succ.values())
    for (const x of list) indegree.set(x.task, (indegree.get(x.task) ?? 0) + 1);
  const order: Task[] = [];
  const queue = open.filter((o) => indegree.get(o.task) === 0).map((o) => o.task);
  while (queue.length) {
    const t = queue.shift()!;
    order.push(t);
    for (const x of succ.get(t) ?? []) {
      const d = indegree.get(x.task)! - 1;
      indegree.set(x.task, d);
      if (d === 0) queue.push(x.task);
    }
  }
  const lateStart = new Map<Task, DayNumber>();
  const refIdx = (d: DayNumber) => workIndex(cal, s.start, d);
  for (let i = order.length - 1; i >= 0; i--) {
    const t = order[i];
    const ts = s.tasks.get(t)!;
    let lf = refIdx(cal.previousWorkingDay(reference));
    if (ts.deadline !== undefined) lf = Math.min(lf, refIdx(cal.previousWorkingDay(ts.deadline)));
    for (const x of succ.get(t) ?? []) {
      const ls = lateStart.get(x.task);
      if (ls !== undefined) lf = Math.min(lf, ls - x.gapDays);
    }
    // Only the scheduled part counts: in-progress tasks started before today.
    const es = refIdx(cal.nextWorkingDay(Math.max(ts.start!, s.start)));
    const duration = Math.max(0, refIdx(ts.finish!) - es);
    const ls = lf - duration;
    lateStart.set(t, ls);
    ts.slack = ls - es;
  }
  const slacks = open.map((o) => o.slack!).filter((x) => x !== undefined);
  if (slacks.length === 0) return;
  const threshold = Math.max(0, Math.min(...slacks));
  for (const o of open) o.critical = o.slack! <= threshold;
  s.criticalPath = open
    .filter((o) => o.critical)
    .sort((a, b) => a.start! - b.start! || a.finish! - b.finish! || a.task.order - b.task.order)
    .map((o) => o.task);
}

/** Leaves of a milestone that take part in the schedule. */
export function milestoneTasks(s: Schedule, m: Milestone): TaskSchedule[] {
  const out: TaskSchedule[] = [];
  for (const t of m.tasks)
    for (const l of leavesOf(t)) {
      const ts = s.tasks.get(l);
      if (ts) out.push(ts);
    }
  return out;
}

export function isoOrUndefined(day: DayNumber | undefined): string | undefined {
  return day === undefined ? undefined : formatDate(day);
}

/** Minimal binary heap with a "less than" comparator. */
class Heap<T> {
  private readonly items: T[] = [];
  constructor(private readonly less: (a: T, b: T) => boolean) {}

  get size(): number {
    return this.items.length;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  push(item: T): void {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }

  pop(): T | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

/** Finds a task (or punch/inbox item) by the key used in schedules and view models. */
export function findTaskByKey(plan: Plan, key: string): Task | undefined {
  const hash = key.lastIndexOf("#");
  if (hash > 0) {
    const file = key.slice(0, hash);
    const line = Number(key.slice(hash + 1)) - 1;
    return plan.file(file)?.items.find((t) => t.line === line);
  }
  return plan.taskById(key) ?? plan.punchById(key) ?? plan.inbox.find((t) => t.id === key);
}
