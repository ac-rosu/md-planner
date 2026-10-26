// Milestones view: milestone → section → task → subtask.
import * as vscode from "vscode";
import { matchesFilterDeep } from "../../core/filter";
import { type Milestone, type Section, type Task } from "../../core/model";
import { milestoneStats } from "../../core/queries";
import { type Plan } from "../../core/resolve";
import { isEmptySection } from "../../core/writer/entities";
import { type PlannerState } from "../state";
import {
  statusIcon,
  TASK_HINT,
  taskArgOf,
  taskDescription,
  taskNodeId,
  taskTooltip,
} from "./common";
import { type ViewFilter } from "./filter";

export type MilestoneNode =
  | { kind: "milestone"; milestone: Milestone }
  | { kind: "section"; milestone: Milestone; section: Section }
  | { kind: "task"; task: Task }
  /** "Add a task…" placeholder in an empty milestone or section. */
  | { kind: "add"; milestone: Milestone; section?: Section };

export class MilestonesTreeProvider
  implements vscode.TreeDataProvider<MilestoneNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<MilestoneNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly state: PlannerState,
    readonly filter: ViewFilter
  ) {
    this.disposables.push(
      this.emitter,
      state.onDidUpdate(() => this.refresh()),
      filter.onDidChange(() => this.refresh())
    );
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getChildren(node?: MilestoneNode): MilestoneNode[] {
    const plan = this.state.plan;
    const f = this.filter.filter;
    const visible = (t: Task) => matchesFilterDeep(t, f);
    if (!node) {
      return plan.milestones
        .filter(
          (m) =>
            !f.milestone?.length || f.milestone.some((x) => x.toLowerCase() === m.id.toLowerCase())
        )
        .filter((m) => this.isUnfiltered() || m.tasks.some(visible))
        .map((m): MilestoneNode => ({ kind: "milestone", milestone: m }));
    }
    if (node.kind === "milestone") {
      const m = node.milestone;
      const unfiltered = this.isUnfiltered();
      const out: MilestoneNode[] = m.rootTasks
        .filter(visible)
        .map((t): MilestoneNode => ({ kind: "task", task: t }));
      for (const s of m.sections) {
        if (
          s.tasks.length === 0
            ? !unfiltered || !this.isNewSection(m, s)
            : !unfiltered && !s.tasks.some(visible)
        )
          continue;
        out.push({ kind: "section", milestone: m, section: s });
      }
      // An empty milestone offers to add its first task.
      if (unfiltered && m.tasks.length === 0) out.unshift({ kind: "add", milestone: m });
      return out;
    }
    if (node.kind === "section") {
      const tasks = node.section.tasks
        .filter(visible)
        .map((t): MilestoneNode => ({ kind: "task", task: t }));
      if (tasks.length === 0 && this.isUnfiltered())
        return [{ kind: "add", milestone: node.milestone, section: node.section }];
      return tasks;
    }
    if (node.kind === "add") return [];
    return node.task.children
      .filter(visible)
      .map((t): MilestoneNode => ({ kind: "task", task: t }));
  }

  getParent(node: MilestoneNode): MilestoneNode | undefined {
    const plan = this.state.plan;
    if (node.kind === "milestone") return undefined;
    if (node.kind === "section") return { kind: "milestone", milestone: node.milestone };
    if (node.kind === "add")
      return node.section
        ? { kind: "section", milestone: node.milestone, section: node.section }
        : { kind: "milestone", milestone: node.milestone };
    const t = node.task;
    if (t.parent) return { kind: "task", task: t.parent };
    const m = plan.milestoneById(t.milestoneId);
    if (!m) return undefined;
    const s = m.sections.find((x) => x.line === t.sectionLine);
    return s ? { kind: "section", milestone: m, section: s } : { kind: "milestone", milestone: m };
  }

  getTreeItem(node: MilestoneNode): vscode.TreeItem {
    const plan = this.state.plan;
    const today = this.state.today;
    switch (node.kind) {
      case "milestone": {
        const m = node.milestone;
        const stats = milestoneStats(m);
        const item = new vscode.TreeItem(m.title, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `milestone:${m.id}`;
        const late = this.state.milestoneLate(m.id);
        const parts = [`${stats.done}/${stats.total}`, `${Math.round(stats.progress * 100)}%`];
        if (m.target) parts.push(`target ${m.target}`);
        if (late) parts.push(`⚠ ${late}`);
        item.description = parts.join(" · ");
        item.iconPath = new vscode.ThemeIcon(
          "milestone",
          m.status === "done"
            ? new vscode.ThemeColor("charts.green")
            : late
              ? new vscode.ThemeColor("charts.red")
              : m.status === "active"
                ? new vscode.ThemeColor("charts.blue")
                : undefined
        );
        item.tooltip = new vscode.MarkdownString(
          `**${m.title}**\n\nStatus: ${m.status}  \nTarget: ${m.target ?? "—"}  \nTasks: ${stats.done}/${stats.total} done  \n` +
            `Progress: ${Math.round(stats.progress * 100)}% (hours-weighted)  \nRemaining: ${Math.round(stats.remaining * 10) / 10}h` +
            (m.depends.length ? `  \nDepends on: ${m.depends.join(", ")}` : "") +
            (m.description.length ? `\n\n${m.description.join(" ")}` : "") +
            "\n\n---\n\n$(info) Right-click for actions: add a task or section, edit the milestone",
          true
        );
        item.contextValue = "milestone";
        item.command = { command: "planner.revealMilestone", title: "Open", arguments: [m.id] };
        return item;
      }
      case "section": {
        const item = new vscode.TreeItem(
          node.section.title,
          vscode.TreeItemCollapsibleState.Expanded
        );
        item.id = `section:${node.milestone.file}:${node.section.line}`;
        const leaves = node.section.tasks;
        item.description = `${leaves.filter((t) => t.status === "done").length}/${leaves.length}`;
        item.iconPath = new vscode.ThemeIcon("list-tree");
        item.tooltip = `${node.section.title} – right-click or use + to add a task`;
        item.contextValue = "section";
        return item;
      }
      case "add": {
        const where = node.section ? node.section.title : node.milestone.title;
        const item = new vscode.TreeItem("Add a task…", vscode.TreeItemCollapsibleState.None);
        item.id = `add:${node.milestone.id}:${node.section?.line ?? "root"}`;
        item.iconPath = new vscode.ThemeIcon("add");
        item.description = node.section ? "this section is empty" : "no tasks yet";
        item.tooltip = `Add the first task to ${where}`;
        item.contextValue = "addPlaceholder";
        item.command = {
          command: "planner.addTask",
          title: "Add task",
          arguments: [{ milestone: node.milestone.id, section: node.section?.title ?? "" }],
        };
        return item;
      }
      case "task": {
        const t = node.task;
        const item = new vscode.TreeItem(
          t.title || "(untitled)",
          t.children.length
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None
        );
        item.id = taskNodeId(t, plan);
        item.description = taskDescription(plan, t, today, this.state.decorations(t));
        item.tooltip = taskTooltip(plan, t, this.state.tooltipLines(t), TASK_HINT);
        item.iconPath = statusIcon(t.status);
        item.contextValue = `task status-${t.status}`;
        item.command = {
          command: "planner.revealTask",
          title: "Reveal",
          arguments: [taskArgOf(t, plan)],
        };
        item.accessibilityInformation = {
          label: `${t.title}, ${t.status}${t.id ? `, ${t.id}` : ""}`,
        };
        return item;
      }
    }
  }

  /** Finds the node of a task (for TreeView.reveal). */
  nodeForTask(plan: Plan, id: string): MilestoneNode | undefined {
    const t = plan.taskById(id);
    return t ? { kind: "task", task: t } : undefined;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  /** An empty section without text: one that was just added (unlike "## Notes"). */
  private isNewSection(m: Milestone, s: Section): boolean {
    const file = this.state.plan.file(m.file);
    if (!file) return false;
    const next = m.sections.find((x) => x.line > s.line)?.line;
    return isEmptySection(file, s.line, next);
  }

  private isUnfiltered(): boolean {
    const f = this.filter.filter;
    return !f.owner?.length && !f.tag?.length && !f.status?.length && !f.text?.trim();
  }
}
