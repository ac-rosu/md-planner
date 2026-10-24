// Moving tasks within the outline: up and down among their siblings, into the task above (indent)
// or out of their parent (outdent), and next to or under any task. A task always moves as a block
// with its notes and subtasks, so the structure below it stays intact.
import { type ParsedFile, type Task } from "../model";
import { type Plan } from "../resolve";
import { type FileEdit, type InsertLocation, moveTask } from "./index";

export type OutlineMove = "up" | "down" | "indent" | "outdent";

/** Tasks at the same level: the parent's children, or the top-level tasks of the same section. */
export function siblingsOf(file: ParsedFile, task: Task): Task[] {
  if (task.parent) return task.parent.children;
  return file.roots.filter((t) => t.sectionLine === task.sectionLine);
}

/**
 * The edits of an outline move, or a reason why it is not possible (first task, no parent …).
 * Up and down swap the task with its neighbour; indent makes it the last subtask of the task
 * above; outdent puts it right after its parent.
 */
export function outlineMove(
  file: ParsedFile,
  task: Task,
  move: OutlineMove
): { edits: FileEdit[] } | { reason: string } {
  const siblings = siblingsOf(file, task);
  const i = siblings.indexOf(task);
  const name = task.id ?? task.title;
  const at = (location: InsertLocation) => ({ edits: moveTask(file, task, file, location) });
  switch (move) {
    case "up":
      return i > 0
        ? at({ kind: "before", task: siblings[i - 1] })
        : { reason: `${name} is already the first task at its level.` };
    case "down":
      return i >= 0 && i < siblings.length - 1
        ? at({ kind: "after", task: siblings[i + 1] })
        : { reason: `${name} is already the last task at its level.` };
    case "indent":
      return i > 0
        ? at({ kind: "child", task: siblings[i - 1] })
        : { reason: `${name} has no task above it at its level to become a subtask of.` };
    case "outdent":
      return task.parent
        ? at({ kind: "after", task: task.parent })
        : { reason: `${name} is not a subtask.` };
  }
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
): { edits: FileEdit[] } | { reason: string } {
  for (let t: Task | undefined = target; t; t = t.parent)
    if (t === task)
      return { reason: `${task.id ?? task.title} cannot move into itself or its own subtasks.` };
  const source = plan.file(task.file);
  const dest = plan.file(target.file);
  if (!source || !dest) return { reason: "The file is not loaded." };
  return { edits: moveTask(source, task, dest, { kind: placement, task: target }) };
}
