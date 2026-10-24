// Why a task finishes when it does: the chain of what held it back, followed from the task to the
// root cause (a fixed start, or an owner busy with other work). Used in late-task messages and
// tooltips, so a single wrong date does not hide behind dozens of "late" warnings.
import { type DayNumber, formatDate, parseDate } from "./dates";
import { type Task } from "./model";
import { type Plan } from "./resolve";
import { startedOn } from "./rollup";
import { type Schedule } from "./scheduler";

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

/**
 * The root cause of a task's start, or undefined when it simply starts as soon as possible. The
 * chain of predecessors is followed to its end: a fixed start there is the cause (often a wrong
 * date); otherwise the longest wait for an owner's other work along the way.
 */
export function lateCause(schedule: Schedule, task: Task): LateCause | undefined {
  const via: string[] = [];
  const seen = new Set<Task>();
  let busy: { task: Task; resource: string; days: number; via: string[] } | undefined;
  for (let t = task; !seen.has(t);) {
    seen.add(t);
    const ts = schedule.tasks.get(t);
    if (!ts || ts.done || ts.earliest === undefined || ts.start === undefined) break;
    // Not started yet and placed later than its owner could have started it: other work first.
    const wait = startedOn(t) ? 0 : ts.start - firstWorkingDay(schedule, ts.resource, ts.earliest);
    if (wait > 0 && (!busy || wait > busy.days))
      busy = { task: t, resource: ts.resource, days: wait, via: [...via] };
    const d = ts.driver;
    if (!d) break;
    if (d.kind === "start")
      return {
        kind: "start",
        task: d.from,
        day: parseDate(d.from.start ?? ""),
        via: trimRoot(via, d.from),
      };
    const step =
      typeof d.declaredBy === "string" && d.on.milestoneId !== t.milestoneId
        ? (d.on.milestoneId ?? d.on.id ?? d.on.title)
        : (d.on.id ?? d.on.title);
    if (via[via.length - 1] !== step) via.push(step);
    t = d.on;
  }
  return busy
    ? { kind: "busy", task: busy.task, resource: busy.resource, via: trimRoot(busy.via, busy.task) }
    : undefined;
}

/** The chain without its last link when that is the root task itself. */
function trimRoot(via: string[], root: Task): string[] {
  return via[via.length - 1] === (root.id ?? root.title) ? via.slice(0, -1) : via;
}

function firstWorkingDay(schedule: Schedule, resource: string, from: DayNumber): DayNumber {
  for (let d = from; d < from + 366; d++) if (schedule.calendar.capacity(resource, d) > 0) return d;
  return from;
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
