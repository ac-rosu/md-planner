// Punch list view: open items grouped by severity, then owner; closed items in their own group.
import * as vscode from "vscode";
import { UNASSIGNED } from "../../core/calendar";
import { matchesFilter } from "../../core/filter";
import { isOpen, type Task } from "../../core/model";
import { type PlannerState } from "../state";
import { PUNCH_HINT, statusIcon, taskTooltip } from "./common";
import { type ViewFilter } from "./filter";

export type PunchNode =
  | { kind: "severity"; sev: string }
  | { kind: "owner"; sev: string; owner: string }
  | { kind: "closed" }
  | { kind: "item"; task: Task };

const SEVERITIES = ["A", "B", "C", ""];
const SEV_TITLE: Record<string, string> = {
  A: "Severity A – blocks acceptance",
  B: "Severity B – fix before go-live",
  C: "Severity C – may be fixed after launch",
  "": "No severity",
};

export class PunchTreeProvider implements vscode.TreeDataProvider<PunchNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<PunchNode | undefined>();
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

  private items(): Task[] {
    const f = this.filter.filter;
    return this.state.plan.punch.filter(
      (t) => !t.parent && matchesFilter(t, { ...f, milestone: undefined })
    );
  }

  getChildren(node?: PunchNode): PunchNode[] {
    const items = this.items();
    const open = items.filter((t) => isOpen(t.status));
    const ownerKey = (t: Task) => (t.owner ?? UNASSIGNED).toLowerCase();
    if (!node) {
      const out: PunchNode[] = SEVERITIES.filter((s) => open.some((t) => (t.sev ?? "") === s)).map(
        (sev) => ({ kind: "severity", sev })
      );
      if (items.length > open.length) out.push({ kind: "closed" });
      return out;
    }
    if (node.kind === "severity") {
      const inSev = open.filter((t) => (t.sev ?? "") === node.sev);
      const owners = [...new Set(inSev.map(ownerKey))];
      const order = this.state.plan.people.map((p) => p.id.toLowerCase());
      owners.sort(
        (a, b) =>
          (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) -
          (order.indexOf(b) < 0 ? 99 : order.indexOf(b))
      );
      return owners.map((owner) => ({ kind: "owner", sev: node.sev, owner }));
    }
    if (node.kind === "owner") {
      return open
        .filter((t) => (t.sev ?? "") === node.sev && ownerKey(t) === node.owner)
        .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.order - b.order)
        .map((task) => ({ kind: "item", task }));
    }
    if (node.kind === "closed") {
      return items.filter((t) => !isOpen(t.status)).map((task) => ({ kind: "item", task }));
    }
    return [];
  }

  getTreeItem(node: PunchNode): vscode.TreeItem {
    const plan = this.state.plan;
    const today = this.state.today;
    const items = this.items();
    switch (node.kind) {
      case "severity": {
        const count = items.filter((t) => isOpen(t.status) && (t.sev ?? "") === node.sev).length;
        const item = new vscode.TreeItem(
          SEV_TITLE[node.sev],
          vscode.TreeItemCollapsibleState.Expanded
        );
        item.id = `punch-sev:${node.sev}`;
        item.description = `${count} open`;
        const color =
          node.sev === "A"
            ? "charts.red"
            : node.sev === "B"
              ? "charts.orange"
              : node.sev === "C"
                ? "charts.yellow"
                : undefined;
        item.iconPath = new vscode.ThemeIcon(
          "bug",
          color ? new vscode.ThemeColor(color) : undefined
        );
        return item;
      }
      case "owner": {
        const person = plan.personById(node.owner);
        const name = person?.name ?? (node.owner === UNASSIGNED ? "Unassigned" : node.owner);
        const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `punch-owner:${node.sev}:${node.owner}`;
        item.iconPath = new vscode.ThemeIcon(node.owner === UNASSIGNED ? "question" : "person");
        item.description = String(this.getChildren(node).length);
        return item;
      }
      case "closed": {
        const item = new vscode.TreeItem("Closed", vscode.TreeItemCollapsibleState.Collapsed);
        item.id = "punch-closed";
        item.description = String(items.filter((t) => !isOpen(t.status)).length);
        item.iconPath = new vscode.ThemeIcon("pass");
        return item;
      }
      case "item": {
        const t = node.task;
        const item = new vscode.TreeItem(
          t.title || "(untitled)",
          vscode.TreeItemCollapsibleState.None
        );
        item.id = `punch:${t.id ?? `${t.file}:${t.line}`}`;
        const parts: string[] = [];
        if (t.id) parts.push(t.id);
        if (t.due) parts.push(`due ${t.due}`);
        if (t.from) parts.push(t.from);
        if (isOpen(t.status) && t.due && t.due < today) parts.push("⚠ overdue");
        item.description = parts.join(" · ");
        item.tooltip = taskTooltip(
          plan,
          t,
          [t.sev ? `Severity ${t.sev}` : "", t.from ? `From ${t.from}` : ""].filter(Boolean),
          PUNCH_HINT
        );
        item.iconPath = statusIcon(t.status);
        item.contextValue = `punch status-${t.status}`;
        item.command = {
          command: "planner.revealTask",
          title: "Reveal",
          arguments: [t.id ?? { file: t.file, line: t.line }],
        };
        return item;
      }
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
