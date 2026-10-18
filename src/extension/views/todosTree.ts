// TODOs in code view: file → TODO / FIXME / HACK comments, with links to promoted tasks.
import * as vscode from "vscode";
import { STATUS_LABEL } from "../../core/model";
import { type TodoItem } from "../../core/todos";
import { type PlannerState } from "../state";
import { type TodoFile, type TodoScanner } from "../todoScanner";

export type TodoNode =
  { kind: "file"; file: TodoFile } | { kind: "todo"; file: TodoFile; item: TodoItem };

const ICONS: Record<string, string> = { TODO: "checklist", FIXME: "bug", HACK: "tools" };

export class TodosTreeProvider implements vscode.TreeDataProvider<TodoNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TodoNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly scanner: TodoScanner,
    private readonly state: PlannerState
  ) {
    this.disposables.push(
      this.emitter,
      scanner.onDidChange(() => this.emitter.fire(undefined)),
      state.onDidUpdate(() => this.emitter.fire(undefined))
    );
  }

  getChildren(node?: TodoNode): TodoNode[] {
    if (!node) return this.scanner.all.map((file) => ({ kind: "file", file }));
    if (node.kind === "file")
      return node.file.items.map((item) => ({ kind: "todo", file: node.file, item }));
    return [];
  }

  getTreeItem(node: TodoNode): vscode.TreeItem {
    if (node.kind === "file") {
      const item = new vscode.TreeItem(node.file.path, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `todo-file:${node.file.uri.toString()}`;
      item.resourceUri = node.file.uri;
      item.iconPath = vscode.ThemeIcon.File;
      item.description = String(node.file.items.length);
      return item;
    }
    const t = node.item;
    const task = t.taskId ? this.state.plan.taskById(t.taskId) : undefined;
    const item = new vscode.TreeItem(
      `${t.keyword}: ${t.text}`,
      vscode.TreeItemCollapsibleState.None
    );
    item.id = `todo:${node.file.uri.toString()}:${t.line}`;
    const parts = [`line ${t.line + 1}`];
    if (t.taskId)
      parts.push(
        task
          ? `→ ${t.taskId} ${STATUS_LABEL[task.status].toLowerCase()}`
          : `→ ${t.taskId} (unknown task)`
      );
    item.description = parts.join(" · ");
    item.iconPath = new vscode.ThemeIcon(
      t.taskId ? "link" : (ICONS[t.keyword] ?? "note"),
      task?.status === "done" ? new vscode.ThemeColor("charts.green") : undefined
    );
    item.tooltip = new vscode.MarkdownString(
      `**${t.keyword}** ${t.text}\n\n${node.file.path}:${t.line + 1}` +
        (task ? `\n\nLinked to **${task.id}** · ${task.title} (${STATUS_LABEL[task.status]})` : "")
    );
    item.contextValue = t.taskId ? "todo-linked" : "todo";
    item.command = {
      command: "vscode.open",
      title: "Open",
      arguments: [
        node.file.uri,
        { selection: new vscode.Range(t.line, t.column, t.line, t.column) },
      ],
    };
    return item;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
