// Kanban panel host: builds the board model with the shared filter and turns drags into edits.
import * as vscode from "vscode";
import { UNASSIGNED } from "../../core/calendar";
import { type TaskFilter } from "../../core/filter";
import { type Priority, type Status, type Task } from "../../core/model";
import { findTaskByKey } from "../../core/scheduler";
import { buildKanbanModel, KANBAN_COLUMNS, priorityForDrop } from "../../core/views/kanban";
import { applyStatus, editTaskLine } from "../../core/writer";
import {
  DEFAULT_KANBAN_OPTIONS,
  type HostToKanban,
  type KanbanToHost,
  type KanbanViewOptions,
} from "../../webview/shared/protocol";
import { type AddTaskTarget } from "../commands/edit";
import { config } from "../util";
import { type PanelContext, WebviewPanelHost } from "./panel";
import { revealTaskInEditor } from "./reveal";

const OPTIONS_KEY = "kanban.options";
const FILTER_KEY = "kanban.filter";

export class KanbanPanel extends WebviewPanelHost<HostToKanban, KanbanToHost> {
  static current: KanbanPanel | undefined;
  private options: KanbanViewOptions;
  private filters: Record<string, TaskFilter>;

  static show(
    ctx: PanelContext,
    board?: KanbanViewOptions["board"],
    focusKey?: string
  ): KanbanPanel {
    if (KanbanPanel.current) KanbanPanel.current.panel.reveal();
    else {
      KanbanPanel.current = new KanbanPanel(ctx);
      KanbanPanel.current.onDidDispose(() => (KanbanPanel.current = undefined));
    }
    const panel = KanbanPanel.current;
    if (board && board !== panel.options.board) {
      void panel.receive({
        type: "options",
        options: { ...panel.options, board, swimlane: board === "punch" ? "severity" : "none" },
      });
    }
    if (focusKey) panel.post({ type: "focus", key: focusKey });
    return panel;
  }

  private constructor(ctx: PanelContext) {
    super(ctx, "planner.kanban", "Kanban", "kanban");
    this.options = {
      ...DEFAULT_KANBAN_OPTIONS,
      ...ctx.memento.get<Partial<KanbanViewOptions>>(OPTIONS_KEY),
    };
    this.filters = ctx.memento.get<Record<string, TaskFilter>>(FILTER_KEY) ?? {};
    this.disposables.push(
      ctx.state.onDidUpdate(() => this.sendModel()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("planner.kanban")) this.sendModel();
      })
    );
    this.sendModel();
  }

  get viewOptions(): KanbanViewOptions {
    return this.options;
  }

  get filter(): TaskFilter {
    return this.filters[this.options.board] ?? {};
  }

  sendModel(): void {
    const state = this.ctx.state;
    this.panel.title =
      this.options.board === "punch" ? "Punch list" : `Kanban – ${state.plan.project.name}`;
    const model = buildKanbanModel(state.plan, state.schedule, {
      ...this.options,
      filter: this.filter,
      wipLimits: config().get<Partial<Record<Status, number>>>("kanban.wipLimits", {}),
    });
    this.post({ type: "model", model, options: this.options });
  }

  protected async onMessage(m: KanbanToHost): Promise<void> {
    switch (m.type) {
      case "ready":
        this.sendModel();
        return;
      case "options":
        this.options = m.options;
        await this.ctx.memento.update(OPTIONS_KEY, m.options);
        this.sendModel();
        return;
      case "filter":
        this.filters = { ...this.filters, [this.options.board]: m.filter };
        await this.ctx.memento.update(FILTER_KEY, this.filters);
        this.sendModel();
        return;
      case "reveal":
        await revealTaskInEditor(this.ctx.state.service, this.task(m.key), this.editorColumn());
        return;
      case "move":
        await this.move(m);
        return;
      case "priority":
        await this.setPriority(m.key, m.prio);
        return;
      case "add":
        await this.add(m.status);
        return;
      case "edit":
        await vscode.commands.executeCommand("planner.editTask", m.key);
        return;
      case "assign":
        await vscode.commands.executeCommand("planner.assignOwner", m.key);
        return;
      case "undo":
      case "redo":
        return;
    }
  }

  private task(key: string): Task {
    const t = findTaskByKey(this.ctx.state.plan, key);
    if (!t) throw new Error(`Card ${key} no longer exists.`);
    return t;
  }

  private lines(t: Task) {
    const f = this.ctx.state.plan.file(t.file);
    if (!f) throw new Error(`File not loaded: ${t.file}`);
    return f.lines;
  }

  /** Drop a card: status change (column), owner change (owner lane) and/or priority (position). */
  async move(m: Extract<KanbanToHost, { type: "move" }>): Promise<boolean> {
    const t = this.task(m.key);
    if (!KANBAN_COLUMNS.includes(m.status)) throw new Error(`Unknown column ${m.status}`);
    const plan = this.ctx.state.plan;
    const lines = this.lines(t);
    const today = this.ctx.state.today;
    const parts: string[] = [];

    // Owner swimlanes: dropping into another lane reassigns the card.
    let owner: string | null | undefined;
    if (this.options.swimlane === "owner" && m.lane !== undefined) {
      const current = (t.owner ?? "").toLowerCase() || UNASSIGNED;
      if (m.lane !== current && !(m.lane === UNASSIGNED && !t.owner)) {
        owner = m.lane === UNASSIGNED ? null : m.lane;
        parts.push(owner ? `owner ${owner}` : "no owner");
      }
    } else if (m.lane !== undefined && this.options.swimlane !== "none") {
      const laneOf = this.options.swimlane === "milestone" ? t.milestoneId : (t.sev ?? "");
      if (m.lane !== (laneOf ?? "")) {
        throw new Error(
          this.options.swimlane === "milestone"
            ? "Cards cannot be dragged to another milestone; right-click the card and choose Move task to…"
            : "Cards cannot be dragged to another severity; right-click the card and choose Edit task…"
        );
      }
    }

    // Position within the column → priority of the neighbour.
    const neighbour = (key: string | undefined) => (key ? findTaskByKey(plan, key) : undefined);
    const prio = priorityForDrop(t.prio, neighbour(m.above)?.prio, neighbour(m.below)?.prio);

    if (m.status === t.status && owner === undefined && !prio) return false;
    if (m.status !== t.status) parts.unshift(m.status);
    if (prio) parts.push(`priority ${prio}`);
    const edits = editTaskLine(lines, t, (e) => {
      if (m.status !== t.status) applyStatus(e, t, m.status, today, { blockedReason: m.reason });
      if (owner !== undefined) e.setAttr("owner", owner ?? undefined);
      if (prio) e.setAttr("prio", prio === "med" ? undefined : prio);
    });
    return this.ctx.history.apply(
      [{ path: t.file, edits }],
      `${t.id ?? t.title}: ${parts.join(", ")}`
    );
  }

  /** "+" in a column: a new task (or punch item) with the column's status. */
  async add(status: Status): Promise<void> {
    const target = this.addTarget(status);
    await vscode.commands.executeCommand(
      this.options.board === "punch" ? "planner.addPunchItem" : "planner.addTask",
      target
    );
  }

  /** The defaults for a new card in a column: its status, and a filter on exactly one owner or
   * milestone as the owner and milestone. */
  addTarget(status: Status): AddTaskTarget {
    const single = (values: string[] | undefined) => (values?.length === 1 ? values[0] : undefined);
    const owner = single(this.filter.owner);
    const target: AddTaskTarget = { status, owner: owner === UNASSIGNED ? undefined : owner };
    if (this.options.board === "punch") return target;
    return { ...target, milestone: single(this.filter.milestone), reveal: false };
  }

  async setPriority(key: string, prio: Priority): Promise<boolean> {
    const t = this.task(key);
    if (t.prio === prio) return false;
    const edits = editTaskLine(this.lines(t), t, (e) =>
      e.setAttr("prio", prio === "med" ? undefined : prio)
    );
    return this.ctx.history.apply(
      [{ path: t.file, edits }],
      `${t.id ?? t.title}: priority ${prio}`
    );
  }

  override dispose(): void {
    if (KanbanPanel.current === this) KanbanPanel.current = undefined;
    super.dispose();
  }
}
