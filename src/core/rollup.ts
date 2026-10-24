// Hours, remaining work and progress for tasks, with parent roll-ups.
import { isOpen, type Task } from "./model";

/** Children that still count (cancelled subtasks are ignored). */
export function activeChildren(task: Task): Task[] {
  return task.children.filter((c) => c.status !== "cancelled");
}

/** Scheduling works on leaf tasks: items without active children. */
export function isLeaf(task: Task): boolean {
  return activeChildren(task).length === 0;
}

/** Leaf descendants (or the task itself when it is a leaf). */
export function leavesOf(task: Task): Task[] {
  if (isLeaf(task)) return [task];
  const out: Task[] = [];
  for (const c of activeChildren(task)) out.push(...leavesOf(c));
  return out;
}

/** True when a task or one of its ancestors is cancelled. */
export function isEffectivelyCancelled(task: Task): boolean {
  for (let t: Task | undefined = task; t; t = t.parent) if (t.status === "cancelled") return true;
  return false;
}

/** True when time or progress was recorded on the task itself (`@act`, `@progress`). */
export function hasLoggedWork(task: Task): boolean {
  return (task.act ?? 0) > 0 || (task.progress ?? 0) > 0;
}

/**
 * The day work started: `@started`, except on a task that is (back) to do, where it is a leftover
 * of an earlier status and the scheduler places the task itself.
 */
export function startedOn(task: Task): string | undefined {
  return task.status === "todo" ? undefined : task.started;
}

/** True when the task is done, or an ancestor is done (its open subtasks are moot). */
export function isEffectivelyDone(task: Task): boolean {
  for (let t: Task | undefined = task; t; t = t.parent) if (t.status === "done") return true;
  return false;
}

/** Estimated hours: own `@est`, else the sum of the children. Undefined when nothing is estimated. */
export function estimateHours(task: Task): number | undefined {
  if (task.est !== undefined) return task.est;
  const kids = activeChildren(task);
  if (kids.length === 0) return undefined;
  let sum = 0;
  let any = false;
  for (const c of kids) {
    const h = estimateHours(c);
    if (h !== undefined) {
      sum += h;
      any = true;
    }
  }
  return any ? sum : undefined;
}

/** Actual hours: own `@act` plus the children's. */
export function actualHours(task: Task): number {
  let sum = task.act ?? 0;
  for (const c of activeChildren(task)) sum += actualHours(c);
  return sum;
}

/**
 * Remaining work in hours. Leaves: `est − act`, or `est × (1 − progress)` when `@progress` is set,
 * never below 0; 0 for done and cancelled tasks. Parents: sum of their leaves.
 */
export function remainingHours(task: Task): number {
  if (!isLeaf(task)) {
    if (!isOpen(task.status)) return 0;
    let sum = 0;
    for (const c of activeChildren(task)) sum += remainingHours(c);
    return sum;
  }
  if (!isOpen(task.status) || isEffectivelyDone(task)) return 0;
  const est = task.est ?? 0;
  if (task.progress !== undefined) return Math.max(0, est * (1 - task.progress));
  return Math.max(0, est - (task.act ?? 0));
}

/** Hours-weighted completion 0..1 of a task (done = 1). */
export function progressOf(task: Task): number {
  if (task.status === "done") return 1;
  if (task.status === "cancelled") return 0;
  if (isLeaf(task)) {
    const est = task.est ?? 0;
    if (est <= 0) return task.progress ?? 0;
    return Math.min(1, Math.max(0, 1 - remainingHours(task) / est));
  }
  let total = 0;
  let done = 0;
  for (const leaf of leavesOf(task)) {
    const est = leaf.est ?? 0;
    total += est;
    done += est * progressOf(leaf);
  }
  if (total <= 0) {
    const leaves = leavesOf(task);
    return leaves.filter((l) => l.status === "done").length / Math.max(1, leaves.length);
  }
  return done / total;
}

/** Progress of a set of leaf tasks, hours-weighted (falls back to counts when nothing is estimated). */
export function progressOfLeaves(leaves: Task[]): number {
  let total = 0;
  let done = 0;
  let count = 0;
  let doneCount = 0;
  for (const l of leaves) {
    if (l.status === "cancelled") continue;
    count++;
    if (l.status === "done") doneCount++;
    const est = l.est ?? 0;
    total += est;
    done += est * progressOf(l);
  }
  if (total > 0) return done / total;
  return count === 0 ? 0 : doneCount / count;
}

/** Effective owner: own `@owner` or the nearest ancestor's. */
export function ownerOf(task: Task): string | undefined {
  for (let t: Task | undefined = task; t; t = t.parent) if (t.owner) return t.owner;
  return undefined;
}

/** Owner initials for compact display (`alex` → `AL`, `robin-lee` → `RL`). */
export function initials(nameOrId: string): string {
  const parts = nameOrId.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return nameOrId.slice(0, 2).toUpperCase();
}
