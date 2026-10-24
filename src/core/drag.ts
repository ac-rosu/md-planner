// What a Gantt drag does to the schedule, worked out before anything is written: the remaining
// hours that make a bar end on the day it was dropped, and the other tasks that move with it.
import { type DayNumber, formatDate, isoWeekday } from "./dates";
import { type DepNode } from "./graph";
import { type Task } from "./model";
import { type Plan } from "./resolve";
import { type Schedule, schedulePlan, type ScheduleOptions } from "./scheduler";

/**
 * The remaining hours (in half hours) that make `task` finish on `finish`, or as close before it as
 * possible, given everything else: the owner's other work and time off, and the dependencies.
 * Found with the scheduler itself, so the bar really ends where it was dropped. Returns the
 * schedule for those hours too.
 */
export function remainingForFinish(
  plan: Plan,
  options: ScheduleOptions,
  current: Schedule,
  task: Task,
  finish: DayNumber
): { hours: number; schedule: Schedule } {
  const ts = current.tasks.get(task);
  const cal = current.calendar;
  const from = cal.nextWorkingDay(Math.max(ts?.start ?? current.start, current.start));
  // At most: every hour the owner has from the start up to the dropped day.
  let most = 0;
  for (let d = from; d <= finish; d++) most += cal.capacity(ts?.resource ?? "unassigned", d);
  if (most <= 0)
    for (let d = from; d <= finish; d++) if (cal.isWorkingDay(d)) most += cal.hoursPerDay;
  const runs = new Map<number, Schedule>();
  const run = (halves: number): Schedule => {
    let s = runs.get(halves);
    if (!s) {
      s = schedulePlan(plan, { ...options, whatIf: { task, remaining: halves / 2 } });
      runs.set(halves, s);
    }
    return s;
  };
  const fits = (halves: number) => {
    const f = run(halves).tasks.get(task)?.finish;
    return f !== undefined && f <= finish;
  };
  let hi = Math.max(1, Math.round(most * 2));
  if (fits(hi)) return { hours: hi / 2, schedule: run(hi) };
  let lo = 1;
  if (!fits(lo)) return { hours: 0.5, schedule: run(lo) };
  // fits(lo) and not fits(hi): the largest number of half hours that still ends in time.
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return { hours: lo / 2, schedule: run(lo) };
}

export interface MovedTask {
  task: Task;
  /** Working days the finish (or, when only the start moved, the start) moved: + later, − earlier. */
  days: number;
}

/** The scheduled tasks other than `except` whose dates differ between two schedules. */
export function movedTasks(before: Schedule, after: Schedule, except: Task): MovedTask[] {
  const cal = before.calendar;
  const out: MovedTask[] = [];
  for (const [task, a] of before.tasks) {
    if (task === except || a.done) continue;
    const b = after.tasks.get(task);
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
 * for it; VV's other work: T515 (−5 d) and T516 (−5 d); 25 tasks of M2–M5, which wait for M1 to
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
    const id = m.task.id ?? `"${m.task.title}"`;
    return m.days === 0 ? id : `${id} (${m.days > 0 ? "+" : "−"}${Math.abs(m.days)} d)`;
  };
  const parts: string[] = [];
  const waits = of("waits");
  if (waits.length)
    parts.push(`${list(waits.map(name))}, which ${waits.length === 1 ? "waits" : "wait"} for it`);
  const person = of("person");
  if (person.length) {
    const owner = before.tasks.get(dragged)!.resource;
    const who =
      owner === "unassigned"
        ? "other unassigned work"
        : `${plan.personById(owner)?.name ?? owner}'s other work`;
    parts.push(`${who}: ${list(person.map(name))}`);
  }
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

/** "T1", "T1 and T2", "T1, T2, T3 and 4 more". */
function list(names: string[], shown = 3): string {
  const head = names.slice(0, shown);
  const more = names.length - head.length;
  if (more > 0) return `${head.join(", ")} and ${more} more`;
  if (head.length === 1) return head[0];
  return `${head.slice(0, -1).join(", ")} and ${head[head.length - 1]}`;
}

/** "Fri 27 Nov" style day for drag notices: the weekday matters when dragging around weekends. */
export function dragDay(day: DayNumber): string {
  const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][isoWeekday(day) - 1];
  return `${wd} ${formatDate(day)}`;
}
