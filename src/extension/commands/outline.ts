// Reorganizing tasks without breaking the outline: move up and down, indent and outdent (commands,
// Alt+arrows in plan files and in the Milestones view) and drag and drop in the Milestones view.
// A task always moves as a block with its notes and subtasks.
import * as vscode from "vscode";
import { type Task } from "../../core/model";
import { type Plan } from "../../core/resolve";
import { findTaskByKey } from "../../core/scheduler";
import { type MovedTask } from "../../core/writer";
import {
  atOneLevel,
  leavesSchedule,
  type Move,
  outlineMoveAll,
  type OutlineMove,
  placeTask,
  type Placement,
  selectedTasks,
  selectionAfterMove,
} from "../../core/writer/structure";
import { confirmNoNewErrors, confirmStillScheduled } from "../guard";
import { type PlanService } from "../planService";
import { type PlannerState } from "../state";
import { type MilestoneNode } from "../views/milestonesTree";
import { currentTask, findById, resolveTask, type TaskArg } from "./args";
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
    vscode.commands.registerCommand(id, (arg?: unknown, from?: unknown) =>
      outlineCommand(state, view, move, arg, from === "editor")
    )
  );
}

let queue: Promise<unknown> = Promise.resolve();
/** Moves that run or wait for their turn. */
let pending = 0;

/**
 * Runs moves one after the other. A held-down Alt+Down starts the next move before the last one is
 * applied; it must read the cursor or the tree selection only once they followed the moved task.
 */
function serialized<T>(run: () => Promise<T>): Promise<T> {
  pending++;
  const next = queue.then(run, run).finally(() => pending--);
  queue = next.catch(() => undefined);
  return next;
}

/**
 * Runs an outline move on the task given as argument, the task selected in the Milestones view
 * (`"tree"`, from its keybindings) or the tasks the editor's cursors and selections take
 * (`"editor"`: Alt+Up/Down, which are VS Code's line moves when one of them is on other lines).
 * Run from the editor's menus, it moves the tasks at the cursors. With `inEditor` (a quick fix), the
 * move of the given task is an edit in the active editor: not saved, and the focus stays there.
 */
export function outlineCommand(
  state: PlannerState,
  view: vscode.TreeView<MilestoneNode>,
  move: OutlineMove,
  arg?: unknown,
  inEditor = false
): Promise<boolean> {
  // Key repeat presses faster than a move is applied (from the tree it is also saved and revealed):
  // one press waits for the move before it and further presses are dropped, so a held-down key
  // stops the task when it is released. Two quick presses still both move it. Menus, the palette
  // and quick fixes always wait their turn.
  if ((arg === "tree" || arg === "editor") && pending > 1) return Promise.resolve(false);
  return serialized(() => runOutlineMove(state, view, move, arg, inEditor));
}

async function runOutlineMove(
  state: PlannerState,
  view: vscode.TreeView<MilestoneNode>,
  move: OutlineMove,
  arg: unknown,
  inEditor: boolean
): Promise<boolean> {
  const service = state.service;
  const plan = service.plan;
  let tasks: Task[] = [];
  let editor: vscode.TextEditor | undefined;
  // The tasks each of the editor's cursors and selections takes, which they stay on afterwards.
  let selected: Selected | undefined;
  if (arg === "editor") {
    editor = vscode.window.activeTextEditor;
    const picked = editor && editorTasks(service, editor, false);
    // A cursor or selection on other lines (notes, a heading, text): they move as lines.
    if (!picked || picked.tasks.some((ts, i) => ts.length === 0 || picked.other[i])) {
      const lineMove = LINE_MOVES[move];
      if (lineMove) await vscode.commands.executeCommand(lineMove);
      return false;
    }
    selected = picked;
  } else if (arg === "tree" || isTaskNode(arg)) {
    // A tree node holds the task as it was when the tree was drawn, which can be older than the
    // plan (the tree refreshes after a delay): find it again. The move refuses one the plan no
    // longer has (a task without an id, in a file changed since).
    const node = arg === "tree" ? view.selection[0] : arg;
    if (node?.kind === "task") tasks = [current(plan, node.task) ?? node.task];
  } else if (arg === undefined || arg instanceof vscode.Uri) {
    // From the editor's menu or the command palette: the tasks of all cursors and selections, or
    // the task around one.
    editor = vscode.window.activeTextEditor;
    selected = editor && editorTasks(service, editor, true);
  } else {
    const r = resolveTask(service, arg as TaskArg);
    if (r?.fromEditor || inEditor) editor = vscode.window.activeTextEditor;
    if (r) tasks = [r.task];
  }
  if (selected) tasks = [...new Set(selected.tasks.flat())];
  tasks = tasks.filter(movable);
  if (tasks.length === 0) {
    void vscode.window.showWarningMessage("Planner: select a task to move.");
    return false;
  }
  // Tasks of several levels (or sections) in one selection would each move among their own
  // siblings and end up apart, so the selection could not stay on them.
  const reason = selected?.tasks.some((ts) => !atOneLevel(ts))
    ? "The selected tasks are at different levels or in different sections: select tasks at one level, or put a cursor on each."
    : undefined;
  const r = reason ? { reason } : outlineMoveAll(plan, tasks, move);
  if ("reason" in r) {
    void vscode.window.setStatusBarMessage(`$(info) ${r.reason}`, 5000);
    return false;
  }
  // Up and down keep the parent, so they cannot add errors; a new parent can (its dependencies).
  const check = move === "indent" || move === "outdent";
  const what = `Moving ${tasks.map((t) => t.id ?? t.title).join(", ")}`;
  return applyMove(state, r, what, { editor, check, selected });
}

/** The editor's cursors and selections, and the tasks each of them takes (see selectedTasks). */
interface Selected {
  selections: readonly vscode.Selection[];
  tasks: Task[][];
  /** Whether each also takes other non-blank lines. */
  other: boolean[];
}

/** What the editor's cursors and selections take, or undefined when it shows no plan file. */
function editorTasks(
  service: PlanService,
  editor: vscode.TextEditor,
  around: boolean
): Selected | undefined {
  const rel = service.relPath(editor.document.uri);
  const file = rel === undefined ? undefined : service.plan.file(rel);
  if (!file) return undefined;
  const selections = editor.selections;
  const taken = selections.map((s) => selectedTasks(file, s, around));
  return {
    selections,
    tasks: taken.map((t) => t.tasks.filter(movable)),
    other: taken.map((t) => t.other),
  };
}

function isTaskNode(x: unknown): x is MilestoneNode & { kind: "task" } {
  return !!x && typeof x === "object" && (x as MilestoneNode).kind === "task" && "task" in x;
}

/**
 * The task as it is in the current plan: the same object; for a task with an id, the one found
 * again on its line (see currentTask), or by its id when no other item has that id (a copied line
 * keeps the id). A task without an id the plan no longer has is not guessed from its old line.
 */
function current(plan: Plan, t: Task): Task | undefined {
  if (plan.file(t.file)?.items.includes(t)) return t;
  if (!t.id) return undefined;
  const found = currentTask(plan, t);
  if (found) return found;
  const byId = findById(plan, t.id);
  return byId && argOf(plan, byId) === t.id ? byId : undefined;
}

/** The id when it names only this item, else its line: a copied line keeps the id. */
function argOf(plan: Plan, t: Task): string | { file: string; line: number } {
  const same = [...plan.tasks, ...plan.punch, ...plan.inbox].filter((x) => x.id && x.id === t.id);
  return same.length === 1 && same[0] === t ? t.id! : { file: t.file, line: t.line };
}

/**
 * A moved task once the move is applied and saved: the task with its id (without one, its title)
 * nearest to the line it landed on, as saving can still add or remove lines (a formatter).
 */
function landed(plan: Plan, m: MovedTask): Task | undefined {
  const same = (t: Task) => (m.task.id ? t.id === m.task.id : t.title === m.task.title);
  const found = plan.file(m.file)?.items.filter(same) ?? [];
  return found.sort((a, b) => Math.abs(a.line - m.line) - Math.abs(b.line - m.line))[0];
}

/**
 * Applies a move, after asking when it would take open tasks out of the schedule or (with `check`)
 * add errors, and keeps the moved tasks in view: in the editor the cursors and selections stay on
 * them, from a view the tree reveals the task.
 */
async function applyMove(
  state: PlannerState,
  move: Move,
  what: string,
  options: { editor?: vscode.TextEditor; check: boolean; selected?: Selected }
): Promise<boolean> {
  const service = state.service;
  const editor = options.editor;
  if (!(await confirmStillScheduled(move.warning))) return false;
  if (options.check && !(await confirmNoNewErrors(service, move.edits, what))) return false;
  const selections = options.selected?.selections ?? editor?.selections;
  const ok = await service.apply(move.edits, { source: editor ? "editor" : "view" });
  if (!ok) return false;
  if (editor && selections) {
    const rel = service.relPath(editor.document.uri);
    if (rel !== undefined) {
      editor.selections = selections.map((s, i) => {
        const r = selectionAfterMove(move, rel, s, options.selected?.tasks[i]);
        return new vscode.Selection(
          r.anchor.line,
          r.anchor.character,
          r.active.line,
          r.active.character
        );
      });
      editor.revealRange(editor.selection);
    }
    return true;
  }
  service.fireNow();
  const moved = move.moved[0] && landed(service.plan, move.moved[0]);
  if (moved)
    await vscode.commands
      .executeCommand("planner.revealInTree", {
        task: moved.id ?? { file: moved.file, line: moved.line },
      })
      .then(undefined, () => undefined);
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
    // As for the tree's selection, a task the plan no longer has does not move (see current).
    const plan = this.state.service.plan;
    const keys = source.flatMap((n) => {
      const t = n.kind === "task" ? current(plan, n.task) : undefined;
      if (!t) return [];
      const arg = argOf(plan, t);
      return [typeof arg === "string" ? arg : `${arg.file}#${arg.line + 1}`];
    });
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
    // In a cancelled milestone open work leaves the schedule: ask, as for a drop next to its tasks.
    if (!(await confirmStillScheduled(leavesSchedule(service.plan, [task], undefined, m.id))))
      return;
    await moveTaskCommand(service, argOf(service.plan, task), {
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
    await serialized(async () => {
      // The plan may have changed while the list was open: placeTask refuses tasks it no longer has.
      const plan = service.plan;
      const t = current(plan, task) ?? task;
      const r = placeTask(plan, t, current(plan, target) ?? target, pick.placement);
      if ("reason" in r) {
        void vscode.window.showWarningMessage(`Planner: ${r.reason}`);
        return;
      }
      await applyMove(this.state, r, `Moving ${t.id ?? t.title}`, { check: true });
    });
  }
}
