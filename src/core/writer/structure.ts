// Moving tasks within the outline: up and down among their siblings, into the task above (indent)
// or out of their parent (outdent), and next to or under any task. A task always moves as a block
// with its notes and subtasks, so the structure below it stays intact.
import { isSchedulableTask } from "../graph";
import { isOpen, type ParsedFile, type Task } from "../model";
import { type Plan } from "../resolve";
import { isEffectivelyDone } from "../rollup";
import { comparePositions, pos, type Position } from "../text";
import {
  type BlockMove,
  type FileEdit,
  type InsertLocation,
  moveBlocks,
  type MovedTask,
  moveTaskTo,
  shiftedLine,
} from "./index";

export type OutlineMove = "up" | "down" | "indent" | "outdent";

/** Tasks at the same level: the parent's children, or the top-level tasks of the same section. */
export function siblingsOf(file: ParsedFile, task: Task): Task[] {
  if (task.parent) return task.parent.children;
  return file.roots.filter((t) => t.sectionLine === task.sectionLine);
}

/** True when the tasks are at one level (see siblingsOf). */
export function atOneLevel(tasks: Task[]): boolean {
  return tasks.every((t) => t.parent === tasks[0].parent && t.sectionLine === tasks[0].sectionLine);
}

/** A cursor or selection in a file: where it starts (anchor) and where the cursor is (active). */
export interface TextSelection {
  anchor: Position;
  active: Position;
}

/** The ends of a selection and its last line: one that ends at the start of a line ends before it. */
function selectedLines(sel: TextSelection): {
  start: Position;
  end: Position;
  last: number;
  reversed: boolean;
} {
  const reversed = comparePositions(sel.active, sel.anchor) < 0;
  const [start, end] = reversed ? [sel.active, sel.anchor] : [sel.anchor, sel.active];
  const last = end.line > start.line && end.character === 0 ? end.line - 1 : end.line;
  return { start, end, last, reversed };
}

/**
 * The items a cursor or selection takes: those whose task lines it covers, as VS Code's line moves
 * take lines, without the subtasks of one of them (they go along). With `around`, one that covers
 * no task line takes the item around the cursor (in a task's notes). `other` is set when it also
 * covers non-blank lines outside their blocks: the notes of the task above, a heading …
 */
export function selectedTasks(
  file: ParsedFile,
  sel: TextSelection,
  around = false
): { tasks: Task[]; other: boolean } {
  const { start, last } = selectedLines(sel);
  const on = file.items.filter((t) => t.line >= start.line && t.line <= last);
  let tasks = on.filter((t) => !on.some((p) => p.line < t.line && t.line <= p.endLine));
  if (tasks.length === 0 && around) {
    // The innermost block around the cursor (on the last selected line when it ends a selection
    // of whole lines): blocks nest, and items are in line order.
    const line = Math.min(sel.active.line, last);
    for (const t of file.items) if (t.line <= line && line <= t.endLine) tasks = [t];
  }
  let other = false;
  for (let i = start.line; i <= last && !other; i++)
    other = file.lines.line(i).trim() !== "" && !tasks.some((t) => t.line <= i && i <= t.endLine);
  return { tasks, other };
}

/** The edits of a move and where the moved tasks land. */
export interface Move {
  edits: FileEdit[];
  moved: MovedTask[];
  /** Set when the move takes open tasks out of the schedule (see leavesSchedule). */
  warning?: string;
}

/**
 * The edits of an outline move, or a reason why it is not possible (first task, no parent …).
 * Up and down swap the task with its neighbour; indent makes it the last subtask of the task
 * above; outdent puts it right after its parent.
 */
export function outlineMove(plan: Plan, task: Task, move: OutlineMove): Move | { reason: string } {
  return outlineMoveAll(plan, [task], move);
}

/**
 * An outline move of several tasks of one file, as VS Code moves the lines of several cursors:
 * consecutive siblings move together, and the subtasks of a moved task go with it. Tasks that
 * cannot move stay where they are; the reason is given when none can.
 */
export function outlineMoveAll(
  plan: Plan,
  tasks: Task[],
  move: OutlineMove
): Move | { reason: string } {
  const file = tasks.length ? plan.file(tasks[0].file) : undefined;
  if (!file || !tasks.every((t) => t.file === file.path && file.items.includes(t)))
    return { reason: "The plan changed in the meantime; try again." };
  const chosen = new Set(tasks);
  const top = [...chosen]
    .filter((t) => {
      for (let p = t.parent; p; p = p.parent) if (chosen.has(p)) return false;
      return true;
    })
    .sort((a, b) => a.line - b.line);
  const name = (t: Task) => t.id ?? t.title;
  const moves: BlockMove[] = [];
  const reasons: string[] = [];
  const warnings: string[] = [];
  const placed = new Set<Task>();
  for (const t of top) {
    if (placed.has(t)) continue;
    // The run of selected siblings that starts here. Outdent takes every selected subtask of the
    // parent: they all go right after it, in their order.
    const siblings = siblingsOf(file, t);
    const i = siblings.indexOf(t);
    let j = i;
    while (j + 1 < siblings.length && chosen.has(siblings[j + 1])) j++;
    const run =
      move === "outdent" ? siblings.filter((s) => chosen.has(s)) : siblings.slice(i, j + 1);
    for (const r of run) placed.add(r);
    let location: InsertLocation | undefined;
    switch (move) {
      case "up":
        if (i > 0) location = { kind: "before", task: siblings[i - 1] };
        else reasons.push(`${name(t)} is already the first task at its level.`);
        break;
      case "down":
        if (j < siblings.length - 1) location = { kind: "after", task: siblings[j + 1] };
        else reasons.push(`${name(siblings[j])} is already the last task at its level.`);
        break;
      case "indent":
        if (i > 0) location = { kind: "child", task: siblings[i - 1] };
        else reasons.push(`${name(t)} has no task above it at its level to become a subtask of.`);
        break;
      case "outdent":
        if (t.parent) location = { kind: "after", task: t.parent };
        else reasons.push(`${name(t)} is not a subtask.`);
        break;
    }
    if (!location) continue;
    moves.push({ tasks: run, location });
    // Up, down and outdent never put a task under a task it was not under before.
    const warning =
      location.kind === "child"
        ? leavesSchedule(plan, run, location.task, t.milestoneId)
        : undefined;
    if (warning) warnings.push(warning);
  }
  if (moves.length === 0) return { reason: reasons.join(" ") };
  const r = moveBlocks(file, moves);
  return {
    edits: [{ path: file.path, edits: r.edits }],
    moved: r.moved,
    ...(warnings.length ? { warning: warnings.join(" ") } : {}),
  };
}

export type Placement = "before" | "after" | "child";

/**
 * Moves `task` next to or under `target`, in any milestone file. Refuses to move a task into
 * itself or its own subtasks.
 */
export function placeTask(
  plan: Plan,
  task: Task,
  target: Task,
  placement: Placement
): Move | { reason: string } {
  for (let t: Task | undefined = target; t; t = t.parent)
    if (t === task)
      return { reason: `${task.id ?? task.title} cannot move into itself or its own subtasks.` };
  const source = plan.file(task.file);
  const dest = plan.file(target.file);
  if (!source || !dest) return { reason: "The file is not loaded." };
  if (!source.items.includes(task) || !dest.items.includes(target))
    return { reason: "The plan changed in the meantime; try again." };
  const r = moveTaskTo(source, task, dest, { kind: placement, task: target });
  const parent = placement === "child" ? target : target.parent;
  const warning = leavesSchedule(plan, [task], parent, target.milestoneId);
  return { edits: r.edits, moved: [r.moved], ...(warning ? { warning } : {}) };
}

/**
 * Says so when moving tasks under `parent`, in milestone `milestoneId`, takes open work out of the
 * schedule: a cancelled task or milestone cancels what is under it, and the open subtasks of a done
 * task count as finished. Their checkboxes would still look open, so the move should not happen
 * unnoticed. Undefined when nothing open would leave the schedule.
 */
export function leavesSchedule(
  plan: Plan,
  tasks: Task[],
  parent: Task | undefined,
  milestoneId: string | undefined
): string | undefined {
  // Punch and inbox items are not scheduled anyway.
  const open = tasks.filter(
    (t) =>
      t.kind === "task" && isOpen(t.status) && !isEffectivelyDone(t) && isSchedulableTask(plan, t)
  );
  if (open.length === 0) return undefined;
  const names = open.map((t) => t.id ?? t.title).join(", ");
  const where = unscheduledPlace(plan, parent, milestoneId);
  if (!where) return undefined;
  return where.under
    ? `${names} would end up under ${where.under}, and no longer be scheduled.`
    : `${names} would move into ${where.into}, and no longer be scheduled.`;
}

/**
 * Says so when a new open task under `parent`, in milestone `milestoneId`, would not be scheduled
 * (a done or cancelled task above it, a cancelled milestone): created there, it would look open
 * but never appear in the Gantt. Undefined when it would be scheduled.
 */
export function newTaskLeavesSchedule(
  plan: Plan,
  parent: Task | undefined,
  milestoneId: string,
  name: string
): string | undefined {
  const where = unscheduledPlace(plan, parent, milestoneId);
  if (!where) return undefined;
  return where.under
    ? `"${name}" would be under ${where.under}, and not be scheduled.`
    : `"${name}" would be in ${where.into}, and not be scheduled.`;
}

/** The done or cancelled task above `parent` (itself included), else the cancelled milestone. */
function unscheduledPlace(
  plan: Plan,
  parent: Task | undefined,
  milestoneId: string | undefined
): { under?: string; into?: string } | undefined {
  for (let p = parent; p; p = p.parent)
    if (p.status === "cancelled" || p.status === "done")
      return { under: `${p.id ?? p.title}, which is ${p.status}` };
  const m = plan.milestoneById(milestoneId);
  if (m?.status === "cancelled") return { into: `${m.id}, which is cancelled` };
  return undefined;
}

/**
 * Where a position in `file` is after a move: on the lines of a moved task it follows the task
 * (the column shifted with the new indentation); elsewhere it moves with the lines around it.
 */
export function positionAfterMove(move: Move, file: string, p: Position): Position {
  for (const m of move.moved) {
    const t = m.task;
    if (m.file === file && t.file === file && p.line >= t.line && p.line <= t.endLine)
      return {
        line: m.line + p.line - t.line,
        character: Math.max(0, p.character + m.indent.length - t.indentText.length),
      };
  }
  const edits = move.edits.filter((e) => e.path === file).flatMap((e) => e.edits);
  return { line: shiftedLine(edits, p.line), character: p.character };
}

/**
 * Where a cursor or selection that took `tasks` (selectedTasks) is after a move, so that it takes
 * the same tasks again and the next press moves them too, as VS Code's line moves keep their lines
 * selected. On the tasks' lines it follows them (positionAfterMove), a selection of whole lines
 * stays one of whole lines, and an end on other lines (a blank line next to the tasks …) moves to
 * the start of the tasks or right after them.
 */
export function selectionAfterMove(
  move: Move,
  file: string,
  sel: TextSelection,
  tasks: Task[] = []
): TextSelection {
  const { start, end, last, reversed } = selectedLines(sel);
  const whole = last < end.line;
  const newLine = (line: number) => positionAfterMove(move, file, pos(line, 0)).line;
  const taken = (line: number) =>
    tasks.length === 0 || tasks.some((t) => t.line <= line && line <= t.endLine);
  let from = taken(start.line)
    ? positionAfterMove(move, file, start)
    : pos(newLine(tasks[0].line), 0);
  if (whole && start.character === 0) from = pos(from.line, 0);
  let to: Position;
  if (!taken(last)) to = pos(newLine(tasks[tasks.length - 1].endLine) + 1, 0);
  else if (whole) to = pos(newLine(last) + 1, 0);
  else {
    to = positionAfterMove(move, file, end);
    // An end in indentation that Outdent removes would come to the start of its line, which the
    // selection would then no longer take.
    if (end.character > 0 && to.character === 0 && to.line > from.line) to = pos(to.line, 1);
  }
  return reversed ? { anchor: to, active: from } : { anchor: from, active: to };
}
