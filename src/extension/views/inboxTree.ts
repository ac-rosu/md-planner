// Inbox view: unplanned checkbox items from inbox.md.
import * as vscode from "vscode";
import { matchesFilter } from "../../core/filter";
import { type Task } from "../../core/model";
import { type PlannerState } from "../state";
import { statusIcon, taskTooltip } from "./common";
import { type ViewFilter } from "./filter";

export interface InboxNode {
  kind: "inbox";
  task: Task;
}

export class InboxTreeProvider implements vscode.TreeDataProvider<InboxNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<InboxNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly state: PlannerState,
    readonly filter: ViewFilter
  ) {
    this.disposables.push(
      this.emitter,
      state.onDidUpdate(() => this.emitter.fire(undefined)),
      filter.onDidChange(() => this.emitter.fire(undefined))
    );
  }

  getChildren(node?: InboxNode): InboxNode[] {
    if (node) return [];
    const f = this.filter.filter;
    return this.state.plan.inbox
      .filter((t) => !t.parent && t.status !== "done" && t.status !== "cancelled")
      .filter((t) => matchesFilter(t, { ...f, milestone: undefined }))
      .map((t) => ({ kind: "inbox", task: t }));
  }

  getTreeItem(node: InboxNode): vscode.TreeItem {
    const t = node.task;
    const item = new vscode.TreeItem(t.title || "(untitled)", vscode.TreeItemCollapsibleState.None);
    item.id = `inbox:${t.line}:${t.title}`;
    const parts = [...t.tags.map((x) => `#${x.tag}`)];
    if (t.owner) parts.push(`@${t.owner}`);
    if (t.est !== undefined) parts.push(`${t.est}h`);
    item.description = parts.join(" ");
    item.tooltip = taskTooltip(this.state.plan, t);
    item.iconPath = statusIcon(t.status);
    item.contextValue = "inbox";
    item.command = {
      command: "planner.revealTask",
      title: "Reveal",
      arguments: [{ file: t.file, line: t.line }],
    };
    return item;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
