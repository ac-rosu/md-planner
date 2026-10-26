// Resolves command arguments (tree nodes, ids, {file, line} or the editor cursor) to plan items.
import * as vscode from "vscode";
import { type ParsedFile, type Task } from "../../core/model";
import { type Plan } from "../../core/resolve";
import { findTaskByKey } from "../../core/scheduler";
import { type PlanService, serviceOf } from "../planService";

/** How the lines of plan files moved since items were parsed (PlanService.lineIn, addedAfter). */
export interface LineHistory {
  lineIn(file: ParsedFile, t: Task): number | null | undefined;
  addedAfter(file: ParsedFile, line: number, t: Task): boolean | undefined;
}

export type TaskArg =
  | string
  | {
      id?: string;
      key?: string;
      file?: string;
      line?: number;
      kind?: string;
      task?: Task;
      /** The call comes from the editor (the checkbox hover): an editor edit, not saved. */
      fromEditor?: boolean;
    }
  | undefined;

export interface ResolvedTask {
  task: Task;
  /** True when the command was invoked from the editor (the cursor, a hover), not from a view. */
  fromEditor: boolean;
}

export function resolveTask(service: PlanService, arg: TaskArg): ResolvedTask | undefined {
  const plan = service.plan;
  if (typeof arg === "string") {
    const t = findById(plan, arg) ?? findTaskByKey(plan, arg);
    return t ? { task: t, fromEditor: false } : undefined;
  }
  if (arg && typeof arg === "object") {
    // Tree nodes hold the item itself. Its id only helps when no other item has it: a copied
    // line keeps the id. Not whatever is on its line now: that is another item.
    if (arg.task) {
      const t = currentOrMovedTask(plan, arg.task);
      return t ? { task: t, fromEditor: false } : undefined;
    }
    const fromEditor = arg.fromEditor === true;
    if (arg.id) {
      const t = findById(plan, arg.id);
      return t ? { task: t, fromEditor } : undefined;
    }
    // Webview context menus (Gantt bars, Kanban cards) pass the task key: an id or `file#line`.
    if (arg.key) {
      const t = findTaskByKey(plan, arg.key);
      return t ? { task: t, fromEditor } : undefined;
    }
    if (arg.file !== undefined && arg.line !== undefined) {
      const t = findAt(plan, arg.file, arg.line);
      return t ? { task: t, fromEditor } : undefined;
    }
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const rel = service.relPath(editor.document.uri);
  if (rel === undefined) return undefined;
  const t = itemAtLine(plan, rel, editor.selection.active.line);
  return t ? { task: t, fromEditor: true } : undefined;
}

export function findById(plan: Plan, id: string): Task | undefined {
  return plan.taskById(id) ?? plan.punchById(id) ?? plan.inbox.find((t) => t.id === id);
}

/**
 * currentTask, or, for an item that moved to another file (its file has no item with its kind and
 * title any more), the item with its id when no other item has that id, and it is not known to
 * have been there before the item was parsed (the original of a deleted copy is another item).
 */
export function currentOrMovedTask(plan: Plan, t: Task): Task | undefined {
  const history = serviceOf(plan);
  const found = currentTask(plan, t, history);
  if (found || !t.id) return found;
  const stayed = plan.file(t.file)?.items.some((x) => x.kind === t.kind && x.title === t.title);
  const moved = stayed ? undefined : onlyWithId(plan, t.id);
  const file = moved && plan.file(moved.file);
  if (!moved || !file) return undefined;
  // Only a line known to be added since: otherwise it is another item with that id.
  return history?.addedAfter(file, moved.line, t) === true ? moved : undefined;
}

function onlyWithId(plan: Plan, id: string): Task | undefined {
  const all = [...plan.tasks, ...plan.punch, ...plan.inbox].filter((t) => t.id === id);
  return all.length === 1 ? all[0] : undefined;
}

export function findAt(plan: Plan, file: string, line: number): Task | undefined {
  return plan.file(file)?.items.find((t) => t.line === line);
}

/**
 * An item found earlier (before a question or a form, or by a tree node) as it is in the plan now,
 * which may have been parsed again since. Where the history knows how the lines of its file moved
 * since (an open document), it is the item it followed there (see followed). Else: the only item
 * in its file that is still the same item (kind, id and title). Lines may have moved since, so
 * copies of it (a duplicated line keeps its id) cannot be told apart, not even by its line. A save
 * since may have given it an id: every item without one gets one, and so does a copied line whose
 * title differs from every other item with its id (renumberCopiedIds). Then it is the item on its
 * line with its kind and title, when no other item in its file has them. Never just the first item
 * with its id, as a copied line keeps the id. Undefined when it is gone or cannot be told apart.
 */
export function currentTask(
  plan: Plan,
  t: Task,
  history: LineHistory | undefined
): Task | undefined {
  const file = plan.file(t.file);
  if (!file) return undefined;
  const items = file.items;
  if (items.includes(t)) return t;
  const line = history?.lineIn(file, t);
  if (history && line !== undefined) return followed(history, file, t, line);
  const like = (x: Task) => x.kind === t.kind && x.title === t.title;
  const same = (x: Task) => like(x) && x.id === t.id;
  const matches = items.filter(same);
  const at = items.find((x) => x.line === t.line);
  if (matches.length > 1) return undefined;
  if (matches.length === 1) {
    // Elsewhere, while its line holds an item with its title or its id: that may be the item
    // itself, given a new id (the duplicate-id fix) or title, while a copy keeps the old ones. A
    // save gives ids to every item without one, so an item without an id still has none.
    const other = at && at !== matches[0] && at.kind === t.kind && t.id !== undefined;
    return other && (at.title === t.title || at.id === t.id) ? undefined : matches[0];
  }
  if (!at || !like(at) || items.filter(like).length > 1) return undefined;
  return t.id === undefined || (at.id !== undefined && renumbered(plan, t)) ? at : undefined;
}

/** True when saving gives `t` a new id as a copy: other items have its id, none its title. */
function renumbered(plan: Plan, t: Task): boolean {
  const others = [...plan.tasks, ...plan.punch, ...plan.inbox].filter((x) => x.id === t.id);
  return others.length > 0 && others.every((x) => x.title !== t.title);
}

/**
 * The item `t` became, followed to `line` in its file (null: its line was deleted or replaced).
 * The item on that line, when it has its kind and its title, or its id: edits within the line may
 * rename it, and saving gives an id (a new one to a renamed copy). A line rewritten into another
 * item has neither. Without its line it was deleted or moved (cut and pasted, moved up or down):
 * the only item with its kind and title on a line added since. Not an item that was there before:
 * a copy with its id and title is another item.
 */
function followed(
  history: LineHistory,
  file: ParsedFile,
  t: Task,
  line: number | null
): Task | undefined {
  if (line !== null) {
    const at = file.items.find((x) => x.line === line);
    const same = at?.kind === t.kind && (at.title === t.title || (!!t.id && at.id === t.id));
    return same ? at : undefined;
  }
  // Moved: a cut and pasted line keeps its id.
  const moved = file.items.filter(
    (x) =>
      x.kind === t.kind &&
      x.title === t.title &&
      (!t.id || x.id === t.id) &&
      history.addedAfter(file, x.line, t)
  );
  return moved.length === 1 ? moved[0] : undefined;
}

/** currentTask() after an await, with a message when the item changed in the meantime. */
export function findAgain(plan: Plan, t: Task): Task | undefined {
  const now = currentTask(plan, t, serviceOf(plan));
  if (!now)
    void vscode.window.showWarningMessage(
      `Planner: ${t.id ?? t.title} changed in the meantime; try again.`
    );
  return now;
}

/** The innermost checkbox item whose block contains the line. */
export function itemAtLine(plan: Plan, file: string, line: number): Task | undefined {
  const items = plan.file(file)?.items ?? [];
  let best: Task | undefined;
  for (const t of items) {
    if (t.line <= line && line <= t.endLine && (!best || t.line >= best.line)) best = t;
  }
  return best;
}

/** All items selected in the editor (multi-line selections), or the item at the cursor. */
export function itemsInSelection(service: PlanService, editor: vscode.TextEditor): Task[] {
  const rel = service.relPath(editor.document.uri);
  if (rel === undefined) return [];
  const items = service.plan.file(rel)?.items ?? [];
  const out = new Set<Task>();
  for (const sel of editor.selections) {
    if (sel.isEmpty) {
      const t = itemAtLine(service.plan, rel, sel.active.line);
      if (t) out.add(t);
    } else {
      for (const t of items) if (t.line >= sel.start.line && t.line <= sel.end.line) out.add(t);
    }
  }
  return [...out];
}

/**
 * `x` when it is a plain values object passed by a caller (another command, a test), and not
 * what VS Code passes to commands run from menus and toolbars (the focused tree node, a view
 * context, the selected nodes): an object whose keys are all in `keys`, with the `required` ones
 * as strings.
 */
export function valuesArg<T>(
  x: unknown,
  keys: readonly string[],
  required: readonly string[] = []
): T | undefined {
  if (!x || typeof x !== "object" || Array.isArray(x)) return undefined;
  const o = x as Record<string, unknown>;
  if (!Object.keys(o).every((k) => keys.includes(k))) return undefined;
  if (!required.every((k) => typeof o[k] === "string")) return undefined;
  return x as T;
}

/** `x` when it is a string (menus pass tree nodes in the same position). */
export function stringArg(x: unknown): string | undefined {
  return typeof x === "string" ? x : undefined;
}
