// Read-only questions about a plan used by several views: deadlines, overdue and blocked items,
// per-person task lists and milestone progress.
import { parseDate } from "./dates";
import { isOpen, type Milestone, type Task } from "./model";
import { type Plan } from "./resolve";
import {
  actualHours,
  estimateHours,
  isEffectivelyCancelled,
  isEffectivelyDone,
  isLeaf,
  leavesOf,
  ownerOf,
  progressOfLeaves,
  remainingHours,
} from "./rollup";

/** The deadline that applies to a task: its own `@due`, else its milestone's target. */
export function deadlineOf(plan: Plan, t: Task): string | undefined {
  if (t.due) return t.due;
  for (let p = t.parent; p; p = p.parent) if (p.due) return p.due;
  return plan.milestoneById(t.milestoneId)?.target;
}

/** Open (not done/cancelled) tasks whose deadline is before today. Leaves only. */
export function overdueTasks(plan: Plan, today: string): Task[] {
  return plan.tasks.filter((t) => {
    if (!isLeaf(t) || !isOpenTask(t)) return false;
    const deadline = deadlineOf(plan, t);
    return deadline !== undefined && deadline < today;
  });
}

export function isOverdue(plan: Plan, t: Task, today: string): boolean {
  if (!isOpenTask(t)) return false;
  const deadline = deadlineOf(plan, t);
  return deadline !== undefined && deadline < today;
}

export function blockedTasks(plan: Plan): Task[] {
  return plan.tasks.filter((t) => t.status === "blocked" && !isEffectivelyCancelled(t));
}

/** Open, not cancelled, not made moot by a done ancestor. */
export function isOpenTask(t: Task): boolean {
  return isOpen(t.status) && !isEffectivelyCancelled(t) && !isEffectivelyDone(t);
}

/**
 * The milestones a milestone depends on (`depends:`) that still have open tasks, with those tasks:
 * its work should wait until they are finished.
 */
export function unfinishedMilestoneDeps(
  plan: Plan,
  milestoneId: string | undefined
): Array<{ id: string; open: Task[] }> {
  const out: Array<{ id: string; open: Task[] }> = [];
  for (const id of plan.milestoneById(milestoneId)?.depends ?? []) {
    const m = plan.milestoneById(id);
    if (!m || m.status === "cancelled") continue;
    const open = plan.tasks.filter((t) => t.milestoneId === m.id && isLeaf(t) && isOpenTask(t));
    if (open.length) out.push({ id: m.id, open });
  }
  return out;
}

/** The milestone before `m` in plan order (cancelled ones skipped). */
export function previousMilestone(plan: Plan, m: Milestone): Milestone | undefined {
  const list = plan.milestones.filter((x) => x.status !== "cancelled" || x === m);
  const i = list.indexOf(m);
  return i > 0 ? list[i - 1] : undefined;
}

/**
 * True when nothing ties a milestone to other milestones: no `depends:`, and none of its tasks
 * depends on a task elsewhere. Its work starts as soon as possible, in parallel with the rest.
 */
export function isFloatingMilestone(plan: Plan, m: Milestone): boolean {
  if (m.depends.length) return false;
  return !plan.tasks.some(
    (t) =>
      t.milestoneId === m.id &&
      t.deps.some((d) => {
        const x = plan.taskById(d.id);
        return !!x && x.milestoneId !== m.id;
      })
  );
}

/** "M1 (6 open tasks: T011, T012, …)" for messages. */
export function describeUnfinished(list: Array<{ id: string; open: Task[] }>): string {
  return list
    .map(({ id, open }) => {
      const names = open.map((t) => t.id ?? t.title);
      return `${id} (${open.length} open task${open.length === 1 ? "" : "s"}: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""})`;
    })
    .join(" and ");
}

/** Open leaf tasks assigned (directly or inherited) to a person; `unassigned` for none. */
export function openTasksOf(plan: Plan, personId: string): Task[] {
  const id = personId.toLowerCase();
  return plan.tasks.filter((t) => {
    if (!isLeaf(t) || !isOpenTask(t)) return false;
    return (ownerOf(t) ?? "unassigned").toLowerCase() === id;
  });
}

export interface MilestoneStats {
  total: number;
  done: number;
  /** Hours-weighted completion 0..1. */
  progress: number;
  estimate: number;
  actual: number;
  remaining: number;
  unestimated: number;
}

export function milestoneLeaves(m: Milestone): Task[] {
  return m.tasks.flatMap((t) => leavesOf(t)).filter((t) => !isEffectivelyCancelled(t));
}

export function milestoneStats(m: Milestone): MilestoneStats {
  const leaves = milestoneLeaves(m);
  let estimate = 0;
  let actual = 0;
  let remaining = 0;
  let unestimated = 0;
  for (const l of leaves) {
    estimate += estimateHours(l) ?? 0;
    actual += actualHours(l);
    remaining += remainingHours(l);
    if (estimateHours(l) === undefined && isOpenTask(l)) unestimated++;
  }
  return {
    total: leaves.length,
    done: leaves.filter((l) => l.status === "done" || isEffectivelyDone(l)).length,
    progress: progressOfLeaves(leaves),
    estimate,
    actual,
    remaining,
    unestimated,
  };
}

/** Short est/act text: `5/12h` (actual/estimate), `12h` when nothing was logged. */
export function hoursLabel(t: Task): string {
  const est = estimateHours(t);
  const act = actualHours(t);
  const fmt = (n: number) => String(Math.round(n * 100) / 100);
  if (est === undefined && act === 0) return "";
  if (act === 0) return `${fmt(est ?? 0)}h`;
  return `${fmt(act)}/${fmt(est ?? 0)}h`;
}

/** Days from `from` to `to` (calendar days; negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return (parseDate(to) ?? 0) - (parseDate(from) ?? 0);
}
