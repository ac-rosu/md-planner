// Resolves command arguments (tree nodes, ids, {file, line} or the editor cursor) to plan items.
import * as vscode from "vscode";
import { type Task } from "../../core/model";
import { type Plan } from "../../core/resolve";
import { findTaskByKey } from "../../core/scheduler";
import { type PlanService } from "../planService";

export type TaskArg =
  | string
  | { id?: string; key?: string; file?: string; line?: number; kind?: string; task?: Task }
  | undefined;

export interface ResolvedTask {
  task: Task;
  /** True when the command was invoked from the editor cursor (not from a view). */
  fromEditor: boolean;
}

export function resolveTask(service: PlanService, arg: TaskArg): ResolvedTask | undefined {
  const plan = service.plan;
  if (typeof arg === "string") {
    const t = findById(plan, arg) ?? findTaskByKey(plan, arg);
    return t ? { task: t, fromEditor: false } : undefined;
  }
  if (arg && typeof arg === "object") {
    if (arg.task) {
      const t = arg.task.id
        ? findById(plan, arg.task.id)
        : findAt(plan, arg.task.file, arg.task.line);
      return t ? { task: t, fromEditor: false } : undefined;
    }
    if (arg.id) {
      const t = findById(plan, arg.id);
      return t ? { task: t, fromEditor: false } : undefined;
    }
    // Webview context menus (Gantt bars, Kanban cards) pass the task key: an id or `file#line`.
    if (arg.key) {
      const t = findTaskByKey(plan, arg.key);
      return t ? { task: t, fromEditor: false } : undefined;
    }
    if (arg.file !== undefined && arg.line !== undefined) {
      const t = findAt(plan, arg.file, arg.line);
      return t ? { task: t, fromEditor: false } : undefined;
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

export function findAt(plan: Plan, file: string, line: number): Task | undefined {
  return plan.file(file)?.items.find((t) => t.line === line);
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
