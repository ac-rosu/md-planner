// The effects of a status change on subtasks and parents, shared by every place that changes a
// status: commands, the checkbox hover and click, the Kanban board, the timer and the task form.
import * as vscode from "vscode";
import { type Status, type Task } from "../../core/model";
import { openSubtasks } from "../../core/rollup";
import { type StatusEffects, type SubtaskChoice } from "../../core/writer";
import { config } from "../util";

export const SUBTASK_CHOICES: readonly SubtaskChoice[] = ["done", "cancelled", "keep"];

/** True when parents follow their subtasks (`planner.parentStatus`). */
export function rollUpParents(): boolean {
  return config().get<string>("parentStatus", "auto") === "auto";
}

/**
 * The effects of setting `task` to `status`. Finishing a task with open subtasks asks what happens
 * to them, unless `subtasks` says it. Undefined when the user cancels.
 */
export async function statusEffects(
  task: Task,
  status: Status,
  subtasks?: SubtaskChoice
): Promise<StatusEffects | undefined> {
  const rollUp = rollUpParents();
  if (status !== "done" || task.status === "done") return { rollUp };
  const open = openSubtasks(task);
  if (open.length === 0) return { rollUp };
  const choice = subtasks ?? (await askSubtasks(task, open));
  return choice ? { rollUp, subtasks: choice } : undefined;
}

async function askSubtasks(task: Task, open: Task[]): Promise<SubtaskChoice | undefined> {
  const names = open.map((t) => t.id ?? t.title);
  const list = `${names.slice(0, 5).join(", ")}${names.length > 5 ? ", …" : ""}`;
  const finish = "Finish them too";
  const cancel = "Cancel them";
  const keep = "Only this task";
  const pick = await vscode.window.showWarningMessage(
    `${task.id ?? task.title} has ${open.length === 1 ? "an open subtask" : `${open.length} open subtasks`} (${list}).`,
    {
      modal: true,
      detail:
        "Finish them too: they are marked done today.\nCancel them: they stay in the file as cancelled.\nOnly this task: they stay open in the file, but are no longer scheduled.",
    },
    finish,
    cancel,
    keep
  );
  return pick === finish
    ? "done"
    : pick === cancel
      ? "cancelled"
      : pick === keep
        ? "keep"
        : undefined;
}
