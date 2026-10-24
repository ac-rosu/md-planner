// The effects of a status change on subtasks and parents, shared by every place that changes a
// status: commands, the checkbox hover and click, the Kanban board, the timer and the task form.
import * as vscode from "vscode";
import { type Status, type Task } from "../../core/model";
import { describeUnfinished, unfinishedMilestoneDeps } from "../../core/queries";
import { type Plan } from "../../core/resolve";
import { openSubtasks } from "../../core/rollup";
import { startsWork, type StatusEffects, type SubtaskChoice } from "../../core/writer";
import { config } from "../util";

export const SUBTASK_CHOICES: readonly SubtaskChoice[] = ["done", "cancelled", "keep"];

/** True when parents follow their subtasks (`planner.parentStatus`). */
export function rollUpParents(): boolean {
  return config().get<string>("parentStatus", "auto") === "auto";
}

/** Answers given beforehand (command arguments, tests) instead of asking. */
export interface StatusAnswers {
  subtasks?: SubtaskChoice;
  /** Start (or finish) the task even though a milestone it waits for is not finished. */
  startEarly?: boolean;
}

/**
 * The effects of setting `task` to `status`, after the questions that apply: starting work while a
 * milestone it waits for is not finished, and finishing a task with open subtasks. Undefined when
 * the user cancels.
 */
export async function statusEffects(
  plan: Plan,
  task: Task,
  status: Status,
  answers: StatusAnswers = {}
): Promise<StatusEffects | undefined> {
  if (!answers.startEarly && !(await confirmEarlyStart(plan, task, status))) return undefined;
  const rollUp = rollUpParents();
  if (status !== "done" || task.status === "done") return { rollUp };
  const open = openSubtasks(task);
  if (open.length === 0) return { rollUp };
  const choice = answers.subtasks ?? (await askSubtasks(task, open));
  return choice ? { rollUp, subtasks: choice } : undefined;
}

/**
 * Starting (or finishing) a task whose milestone depends on an unfinished milestone asks first
 * (`planner.confirmEarlyStart`). True when there is nothing to ask or the user goes ahead.
 */
export async function confirmEarlyStart(plan: Plan, task: Task, status: Status): Promise<boolean> {
  if (task.kind !== "task" || !startsWork(task, status)) return true;
  if (!config().get<boolean>("confirmEarlyStart", true)) return true;
  const waiting = unfinishedMilestoneDeps(plan, task.milestoneId);
  if (waiting.length === 0) return true;
  const go = status === "done" ? "Mark done anyway" : "Start anyway";
  const name = task.id ?? task.title;
  const pick = await vscode.window.showWarningMessage(
    `${task.milestoneId} waits for ${describeUnfinished(waiting)}. ${status === "done" ? `Mark ${name} done` : `Start ${name}`} anyway?`,
    {
      modal: true,
      detail: `${task.milestoneId} depends on ${waiting.map((w) => w.id).join(" and ")}, so its work is planned after ${waiting.length === 1 ? "it" : "them"}. Go ahead if the work really begins now; the task is then shown as started early.`,
    },
    go
  );
  return pick === go;
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
