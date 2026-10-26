// Deterministic resource-constrained list scheduler. Same plan + same options (including `today`)
// → same schedule. Works on leaf tasks; parents, sections and milestones roll up.
//
//  1. Dependency graph of leaf tasks (parent dependency = all its leaves, milestone `depends`).
//     Cycles are rejected and left unscheduled.
//  2. Done tasks are fixed at @started → @done; cancelled tasks are ignored.
//  3. Walk days from max(today, project start). Per person, tasks are ready when their
//     dependencies have finished (plus lag) and their @start has been reached.
//  4. Ready tasks are ordered: fixed @start first, then @prio, then the latest day they can finish
//     without making anything late (their own @due or milestone target, their owner's last
//     working day, and the tasks that wait for them), then file order.
//  5. The person's free hours of the day go to tasks in that order; tasks span days and share days.
//  6. A task finishes on the day its remaining hours reach 0.
//  7. Per task start/finish and per person-day allocations are recorded.
import { Calendar, type CalendarOptions, UNASSIGNED } from "./calendar";
import { type DayNumber, formatDate, parseDate } from "./dates";
import {
  buildDepGraph,
  type DepGraph,
  type DepNode,
  type GroupNode,
  type Requirement,
} from "./graph";
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
  /**
   * Schedule one task as if its remaining hours or its own `@start` were different, without
   * editing the plan: what a Gantt drag would do, before it is written.
   */
  whatIf?: { task: Task; remaining?: number; start?: DayNumber };
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
  /** The latest @start of the task and its parents (open tasks): it does not start before. */
  fixedStart?: DayNumber;
  /**
   * Its place among its owner's work that is ready, lowest first (tasks with hours left): a fixed
   * start first, then @prio, the latest finish that keeps everything on time, file order.
   */
  precedence?: number[];
  deadline?: DayNumber;
  /** Finish after the deadline (@due, inherited @due or milestone target). */
  late: boolean;
  /** Total slack in working days (CPM); negative when late. */
  slack?: number;
  /**
   * When the slack ends where someone's working hours end (`capacityFrom: … 0h`): the owner of
   * this task or of work that waits for it, and the first day without hours.
   */
  hoursEnd?: { resource: string; from: DayNumber };
  critical: boolean;
  unassigned: boolean;
  unknownOwner: boolean;
  unestimated: boolean;
}

/** Waited for `on` (a leaf), through the dependency declared by a task or a milestone. */
export interface DepDriver {
  kind: "dep";
  on: Task;
  declaredBy: Task | string;
}

export type StartDriver =
  | DepDriver
  /**
   * The `@start` of `from` (the task itself or an ancestor). Without it the task could have
   * started on `otherwise`, set by `dep` (none: the first day of the schedule).
   */
  | { kind: "start"; from: Task; otherwise: DayNumber; dep?: DepDriver };

export interface Allocation {
  key: string;
  /** The task that got the hours: tasks that share an id share a key. */
  task: Task;
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
    const whatIf = options.whatIf?.task === leaf ? options.whatIf : undefined;
    remaining.set(leaf, whatIf?.remaining ?? remainingHours(leaf));
    let fs: DayNumber | undefined;
    for (let t: Task | undefined = leaf; t; t = t.parent) {
      const d =
        t === leaf && whatIf?.start !== undefined
          ? whatIf.start
          : t.start
            ? parseDate(t.start)
            : undefined;
      if (d !== undefined && (fs === undefined || d > fs)) {
        fs = d;
        fixedStartFrom.set(leaf, t);
      }
    }
    if (fs !== undefined) {
      fixedStart.set(leaf, fs);
      ts.fixedStart = fs;
    }
    if (ts.deadline !== undefined) deadlineIdx.set(leaf, workIndex(calendar, start, ts.deadline));
  }

  // --- Dependency bookkeeping ------------------------------------------------------------------
  const groupsOf = groupsByMember(graph);

  // Mark tasks that wait (transitively) on a cycle: everything reachable backwards from the tasks
  // on a cycle, through the tasks and groups that wait for them. Linear in the size of the graph
  // (milestone dependencies fan out to every member) and safe on deep chains.
  const waitsOnCycle = new Set<Task>();
  const behind: DepNode[] = [...graph.cyclic].map((t) => graph.leafNode.get(t)!);
  const seenGroups = new Set<GroupNode>();
  for (let i = 0; i < behind.length; i++) {
    const n = behind[i];
    for (const dep of graph.dependents.get(n) ?? [])
      if (!graph.cyclic.has(dep) && !waitsOnCycle.has(dep)) {
        waitsOnCycle.add(dep);
        behind.push(graph.leafNode.get(dep)!);
      }
    if (n.kind === "leaf")
      for (const g of groupsOf.get(n.task) ?? [])
        if (!seenGroups.has(g)) {
          seenGroups.add(g);
          behind.push(g);
        }
  }
  for (const leaf of remaining.keys())
    if (waitsOnCycle.has(leaf)) tasks.get(leaf)!.unscheduled = "blocked-by-cycle";

  const pending = new Set([...remaining.keys()].filter((t) => !tasks.get(t)!.unscheduled));

  // A requirement is met when its task (or every task of its group) is done or has finished. Each
  // group counts its tasks still to finish and each open leaf its requirements still to be met, so
  // a finished task only touches the tasks that wait for it.
  const toFinish = new Map<GroupNode, number>();
  for (const g of graph.groups.values())
    toFinish.set(g, g.members.filter((m) => !tasks.get(m)!.done).length);
  const unmet = new Map<Task, number>();
  for (const leaf of pending) {
    let n = 0;
    for (const r of graph.requirements.get(leaf) ?? []) {
      const met =
        r.node.kind === "leaf"
          ? tasks.get(r.node.task)!.done || tasks.get(r.node.task)!.finish !== undefined
          : toFinish.get(r.node) === 0;
      if (!met) n++;
    }
    unmet.set(leaf, n);
  }

  /** When a met group finished (null: its tasks were done without dates) and which finished last. */
  const groupEnds = new Map<GroupNode, { day: DayNumber | null; last: Task }>();
  const groupEnd = (g: GroupNode): { day: DayNumber | null; last: Task } => {
    let end = groupEnds.get(g);
    if (!end) {
      end = { day: null, last: g.members[0] };
      for (const m of g.members) {
        const f = tasks.get(m)!.finish;
        if (f !== undefined && (end.day === null || f > end.day)) end = { day: f, last: m };
      }
      groupEnds.set(g, end);
    }
    return end;
  };
  /** The day a met requirement finished; null when it was done without a date (no constraint). */
  const finishOf = (node: DepNode): DayNumber | null =>
    node.kind === "leaf" ? (tasks.get(node.task)!.finish ?? null) : groupEnd(node).day;
  /** The task of a met requirement that finished last (the one a successor really waited for). */
  const lastOf = (node: DepNode): Task => (node.kind === "leaf" ? node.task : groupEnd(node).last);

  const latestFinish = latestFinishes(plan, graph, groupsOf, pending, tasks, remaining, {
    calendar,
    start,
    hpd,
    deadlineIdx,
  });

  // --- Simulation ------------------------------------------------------------------------------
  // Per resource: `future` holds released tasks by earliest day, `ready` holds eligible tasks by
  // priority. The priority key does not change over time (the latest finish is computed once, so a
  // task in progress keeps its place), so heaps keep the order.
  const lessKey = (a: Queued, b: Queued) => {
    for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i] < b.key[i];
    return false;
  };
  const queues = new Map<string, { future: Heap<Queued>; ready: Heap<Queued> }>();
  const queueOf = (resource: string) => {
    let q = queues.get(resource);
    if (!q) {
      q = {
        future: new Heap<Queued>(
          (a, b) =>
            a.earliest < b.earliest || (a.earliest === b.earliest && a.task.order < b.task.order)
        ),
        ready: new Heap<Queued>(lessKey),
      };
      queues.set(resource, q);
    }
    return q;
  };

  const released = new Set<Task>();
  /**
   * Finishes a task, then the tasks without hours left that it releases (they need no capacity),
   * and so on: a worklist rather than recursion, so a long chain of them cannot run out of stack.
   */
  const finishTask = (task: Task, day: DayNumber) => {
    const finishing: Array<[Task, DayNumber]> = [[task, day]];
    while (finishing.length > 0) {
      const [t, d] = finishing.pop()!;
      const ts = tasks.get(t)!;
      ts.finish = d;
      if (ts.start === undefined) ts.start = d;
      pending.delete(t);
      remaining.set(t, 0);
      // The requirements this meets: its own, and the parent/milestone groups it completes. Then
      // release the tasks that wait on them.
      const met: DepNode[] = [graph.leafNode.get(t)!];
      for (const g of groupsOf.get(t) ?? []) {
        const left = toFinish.get(g)! - 1;
        toFinish.set(g, left);
        if (left === 0) met.push(g);
      }
      for (const n of met)
        for (const dep of graph.dependents.get(n) ?? []) {
          const left = unmet.get(dep);
          if (left !== undefined) unmet.set(dep, left - 1);
        }
      for (const n of met)
        for (const dep of graph.dependents.get(n) ?? []) {
          const at = tryRelease(dep);
          if (at !== undefined) finishing.push([dep, at]);
        }
    }
  };
  /** Queues a task once its requirements are met; for a task without hours left, its finish day. */
  const tryRelease = (leaf: Task): DayNumber | undefined => {
    if (released.has(leaf) || !pending.has(leaf) || unmet.get(leaf)! > 0) return undefined;
    const ts = tasks.get(leaf)!;
    // The earliest day every requirement allows, and what set it.
    let earliest = start;
    let by: Requirement | undefined;
    for (const r of graph.requirements.get(leaf) ?? []) {
      const f = finishOf(r.node);
      if (f === null) continue;
      const p = r.node.kind === "leaf" ? tasks.get(r.node.task)! : undefined;
      const d = startAfter(calendar, r, f, p?.resource === ts.resource && !p.done);
      if (d > earliest) {
        earliest = d;
        by = r;
      }
    }
    const dep: DepDriver | undefined = by && {
      kind: "dep",
      on: lastOf(by.node),
      declaredBy: by.declaredBy,
    };
    ts.driver = dep;
    const fs = fixedStart.get(leaf);
    if (fs !== undefined && fs > earliest) {
      ts.driver = { kind: "start", from: fixedStartFrom.get(leaf)!, otherwise: earliest, dep };
      earliest = fs;
    }
    ts.earliest = earliest;
    released.add(leaf);
    // Zero-hour tasks (nothing left, or unestimated) need no capacity: they complete on the first
    // working day they are ready.
    if (remaining.get(leaf)! <= EPS) return calendar.nextWorkingDay(earliest);
    ts.precedence = [
      fixedStart.has(leaf) ? 0 : 1,
      PRIORITY_RANK[leaf.prio],
      latestFinish.get(leaf)!,
      leaf.order,
    ];
    queueOf(ts.resource).future.push({ task: leaf, earliest, key: ts.precedence });
    return undefined;
  };
  for (const leaf of [...pending]) {
    const at = tryRelease(leaf);
    if (at !== undefined) finishTask(leaf, at);
  }

  for (let day = start; pending.size > 0 && day <= horizon; day++) {
    for (const resource of resources) {
      const q = queues.get(resource);
      if (!q || (q.future.size === 0 && q.ready.size === 0)) continue;
      const capacity = calendar.capacity(resource, day);
      const promote = () => {
        while (q.future.size > 0 && q.future.peek()!.earliest <= day) q.ready.push(q.future.pop()!);
      };
      promote();
      if (capacity <= EPS || q.ready.size === 0) continue;
      const allocate = (t: Task, hours: number) => {
        const ts = tasks.get(t)!;
        if (ts.start === undefined) ts.start = day;
        allocations.push({ key: ts.key, task: t, resource, day, hours });
        addLoad(resource, day, hours);
        ts.scheduledHours += hours;
        remaining.set(t, remaining.get(t)! - hours);
      };
      const carry: Queued[] = [];
      if (mode === "capacity") {
        let free = capacity;
        while (free > EPS) {
          promote(); // same-person successors released earlier today
          const next = q.ready.pop();
          if (!next) break;
          const t = next.task;
          const hours = Math.min(free, remaining.get(t)!);
          allocate(t, hours);
          free -= hours;
          if (remaining.get(t)! <= EPS) finishTask(t, day);
          else carry.push(next);
        }
      } else {
        // Demand: every eligible task gets the person's full capacity, as if alone.
        const worked = new Set<Task>();
        for (;;) {
          promote();
          const next = q.ready.pop();
          if (!next) break;
          const t = next.task;
          if (worked.has(t)) {
            carry.push(next);
            continue;
          }
          worked.add(t);
          allocate(t, Math.min(capacity, remaining.get(t)!));
          if (remaining.get(t)! <= EPS) finishTask(t, day);
          else carry.push(next);
        }
      }
      for (const next of carry) q.ready.push(next);
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
  computeCriticalPath(plan, schedule, groupsOf);
  return schedule;
}

/**
 * The latest working-day index each open leaf can finish without making anything late. It has to
 * finish by its own deadline, by its owner's last working day (`capacityFrom: … 0h`), and in time
 * for every task that waits for it (that task's latest start, a day earlier when another person
 * takes over, minus the lag). A backward pass like CPM's on the estimated durations, so work that
 * others wait for goes first. The task's own estimate does not change its own place: making a bar
 * longer in the Gantt does not make it jump ahead of the person's other work. Infinity when
 * nothing bounds it.
 */
function latestFinishes(
  plan: Plan,
  graph: DepGraph,
  groupsOf: Map<Task, GroupNode[]>,
  pending: Set<Task>,
  tasks: Map<Task, TaskSchedule>,
  remaining: Map<Task, number>,
  ctx: { calendar: Calendar; start: DayNumber; hpd: number; deadlineIdx: Map<Task, number> }
): Map<Task, number> {
  const { calendar, start, hpd, deadlineIdx } = ctx;
  const capacityEnd = new Map<string, number>();
  for (const p of plan.people) {
    const last = p.capacityChanges[p.capacityChanges.length - 1];
    if (last?.hours === 0)
      capacityEnd.set(p.id.toLowerCase(), workIndex(calendar, start, last.from - 1));
  }
  const latest = new Map<Task, number>();
  const own = (t: Task) =>
    Math.min(
      deadlineIdx.get(t) ?? Number.POSITIVE_INFINITY,
      capacityEnd.get(tasks.get(t)!.resource) ?? Number.POSITIVE_INFINITY
    );
  const latestStart = (t: Task) => latest.get(t)! - remaining.get(t)! / hpd;
  // What the tasks waiting for a whole group leave to its tasks, per person who waits: for the same
  // person (no hand-over day) and for anyone else. Worked out once per group, not once per member.
  const groupBounds = new Map<GroupNode, Map<string, { same: number; other: number }>>();
  const groupBound = (g: GroupNode, resource: string): number => {
    let byResource = groupBounds.get(g);
    if (!byResource) {
      byResource = new Map();
      for (const dep of graph.dependents.get(g) ?? []) {
        if (!pending.has(dep)) continue;
        const waiter = tasks.get(dep)!.resource;
        const b = byResource.get(waiter) ?? { same: Infinity, other: Infinity };
        for (const r of graph.requirements.get(dep)!) {
          if (r.node !== g) continue;
          const lag = Math.ceil(r.lagHours / hpd - EPS);
          b.same = Math.min(b.same, latestStart(dep) - lag);
          b.other = Math.min(b.other, latestStart(dep) - (1 + lag));
        }
        byResource.set(waiter, b);
      }
      groupBounds.set(g, byResource);
    }
    let bound = Number.POSITIVE_INFINITY;
    for (const [waiter, b] of byResource)
      bound = Math.min(bound, waiter === resource ? b.same : b.other);
    return bound;
  };
  // Walked backwards, every task comes after the tasks that wait for it.
  const order = dependencyOrder(graph, groupsOf, pending);
  for (let i = order.length - 1; i >= 0; i--) {
    const t = order[i];
    const resource = tasks.get(t)!.resource;
    const node = graph.leafNode.get(t)!;
    let finishBy = own(t);
    for (const dep of graph.dependents.get(node) ?? []) {
      if (!pending.has(dep)) continue;
      const handOver = tasks.get(dep)!.resource === resource ? 0 : 1;
      for (const r of graph.requirements.get(dep)!)
        if (r.node === node)
          finishBy = Math.min(
            finishBy,
            latestStart(dep) - (handOver + Math.ceil(r.lagHours / hpd - EPS))
          );
    }
    for (const g of groupsOf.get(t) ?? []) finishBy = Math.min(finishBy, groupBound(g, resource));
    latest.set(t, finishBy);
  }
  // Only tasks around a cycle the graph did not flag are left: they keep their own bounds.
  for (const t of pending) if (!latest.has(t)) latest.set(t, own(t));
  return latest;
}

/** The groups (parents, milestones) each leaf belongs to. */
function groupsByMember(graph: DepGraph): Map<Task, GroupNode[]> {
  const groupsOf = new Map<Task, GroupNode[]>();
  for (const g of graph.groups.values())
    for (const m of g.members) {
      const list = groupsOf.get(m);
      if (list) list.push(g);
      else groupsOf.set(m, [g]);
    }
  return groupsOf;
}

/**
 * The tasks of `among` in an order in which every task comes after the tasks of `among` it waits
 * for, directly or through a group (Kahn's algorithm; a group counts its members still to come, so
 * a milestone dependency costs its members plus its dependents, not their product). Tasks around a
 * cycle are left out.
 */
function dependencyOrder(
  graph: DepGraph,
  groupsOf: Map<Task, GroupNode[]>,
  among: Set<Task>
): Task[] {
  const toCome = new Map<GroupNode, number>();
  for (const g of graph.groups.values())
    toCome.set(g, g.members.filter((m) => among.has(m)).length);
  const waiting = new Map<Task, number>();
  const order: Task[] = [];
  for (const t of among) {
    let n = 0;
    for (const r of graph.requirements.get(t) ?? [])
      if (r.node.kind === "leaf" ? among.has(r.node.task) : toCome.get(r.node)! > 0) n++;
    waiting.set(t, n);
    if (n === 0) order.push(t);
  }
  const arrived = (node: DepNode) => {
    for (const dep of graph.dependents.get(node) ?? []) {
      const n = waiting.get(dep);
      if (n === undefined) continue;
      waiting.set(dep, n - 1);
      if (n === 1) order.push(dep);
    }
  };
  for (let i = 0; i < order.length; i++) {
    const t = order[i];
    arrived(graph.leafNode.get(t)!);
    for (const g of groupsOf.get(t) ?? []) {
      const n = toCome.get(g)! - 1;
      toCome.set(g, n);
      if (n === 0) arrived(g);
    }
  }
  return order;
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
    allocations.push({
      key: ts.key,
      task: t,
      resource: ts.resource,
      day: d,
      hours: hours / days.length,
    });
    addLoad(ts.resource, d, hours / days.length);
  }
}

/**
 * The first day a task can start when a requirement it waits for finished on `finish`. Without a
 * lag the next day (its owner's next working day, an extra working day on a Saturday counts), or
 * the same day when it is open work of the same owner (the task takes over the hours left); a lag
 * counts working days of the project calendar.
 */
export function startAfter(
  calendar: Calendar,
  requirement: Requirement,
  finish: DayNumber,
  sameOwner: boolean
): DayNumber {
  const lagDays = Math.ceil(requirement.lagHours / calendar.hoursPerDay - EPS);
  if (lagDays > 0) return calendar.addWorkingDays(finish + 1, lagDays);
  return sameOwner ? finish : finish + 1;
}

/** Working-day index of `day` relative to `origin` (negative before it). */
export function workIndex(calendar: Calendar, origin: DayNumber, day: DayNumber): number {
  return calendar.workingDaysBetween(origin, day);
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
function computeCriticalPath(plan: Plan, s: Schedule, groupsOf: Map<Task, GroupNode[]>): void {
  const cal = s.calendar;
  const hpd = plan.project.hoursPerDay;
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
  const lateStart = new Map<Task, DayNumber>();
  // What ends each task's late finish, when it is someone's working hours (see TaskSchedule).
  const hoursEnd = new Map<Task, TaskSchedule["hoursEnd"]>();
  // A task that waits for a whole group starts at least one working day (plus the lag) after its
  // last task: the same late finish for every member, worked out once per group.
  const groupLateFinish = new Map<GroupNode, { lf: number; end: TaskSchedule["hoursEnd"] }>();
  const groupBound = (g: GroupNode) => {
    let found = groupLateFinish.get(g);
    if (!found) {
      found = { lf: Number.POSITIVE_INFINITY, end: undefined };
      for (const dep of s.graph.dependents.get(g) ?? []) {
        const ls = lateStart.get(dep);
        if (ls === undefined) continue;
        for (const r of s.graph.requirements.get(dep)!) {
          const lf = ls - (1 + Math.ceil(r.lagHours / hpd - EPS));
          if (r.node === g && lf < found.lf) found = { lf, end: hoursEnd.get(dep) };
        }
      }
      groupLateFinish.set(g, found);
    }
    return found;
  };
  const refIdx = (d: DayNumber) => workIndex(cal, s.start, d);
  const referenceLf = refIdx(cal.previousWorkingDay(reference));
  // An owner whose hours end (`capacityFrom: … 0h`) finishes their work by their last working day,
  // as in the latest-finish order of the simulation.
  const capacityEnd = new Map<string, { lf: number; from: DayNumber }>();
  for (const p of plan.people) {
    const last = p.capacityChanges[p.capacityChanges.length - 1];
    if (last?.hours === 0)
      capacityEnd.set(p.id.toLowerCase(), {
        lf: refIdx(cal.previousWorkingDay(last.from - 1)),
        from: last.from,
      });
  }
  // Walked backwards, every task comes after the tasks that wait for it.
  const order = dependencyOrder(s.graph, groupsOf, openSet);
  for (let i = order.length - 1; i >= 0; i--) {
    const t = order[i];
    const ts = s.tasks.get(t)!;
    let lf = referenceLf;
    let end: TaskSchedule["hoursEnd"];
    if (ts.deadline !== undefined) lf = Math.min(lf, refIdx(cal.previousWorkingDay(ts.deadline)));
    const own = capacityEnd.get(ts.resource);
    if (own && own.lf < lf) {
      lf = own.lf;
      end = { resource: ts.resource, from: own.from };
    }
    const node = s.graph.leafNode.get(t)!;
    for (const dep of s.graph.dependents.get(node) ?? []) {
      const ls = lateStart.get(dep);
      if (ls === undefined) continue;
      const next = s.tasks.get(dep)!;
      for (const r of s.graph.requirements.get(dep)!) {
        if (r.node !== node) continue;
        const lagDays = Math.ceil(r.lagHours / hpd - EPS);
        // A same-person successor that the scheduler placed on the predecessor's finish day may
        // stay there; otherwise the successor starts at least one working day later.
        const sameDay = lagDays === 0 && next.resource === ts.resource && next.start === ts.finish;
        const bound = ls - (sameDay ? 0 : 1 + lagDays);
        if (bound < lf) {
          lf = bound;
          end = hoursEnd.get(dep);
        }
      }
    }
    for (const g of groupsOf.get(t) ?? []) {
      const bound = groupBound(g);
      if (bound.lf < lf) {
        lf = bound.lf;
        end = bound.end;
      }
    }
    hoursEnd.set(t, end);
    ts.hoursEnd = end;
    // Only the scheduled part counts: in-progress tasks started before today.
    const es = refIdx(cal.nextWorkingDay(Math.max(ts.start!, s.start)));
    const duration = Math.max(0, refIdx(ts.finish!) - es);
    const ls = lf - duration;
    lateStart.set(t, ls);
    ts.slack = ls - es;
  }
  let least: number | undefined;
  for (const o of open)
    if (o.slack !== undefined && (least === undefined || o.slack < least)) least = o.slack;
  if (least === undefined) return;
  const threshold = Math.max(0, least);
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

/** A released task in its owner's queues, with what orders it there. */
interface Queued {
  task: Task;
  earliest: DayNumber;
  /** Fixed start first, then @prio, the latest finish, file order. */
  key: number[];
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
