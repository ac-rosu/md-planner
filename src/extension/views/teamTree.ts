// My work / Team view: person → open tasks assigned to them.
import * as vscode from "vscode";
import { UNASSIGNED } from "../../core/calendar";
import { formatDate, parseDate } from "../../core/dates";
import { matchesFilter } from "../../core/filter";
import { type Person, type Task } from "../../core/model";
import { openTasksOf } from "../../core/queries";
import { config } from "../util";
import { type PlannerState } from "../state";
import { statusIcon, TASK_HINT, taskDescription, taskNodeId, taskTooltip } from "./common";
import { type ViewFilter } from "./filter";

export type TeamNode =
  { kind: "person"; id: string; person?: Person } | { kind: "task"; task: Task; personId: string };

type PersonNode = Extract<TeamNode, { kind: "person" }>;

export class TeamTreeProvider implements vscode.TreeDataProvider<TeamNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TeamNode | undefined>();
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

  /** The person shown first and expanded: `planner.me`, else the first person in team.md. */
  me(): string | undefined {
    const configured = config().get<string>("me", "");
    if (configured) return configured.toLowerCase();
    return this.state.plan.people[0]?.id.toLowerCase();
  }

  getChildren(node?: TeamNode): TeamNode[] {
    const plan = this.state.plan;
    const f = this.filter.filter;
    if (!node) {
      const me = this.me();
      const people: PersonNode[] = plan.people.map((p) => ({
        kind: "person",
        id: p.id,
        person: p,
      }));
      people.sort((a, b) => Number(b.id.toLowerCase() === me) - Number(a.id.toLowerCase() === me));
      if (openTasksOf(plan, UNASSIGNED).length > 0) people.push({ kind: "person", id: UNASSIGNED });
      // Owners that are not in team.md still get a node so their work is visible.
      const known = new Set(people.map((p) => p.id.toLowerCase()));
      for (const t of plan.tasks) {
        const o = t.owner?.toLowerCase();
        if (o && !known.has(o)) {
          known.add(o);
          people.push({ kind: "person", id: t.owner! });
        }
      }
      const ownerFilter = f.owner?.map((o) => o.toLowerCase());
      return ownerFilter?.length
        ? people.filter((p) => ownerFilter.includes(p.id.toLowerCase()))
        : people;
    }
    if (node.kind === "person") {
      return this.state
        .sortForPerson(openTasksOf(plan, node.id))
        .filter((t) => matchesFilter(t, { ...f, owner: undefined }))
        .map((t): TeamNode => ({ kind: "task", task: t, personId: node.id }));
    }
    return [];
  }

  getParent(node: TeamNode): TeamNode | undefined {
    return node.kind === "task" ? { kind: "person", id: node.personId } : undefined;
  }

  getTreeItem(node: TeamNode): vscode.TreeItem {
    const plan = this.state.plan;
    if (node.kind === "person") {
      const name = node.person?.name ?? (node.id === UNASSIGNED ? "Unassigned" : node.id);
      const me = this.me() === node.id.toLowerCase();
      const item = new vscode.TreeItem(
        name,
        me ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
      );
      item.id = `person:${node.id.toLowerCase()}`;
      const open = openTasksOf(plan, node.id);
      const load = this.state.weekLoad(node.id);
      const parts: string[] = [];
      if (node.person?.role) parts.push(node.person.role);
      parts.push(`${open.length} open`);
      if (load) parts.push(load.label);
      if (load?.overtime) parts.push("overtime");
      item.description = parts.join(" · ");
      const over = load?.over ?? false;
      item.iconPath = new vscode.ThemeIcon(
        node.id === UNASSIGNED ? "question" : node.person ? "person" : "warning",
        over ? new vscode.ThemeColor("charts.red") : undefined
      );
      item.tooltip = new vscode.MarkdownString(
        `**${name}**` +
          (node.person?.role ? `  \n${node.person.role}` : "") +
          (node.person
            ? `  \nCapacity: ${node.person.capacityHours}h/${node.person.capacityPer}`
            : "") +
          (node.person?.skills.length ? `  \nSkills: ${node.person.skills.join(", ")}` : "") +
          (load ? `  \nThis week: ${load.label}` : "") +
          (load?.overtime ? ` (${load.overtime})` : "") +
          (node.person ? overtimeLines(node.person, this.state.today) : "") +
          (!node.person && node.id !== UNASSIGNED ? "  \nNot in team.md" : "") +
          (node.person
            ? "\n\n---\n\n$(info) Right-click (or the buttons on the row) to edit the person, add time off, plan overtime or add a working day"
            : ""),
        true
      );
      // "owner": named in @owner but not in team.md, so there is nothing to edit or remove.
      item.contextValue = node.id === UNASSIGNED ? "unassigned" : node.person ? "person" : "owner";
      return item;
    }
    const t = node.task;
    const item = new vscode.TreeItem(t.title || "(untitled)", vscode.TreeItemCollapsibleState.None);
    item.id = `team:${node.personId}:${taskNodeId(t)}`;
    item.description = taskDescription(plan, t, this.state.today, this.state.decorations(t));
    item.tooltip = taskTooltip(plan, t, this.state.tooltipLines(t), TASK_HINT);
    item.iconPath = statusIcon(t.status);
    item.contextValue = `task status-${t.status}`;
    item.command = {
      command: "planner.revealTask",
      title: "Reveal",
      arguments: [t.id ?? { file: t.file, line: t.line }],
    };
    return item;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

/** Upcoming overtime and extra working days of a person, for the tooltip. */
function overtimeLines(p: Person, today: string): string {
  const t = parseDate(today) ?? 0;
  const range = (a: number, b: number) =>
    a === b ? formatDate(a) : `${formatDate(a)}..${formatDate(b)}`;
  const overtime = p.overtime
    .filter((o) => o.to >= t)
    .map((o) => `${range(o.from, o.to)} +${o.hours}h/${o.per}`);
  const days = p.workdays
    .filter((w) => w.to >= t)
    .map((w) => `${range(w.from, w.to)}${w.hours !== undefined ? ` ${w.hours}h` : ""}`);
  return (
    (overtime.length ? `  \nOvertime: ${overtime.join(", ")}` : "") +
    (days.length ? `  \nExtra working days: ${days.join(", ")}` : "")
  );
}
