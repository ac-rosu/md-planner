// Hours budget of the project (`budget:` in project.md) against the plan: what is estimated, what
// has been logged, what the project will take at this rate, and why it goes over. Pure; the
// dashboard, the status report, the diagnostics and the MCP server all use it.
import { type DayNumber, formatDate, parseDate } from "./dates";
import { type DepNode, isSchedulableTask } from "./graph";
import { type Issue, type Task } from "./model";
import { type Plan } from "./resolve";
import {
  activeChildren,
  budgetSplit,
  estimateHours,
  isEffectivelyCancelled,
  isEffectivelyDone,
  isLeaf,
  leavesOf,
  remainingHours,
} from "./rollup";
import { type Schedule, type TaskSchedule } from "./scheduler";

/**
 * Hours of a set of tasks. Leaves carry the work; a parent adds the hours logged on it. Cancelled
 * tasks and the tasks of cancelled milestones add only their logged hours (to spent and forecast).
 */
export interface BudgetFigures {
  /** Sum of the estimates, with the hours logged on a parent that its own estimate covers. */
  planned: number;
  /** Hours logged (`@act`), on parents and cancelled tasks too: those hours were spent. */
  spent: number;
  /** Work done without logged hours, at its estimate: done tasks and `@progress` without `@act`. */
  unlogged: number;
  /** Work still to do. */
  remaining: number;
  /** What the work will take: logged + done without logged hours + remaining. */
  forecast: number;
}

export interface BudgetSummary extends BudgetFigures {
  /** From project.md; undefined when no budget is set. */
  budget?: number;
  /** Hours logged on cancelled tasks and in cancelled milestones: part of spent and forecast. */
  cancelled: number;
  /** Hours logged on tasks without an estimate: part of spent and forecast, not of planned. */
  unplanned: number;
  /** Open tasks without an estimate: the forecast does not include them yet. */
  unestimated: Task[];
  /**
   * Tasks that take more than planned, by how much (most first), and the hours planned for them:
   * a parent's are its subtasks' and what its own estimate covers of the hours logged on it.
   */
  overruns: Array<{ task: Task; hours: number; planned: number }>;
  /** Hours saved on tasks that took less than their estimate. */
  savings: number;
  milestones: Array<BudgetFigures & { id: string; title: string }>;
}

const round = (h: number) => Math.round(h * 10) / 10;

/** Work done on a leaf that counts: `@act`, else its estimate when done, or estimate × `@progress`. */
function leafDone(t: Task): number {
  const est = estimateHours(t) ?? 0;
  if (isEffectivelyDone(t)) return t.act ?? est;
  return t.act ?? (t.progress !== undefined ? est * t.progress : 0);
}

/**
 * Hours logged on a parent that its own `@est` covers: as much as its estimated subtasks leave of
 * it. Its unestimated subtasks share only what is left after them (see assignBudgets), so these
 * hours are part of the plan; the rest of what was logged on it is more than estimated.
 */
export function loggedWithinEstimate(parent: Task): number {
  if (parent.est === undefined || !parent.act) return 0;
  return Math.max(0, Math.min(parent.act, parent.est - budgetSplit(parent).estimated));
}

export function budgetSummary(plan: Plan): BudgetSummary {
  const counts = (t: Task) => isSchedulableTask(plan, t);
  const figures = (tasks: Task[]): BudgetFigures => {
    let planned = 0;
    let spent = 0;
    let unlogged = 0;
    let remaining = 0;
    let forecast = 0;
    for (const t of tasks) {
      const act = t.act ?? 0;
      spent += act;
      // Cancelled work and parents add the hours logged on them.
      if (!counts(t) || !isLeaf(t)) {
        forecast += act;
        if (counts(t)) planned += loggedWithinEstimate(t);
        continue;
      }
      const done = leafDone(t);
      const left = remainingHours(t);
      planned += estimateHours(t) ?? 0;
      unlogged += done - act;
      remaining += left;
      forecast += done + left;
    }
    return {
      planned: round(planned),
      spent: round(spent),
      unlogged: round(unlogged),
      remaining: round(remaining),
      forecast: round(forecast),
    };
  };
  const counted = plan.tasks.filter(counts);
  const overruns: BudgetSummary["overruns"] = [];
  /**
   * Collects the overruns of a task and its subtasks; returns the hours planned for them and what
   * they save. Hours logged on a parent beyond what its estimate covers come out of what its
   * subtasks save first: a parent takes longer than planned only when all of it does. Work
   * without an estimate is neither over nor under one.
   */
  const walk = (t: Task): { planned: number; saved: number } => {
    let planned: number;
    let diff: number;
    if (isLeaf(t)) {
      const est = estimateHours(t);
      if (est === undefined) return { planned: 0, saved: 0 };
      planned = est;
      diff = leafDone(t) + remainingHours(t) - est;
    } else {
      const within = loggedWithinEstimate(t);
      let saved = 0;
      planned = within;
      for (const c of activeChildren(t)) {
        const r = walk(c);
        planned += r.planned;
        saved += r.saved;
      }
      if (estimateHours(t) === undefined) return { planned, saved };
      diff = (t.act ?? 0) - within - saved;
    }
    if (diff > 0.05) overruns.push({ task: t, hours: round(diff), planned: round(planned) });
    return { planned, saved: diff < -0.05 ? -diff : 0 };
  };
  const savings = counted.filter((t) => !t.parent).reduce((sum, t) => sum + walk(t).saved, 0);
  overruns.sort((a, b) => b.hours - a.hours || a.task.order - b.task.order);
  const logged = (tasks: Task[]) => round(tasks.reduce((sum, t) => sum + (t.act ?? 0), 0));
  return {
    budget: plan.project.budget,
    ...figures(plan.tasks),
    cancelled: logged(plan.tasks.filter((t) => !counts(t))),
    unplanned: logged(counted.filter((t) => estimateHours(t) === undefined)),
    unestimated: counted.filter(
      (t) => isLeaf(t) && !isEffectivelyDone(t) && estimateHours(t) === undefined
    ),
    overruns,
    savings: round(savings),
    milestones: plan.milestones
      .filter((m) => m.status !== "cancelled")
      .map((m) => ({
        id: m.id,
        title: m.title,
        ...figures(plan.tasks.filter((t) => t.milestoneId === m.id)),
      })),
  };
}

/**
 * Why the forecast is over the budget, in plain words, biggest cause first: estimates that already
 * add up to more than the budget, tasks taking longer than estimated (blocked ones named as
 * such), hours logged on cancelled work and on work without an estimate, and open tasks that have
 * no estimate yet. Empty when within the budget or without one.
 */
export function overBudgetReasons(s: BudgetSummary): string[] {
  if (s.budget === undefined || s.forecast <= s.budget) return [];
  const h = (n: number) => `${Math.round(n)} h`;
  const out: string[] = [];
  if (s.planned > s.budget)
    out.push(
      `The estimates add up to ${h(s.planned)}, ${h(s.planned - s.budget)} over the budget.`
    );
  else out.push(`The estimates add up to ${h(s.planned)}, within the budget.`);
  const over = s.overruns.reduce((sum, o) => sum + o.hours, 0);
  if (over > 0) {
    const names = s.overruns
      .slice(0, 4)
      .map(
        (o) =>
          `${o.task.id ?? o.task.title} +${h(o.hours)}${o.task.status === "blocked" ? " (blocked)" : ""}`
      )
      .join(", ");
    const more = s.overruns.length > 4 ? ` and ${s.overruns.length - 4} more` : "";
    out.push(`Tasks taking longer than estimated add ${h(over)}: ${names}${more}.`);
  }
  if (Math.round(s.cancelled) > 0)
    out.push(`Cancelled tasks add the ${h(s.cancelled)} logged on them.`);
  if (Math.round(s.unplanned) > 0)
    out.push(`Tasks without an estimate add the ${h(s.unplanned)} logged on them.`);
  if (s.savings > 0) out.push(`Tasks done in less than their estimate save ${h(s.savings)}.`);
  if (s.unestimated.length)
    out.push(
      `${s.unestimated.length} open task(s) have no estimate yet, so the forecast will grow: ${s.unestimated
        .slice(0, 4)
        .map((t) => t.id ?? t.title)
        .join(", ")}${s.unestimated.length > 4 ? ", …" : ""}.`
    );
  return out;
}

export interface BlockedImpact {
  task: Task;
  /** Work left on the blocked task itself. */
  hours: number;
  /** Open tasks that wait for it (directly or further down the chain), and their remaining work. */
  waiting: Task[];
  waitingHours: number;
  /**
   * It has no more room than the critical path: it is on it (once its slack is used up, every day
   * blocked moves the end date), or its owner's hours end so soon that it can wait no longer.
   */
  critical: boolean;
  /** The last working day it can stay blocked without delaying anything; undefined if unknown. */
  until?: string;
  /** Already later than that: it is holding the plan up now. */
  late: boolean;
  /**
   * Set when its owner's working hours end (`capacityFrom: … 0h`) and that sets `until`;
   * `tooLate` when its work no longer fits in the hours they have left, even if unblocked now.
   */
  ownerHoursEnd?: { name: string; from: string; tooLate: boolean };
}

/**
 * What each blocked task holds up. The schedule plans blocked tasks as if they could go ahead;
 * this says how long they can stay blocked before something moves: their latest start (scheduled
 * start plus slack, and early enough for owners whose hours end to do the work before then), and
 * the work that waits for them.
 */
export function blockedImpact(plan: Plan, schedule: Schedule): BlockedImpact[] {
  const graph = schedule.graph;
  const cal = schedule.calendar;
  const out: BlockedImpact[] = [];
  const blockedTasks = plan.tasks.filter(
    (t) => t.status === "blocked" && !isEffectivelyCancelled(t)
  );
  if (blockedTasks.length === 0) return out;
  const groupsOf = new Map<Task, DepNode[]>();
  for (const g of graph.groups.values())
    for (const m of g.members) groupsOf.set(m, [...(groupsOf.get(m) ?? []), g]);
  const lastForOwners = ownerHoursBound(plan, schedule);
  // The slack of the critical path (as computeCriticalPath works it out).
  let least: number | undefined;
  for (const ts of schedule.tasks.values())
    if (ts.slack !== undefined && (least === undefined || ts.slack < least)) least = ts.slack;
  const criticalSlack = Math.max(0, least ?? 0);
  for (const blocked of blockedTasks) {
    const leaves = isLeaf(blocked) ? [blocked] : leavesOf(blocked);
    const own = new Set(leaves);
    // Everything that waits for one of its leaves, through tasks, parents and milestones; each
    // node's dependents are looked at once.
    const waiting = new Set<Task>();
    const seen = new Set<DepNode>();
    const queue = [...leaves];
    for (let i = 0; i < queue.length; i++) {
      const t = queue[i];
      const leaf = graph.leafNode.get(t);
      for (const n of [...(leaf ? [leaf] : []), ...(groupsOf.get(t) ?? [])]) {
        if (seen.has(n)) continue;
        seen.add(n);
        for (const d of graph.dependents.get(n) ?? [])
          if (!waiting.has(d) && !own.has(d)) {
            waiting.add(d);
            queue.push(d);
          }
      }
    }
    const open = [...waiting].filter((t) => !isEffectivelyDone(t) && !isEffectivelyCancelled(t));
    // It can stay blocked until the working day before its latest start (start + slack), and
    // only as long as its owners whose hours end still have the time for the work. Without slack
    // left that is the last working day before today, whatever weekday today is.
    let latest: number | undefined;
    let critical = false;
    let first: DayNumber | undefined;
    for (const l of leaves) {
      const ts = schedule.tasks.get(l);
      if (!ts || ts.done || ts.start === undefined || ts.slack === undefined) continue;
      critical ||= ts.critical;
      const from = Math.max(ts.start, schedule.start);
      first = first === undefined ? from : Math.min(first, from);
      const latestStart = cal.addWorkingDays(from, ts.slack);
      const lastOk = cal.previousWorkingDay(ts.slack < 0 ? schedule.start - 1 : latestStart - 1);
      latest = latest === undefined ? lastOk : Math.min(latest, lastOk);
    }
    // The owners' day counts when it is earlier, or too late. On the same day, as when both are
    // late, the slack's "already delaying" says more: every day blocked moves a date.
    let ownerHoursEnd: BlockedImpact["ownerHoursEnd"];
    const forOwners = lastForOwners(leaves, open);
    if (forOwners && (forOwners.tooLate || latest === undefined || forOwners.day < latest)) {
      latest = forOwners.day;
      const { name, from, tooLate, start } = forOwners;
      ownerHoursEnd = { name, from: formatDate(from), tooLate };
      // Critical too when the owner's hours leave it no more room than the critical path has.
      critical ||=
        start !== undefined &&
        first !== undefined &&
        start <= cal.addWorkingDays(first, criticalSlack);
    }
    out.push({
      task: blocked,
      hours: round(leaves.reduce((s, l) => s + remainingHours(l), 0)),
      waiting: open,
      waitingHours: round(open.reduce((s, t) => s + remainingHours(t), 0)),
      critical,
      until: latest === undefined ? undefined : formatDate(latest),
      late: latest !== undefined && latest < schedule.start,
      ownerHoursEnd,
    });
  }
  return out;
}

/** The last day blocked work can wait for its owner whose hours end (see ownerHoursBound). */
interface OwnerBound {
  /** The last day it can stay blocked: before the first day of the schedule when it cannot wait. */
  day: DayNumber;
  /** The day the work has to start at the latest; undefined when too late. */
  start?: DayNumber;
  name: string;
  from: DayNumber;
  tooLate: boolean;
}

/**
 * For blocked work whose owners' hours end for good (their last capacity change is to 0 h): the
 * last day it can stay blocked and still be done before then. Per such owner, their part of it
 * and their tasks that wait for it need the hours their other work leaves free when that goes as
 * early as it can (see readyOn). Too late when the schedule could not fit their part in, even
 * with the blocked work going ahead. Undefined when no owner's hours end.
 */
function ownerHoursBound(plan: Plan, schedule: Schedule) {
  const cal = schedule.calendar;
  const graph = schedule.graph;
  const hpd = plan.project.hoursPerDay;
  const EPS = 1e-6;
  const ends = new Map<string, { name: string; from: DayNumber }>();
  for (const p of plan.people) {
    const last = p.capacityChanges[p.capacityChanges.length - 1];
    if (last?.hours === 0) ends.set(p.id.toLowerCase(), { name: p.name, from: last.from });
  }
  const placed = (ts: TaskSchedule | undefined): ts is TaskSchedule =>
    ts !== undefined && !ts.done && !ts.unscheduled && ts.finish !== undefined;
  const workOf = new Map<string, TaskSchedule[]>();
  for (const ts of schedule.tasks.values()) {
    if (!ends.has(ts.resource) || !placed(ts)) continue;
    const list = workOf.get(ts.resource);
    if (list) list.push(ts);
    else workOf.set(ts.resource, [ts]);
  }
  const tasksOf = (n: DepNode): Task[] => (n.kind === "leaf" ? [n.task] : n.members);
  /** The same person's placed work, for the work of `resource` that waits for it. */
  const samePerson = (t: Task, resource: string): TaskSchedule | undefined => {
    const ts = schedule.tasks.get(t);
    return placed(ts) && ts.resource === resource ? ts : undefined;
  };
  // The first day other work can be done: not before its `@start` (or a parent's), the day after
  // the work of others it waits for is done (with the lag, as the scheduler does it), and not
  // before the same person's work it waits for can start: that moves up too when the blocked task
  // leaves them the time. Over all it waits for, not only what held it up in the schedule.
  const ready = new Map<TaskSchedule, DayNumber>();
  // When the tasks of a parent or milestone are done at the earliest, for one person's work.
  const groupDone = new Map<DepNode, Map<string, DayNumber | undefined>>();
  const doneOn = (n: DepNode, resource: string): DayNumber | undefined => {
    const known = groupDone.get(n);
    if (known?.has(resource)) return known.get(resource);
    let day: DayNumber | undefined;
    for (const m of tasksOf(n)) {
      const same = samePerson(m, resource);
      const f = same ? ready.get(same) : schedule.tasks.get(m)?.finish;
      if (f !== undefined && (day === undefined || f > day)) day = f;
    }
    if (n.kind === "group") {
      if (known) known.set(resource, day);
      else groupDone.set(n, new Map([[resource, day]]));
    }
    return day;
  };
  const earliestDay = (ts: TaskSchedule): DayNumber => {
    let day = schedule.start;
    for (let t: Task | undefined = ts.task; t; t = t.parent) {
      const fixed = t.start ? parseDate(t.start) : undefined;
      if (fixed !== undefined && fixed > day) day = fixed;
    }
    for (const r of graph.requirements.get(ts.task) ?? []) {
      const done = doneOn(r.node, ts.resource);
      if (done === undefined) continue;
      const lag = Math.ceil(r.lagHours / hpd - EPS);
      // The same person goes on the same day; others the next day, or the lag later.
      const sameDay = lag === 0 && r.node.kind === "leaf" && samePerson(r.node.task, ts.resource);
      day = Math.max(day, sameDay ? done : lag ? cal.addWorkingDays(done + 1, lag) : done + 1);
    }
    return day;
  };
  /** The same person's work that `ts` waits for and whose first day is not known yet. */
  const before = (ts: TaskSchedule): TaskSchedule[] => {
    const out: TaskSchedule[] = [];
    for (const r of graph.requirements.get(ts.task) ?? []) {
      if (groupDone.get(r.node)?.has(ts.resource)) continue;
      for (const m of tasksOf(r.node)) {
        const same = samePerson(m, ts.resource);
        if (same && !ready.has(same)) out.push(same);
      }
    }
    return out;
  };
  // Depth first, without recursion: a long chain of one person's tasks cannot run out of stack.
  const readyOn = (root: TaskSchedule): DayNumber => {
    const stack = [root];
    const opened = new Set<TaskSchedule>();
    while (stack.length > 0) {
      const ts = stack[stack.length - 1];
      if (ready.has(ts)) stack.pop();
      else if (opened.has(ts)) {
        stack.pop();
        ready.set(ts, earliestDay(ts));
      } else {
        opened.add(ts);
        for (const p of before(ts)) if (!opened.has(p)) stack.push(p);
      }
    }
    return ready.get(root)!;
  };
  return (leaves: Task[], waiting: Task[]): OwnerBound | undefined => {
    let bound: OwnerBound | undefined;
    const own = leaves
      .map((l) => schedule.tasks.get(l))
      .filter((ts): ts is TaskSchedule => ts !== undefined && !ts.done && ends.has(ts.resource));
    for (const resource of new Set(own.map((ts) => ts.resource))) {
      const end = ends.get(resource)!;
      // Their part: the blocked work and their tasks that wait for it. Too late when the schedule
      // could not fit some of it in before their hours end.
      const part = [...leaves, ...waiting]
        .map((t) => schedule.tasks.get(t))
        .filter(
          (ts): ts is TaskSchedule => ts !== undefined && !ts.done && ts.resource === resource
        );
      let day = schedule.start - 1;
      let start: DayNumber | undefined;
      let tooLate = part.some((ts) => ts.unscheduled === "horizon");
      if (!tooLate) {
        const work = new Set(part.filter(placed));
        let need = 0;
        for (const ts of work) need += remainingHours(ts.task);
        if (need <= EPS) continue;
        // Their other work as early as it can go, day by day up to their last day: the hours it
        // leaves free.
        const days = Math.max(0, end.from - schedule.start);
        const released = new Array<number>(days).fill(0);
        for (const ts of workOf.get(resource) ?? []) {
          if (work.has(ts)) continue;
          const i = Math.max(0, readyOn(ts) - schedule.start);
          if (i < days) released[i] += remainingHours(ts.task);
        }
        let queued = 0;
        const free = released.map((hours, i) => {
          const capacity = cal.capacity(resource, schedule.start + i);
          queued += hours;
          const used = Math.min(queued, capacity);
          queued -= used;
          return capacity - used;
        });
        // Back from their last day until the free hours cover the work: its latest start.
        let i = days;
        while (need > EPS && i > 0) need -= free[--i];
        tooLate = need > EPS;
        if (!tooLate) {
          start = schedule.start + i;
          day = cal.previousWorkingDay(start - 1);
        }
      }
      if (!bound || (tooLate ? !bound.tooLate : !bound.tooLate && day < bound.day))
        bound = { day, start, ...end, tooLate };
    }
    return bound;
  };
}

/** "3 tasks (24 h) wait for it · can stay blocked until 2026-10-21" for the dashboard. */
export function describeBlockedImpact(b: BlockedImpact): string {
  const parts: string[] = [];
  if (b.waiting.length)
    parts.push(
      `${b.waiting.length} task${b.waiting.length === 1 ? "" : "s"} (${Math.round(b.waitingHours)} h) wait${b.waiting.length === 1 ? "s" : ""} for it`
    );
  const end = b.ownerHoursEnd;
  const owner = end && `${end.name} has no working hours from ${end.from} on`;
  if (b.late)
    parts.push(
      end
        ? `${end.tooLate ? "already too late" : "must be unblocked now"}: ${owner}`
        : b.critical
          ? "already delaying the end date: every day blocked moves it"
          : "already delaying the plan"
    );
  else if (b.until)
    parts.push(
      `can stay blocked until ${b.until}${owner ? ` (${owner})` : b.critical ? " (critical path: after that the end date moves)" : ""}`
    );
  return parts.join(" · ");
}

/** A warning on `budget:` in project.md when the forecast is over it, with the reasons. */
export function budgetIssues(plan: Plan): Issue[] {
  const entry = plan.project.props.entries.find((e) => e.key.toLowerCase() === "budget");
  const s = budgetSummary(plan);
  if (!entry || s.budget === undefined || s.forecast <= s.budget) return [];
  const h = (n: number) => `${Math.round(n)} h`;
  return [
    {
      file: plan.project.file,
      range: entry.valueRange,
      severity: "warning",
      code: "over-budget",
      message: `Forecast ${h(s.forecast)} is ${h(s.forecast - s.budget)} over the budget of ${h(s.budget)}. ${overBudgetReasons(s).join(" ")}`,
    },
  ];
}
