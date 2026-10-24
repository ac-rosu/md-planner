// Reorganizing tasks without breaking the outline: move up and down, indent and outdent (commands,
// Alt+arrows in plan files and in the Milestones view) and drag and drop in the Milestones view.
// A task always moves as a block with its notes and subtasks.
import * as vscode from "vscode";
import { type Task } from "../../core/model";
import { findTaskByKey, taskKey } from "../../core/scheduler";
import { type FileEdit } from "../../core/writer";
import {
  outlineMove,
  type OutlineMove,
  placeTask,
  type Placement,
} from "../../core/writer/structure";
import { confirmNoNewErrors } from "../guard";
import { type PlanService } from "../planService";
import { type PlannerState } from "../state";
import { type MilestoneNode } from "../views/milestonesTree";
import { itemAtLine, resolveTask, type TaskArg } from "./args";
import { moveTaskCommand, pickSection } from "./edit";

const MOVES: Array<[string, OutlineMove]> = [
  ["planner.moveTaskUp", "up"],
  ["planner.moveTaskDown", "down"],
  ["planner.indentTask", "indent"],
  ["planner.outdentTask", "outdent"],
];

/** VS Code's own line moves, used by Alt+Up/Down on lines that are not task lines. */
const LINE_MOVES: Partial<Record<OutlineMove, string>> = {
  up: "editor.action.moveLinesUpAction",
  down: "editor.action.moveLinesDownAction",
};

/** Items that can be reordered: tasks, punch items and inbox items (not test steps). */
function movable(t: Task | undefined): t is Task {
  return !!t && t.kind !== "step";
}

export function registerOutlineCommands(
  state: PlannerState,
  view: vscode.TreeView<MilestoneNode>
): vscode.Disposable[] {
  return MOVES.map(([id, move]) =>
    vscode.commands.registerCommand(id, (arg?: unknown) => outlineCommand(state, view, move, arg))
  );
}

/**
 * Runs an outline move on the task given as argument, the task selected in the Milestones view
 * (`"tree"`, from its keybindings) or the task line under the cursor (`"editor"`: Alt+Up/Down,
 * which fall back to VS Code's line moves anywhere else).
 */
export async function outlineCommand(
  state: PlannerState,
  view: vscode.TreeView<MilestoneNode>,
  move: OutlineMove,
  arg?: unknown
): Promise<boolean> {
  const service = state.service;
  let task: Task | undefined;
  let editor: vscode.TextEditor | undefined;
  if (arg === "editor") {
    editor = vscode.window.activeTextEditor;
    const sel = editor?.selection;
    const rel = editor ? service.relPath(editor.document.uri) : undefined;
    const t =
      rel !== undefined && sel && sel.start.line === sel.end.line
        ? itemAtLine(service.plan, rel, sel.active.line)
        : undefined;
    if (!movable(t) || t.line !== sel?.active.line) {
      const lineMove = LINE_MOVES[move];
      if (lineMove) await vscode.commands.executeCommand(lineMove);
      return false;
    }
    task = t;
  } else if (arg === "tree") {
    const node = view.selection[0];
    task = node?.kind === "task" ? node.task : undefined;
  } else {
    const r = resolveTask(service, arg as TaskArg);
    task = r?.task;
    if (r?.fromEditor) editor = vscode.window.activeTextEditor;
  }
  if (!movable(task)) {
    void vscode.window.showWarningMessage("Planner: select a task to move.");
    return false;
  }
  const file = service.plan.file(task.file);
  if (!file) return false;
  const r = outlineMove(file, task, move);
  if ("reason" in r) {
    void vscode.window.setStatusBarMessage(`$(info) ${r.reason}`, 5000);
    return false;
  }
  // Up and down keep the parent, so they cannot add errors; a new parent can (its dependencies).
  const check = move === "indent" || move === "outdent";
  return applyMove(state, task, r.edits, { editor, check });
}

/**
 * Applies a move (after asking, when `check` finds it would add errors) and keeps the task in view:
 * the cursor follows it, or the tree reveals it.
 */
async function applyMove(
  state: PlannerState,
  task: Task,
  edits: FileEdit[],
  options: { editor?: vscode.TextEditor; check: boolean }
): Promise<boolean> {
  const service = state.service;
  const editor = options.editor;
  if (
    options.check &&
    !(await confirmNoNewErrors(service, edits, `Moving ${task.id ?? task.title}`))
  )
    return false;
  const column = editor ? editor.selection.active.character - task.indentText.length : 0;
  const ok = await service.apply(edits, { source: editor ? "editor" : "view" });
  if (!ok) return false;
  const moved = task.id ? findTaskByKey(service.plan, task.id) : undefined;
  if (editor && moved) {
    const at = new vscode.Position(moved.line, Math.max(0, moved.indentText.length + column));
    editor.selection = new vscode.Selection(at, at);
    editor.revealRange(new vscode.Range(at, at));
  } else if (moved) {
    service.fireNow();
    await vscode.commands
      .executeCommand("planner.revealInTree", { task: moved.id })
      .then(undefined, () => undefined);
  }
  return true;
}

const MIME = "application/vnd.code.tree.planner.milestones";

/**
 * Drag and drop in the Milestones view. Dropping a task on another task asks where it goes (before,
 * after, or as a subtask), so nothing becomes a subtask by accident; dropping it on a section or a
 * milestone moves it there.
 */
export class MilestonesDragAndDrop implements vscode.TreeDragAndDropController<MilestoneNode> {
  readonly dragMimeTypes = [MIME];
  readonly dropMimeTypes = [MIME];

  constructor(private readonly state: PlannerState) {}

  handleDrag(source: readonly MilestoneNode[], data: vscode.DataTransfer): void {
    const keys = source.flatMap((n) => (n.kind === "task" ? [taskKey(n.task)] : []));
    if (keys.length) data.set(MIME, new vscode.DataTransferItem(keys));
  }

  async handleDrop(target: MilestoneNode | undefined, data: vscode.DataTransfer): Promise<void> {
    const keys = data.get(MIME)?.value as string[] | undefined;
    if (!keys?.length || !target) return;
    if (keys.length > 1) {
      void vscode.window.showInformationMessage("Planner: drag one task at a time.");
      return;
    }
    const service = this.state.service;
    const task = findTaskByKey(service.plan, keys[0]);
    if (!task) return;
    if (target.kind === "task") {
      await this.dropOnTask(service, task, target.task);
      return;
    }
    const m = target.milestone;
    let section = target.kind === "milestone" ? undefined : target.section?.title;
    if (target.kind === "milestone" && m.sections.length) {
      section = await pickSection(m, `Move ${task.id ?? task.title} – to which section?`);
      if (section === undefined) return;
    }
    await moveTaskCommand(service, task.id ?? { file: task.file, line: task.line }, {
      milestone: m.id,
      section: section || undefined,
    });
  }

  private async dropOnTask(service: PlanService, task: Task, target: Task): Promise<void> {
    if (task === target) return;
    const name = `${target.id ?? ""} ${target.title}`.trim();
    const upward = task.file === target.file ? task.line > target.line : task.order > target.order;
    const items: Array<vscode.QuickPickItem & { placement: Placement }> = [
      { label: `$(arrow-up) Before ${name}`, placement: "before" },
      { label: `$(arrow-down) After ${name}`, placement: "after" },
      {
        label: `$(indent) As a subtask of ${name}`,
        description: "the last of its subtasks",
        placement: "child",
      },
    ];
    // The usual intent first: dragging up places it before, dragging down after.
    if (!upward) [items[0], items[1]] = [items[1], items[0]];
    const pick = await vscode.window.showQuickPick(items, {
      title: `Move ${task.id ?? task.title} · ${task.title}`,
      placeHolder: "Where does the task go? It moves with its notes and subtasks.",
    });
    if (!pick) return;
    const plan = service.plan;
    const current = findTaskByKey(plan, taskKey(task));
    const dest = findTaskByKey(plan, taskKey(target));
    if (!current || !dest) return;
    const r = placeTask(plan, current, dest, pick.placement);
    if ("reason" in r) {
      void vscode.window.showWarningMessage(`Planner: ${r.reason}`);
      return;
    }
    await applyMove(this.state, current, r.edits, { check: true });
  }
}
