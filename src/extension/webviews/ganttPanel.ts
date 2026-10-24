// Gantt panel host: builds the view model and turns webview gestures into minimal Markdown edits.
import * as vscode from "vscode";
import { formatDate, parseDate } from "../../core/dates";
import { formatHours, parseDuration } from "../../core/duration";
import { wouldCreateCycle } from "../../core/graph";
import { isOpen, type Task } from "../../core/model";
import { isLeaf } from "../../core/rollup";
import { findTaskByKey } from "../../core/scheduler";
import { buildGanttModel, type BaselineLookup } from "../../core/views/gantt";
import {
  addDependency,
  editTaskLine,
  type FileEdit,
  nextId,
  removeDependency,
  setAttr,
} from "../../core/writer";
import {
  DEFAULT_GANTT_OPTIONS,
  type GanttToHost,
  type GanttViewOptions,
  type HostToGantt,
} from "../../webview/shared/protocol";
import { type PanelContext, WebviewPanelHost } from "./panel";
import { revealTaskInEditor } from "./reveal";

const OPTIONS_KEY = "gantt.options";

/** Supplies baseline overlays (implemented by the baseline service). */
export interface BaselineSource {
  names(): string[];
  lookup(name: string | undefined): BaselineLookup | undefined;
  readonly onDidChange: vscode.Event<void>;
}

export class GanttPanel extends WebviewPanelHost<HostToGantt, GanttToHost> {
  static current: GanttPanel | undefined;
  private options: GanttViewOptions;

  static show(
    ctx: PanelContext,
    baselines: BaselineSource | undefined,
    focusKey?: string
  ): GanttPanel {
    if (GanttPanel.current) {
      GanttPanel.current.panel.reveal();
    } else {
      GanttPanel.current = new GanttPanel(ctx, baselines);
      GanttPanel.current.onDidDispose(() => (GanttPanel.current = undefined));
    }
    if (focusKey) GanttPanel.current.post({ type: "focus", key: focusKey });
    return GanttPanel.current;
  }

  private constructor(
    ctx: PanelContext,
    private readonly baselines: BaselineSource | undefined
  ) {
    super(ctx, "planner.gantt", `Gantt – ${ctx.state.plan.project.name}`, "gantt");
    this.options = {
      ...DEFAULT_GANTT_OPTIONS,
      ...ctx.memento.get<Partial<GanttViewOptions>>(OPTIONS_KEY),
    };
    this.disposables.push(ctx.state.onDidUpdate(() => this.sendModel()));
    if (baselines) this.disposables.push(baselines.onDidChange(() => this.sendModel()));
    this.sendModel();
  }

  get viewOptions(): GanttViewOptions {
    return this.options;
  }

  sendModel(): void {
    const state = this.ctx.state;
    this.panel.title = `Gantt – ${state.plan.project.name}`;
    const model = buildGanttModel(state.plan, state.schedule, {
      grouping: this.options.grouping,
      hideDone: this.options.hideDone,
      baseline: this.options.showBaseline
        ? this.baselines?.lookup(this.options.baseline)
        : undefined,
    });
    this.post({
      type: "model",
      model,
      options: this.options,
      baselines: this.baselines?.names() ?? [],
    });
  }

  protected async onMessage(m: GanttToHost): Promise<void> {
    switch (m.type) {
      case "ready":
        this.sendModel();
        return;
      case "options":
        this.options = m.options;
        await this.ctx.memento.update(OPTIONS_KEY, m.options);
        this.sendModel();
        return;
      case "reveal": {
        const t = this.task(m.key);
        await revealTaskInEditor(this.ctx.state.service, t, this.editorColumn());
        return;
      }
      case "move":
        await this.move(m.key, m.start);
        return;
      case "resize":
        await this.resize(m.key, m.finish);
        return;
      case "link":
        await this.link(m.from, m.to);
        return;
      case "unlink":
        await this.unlink(m.from, m.to);
        return;
      case "edit":
        await this.edit(m.key, m);
        return;
      case "editAll":
        await vscode.commands.executeCommand("planner.editTask", m.key);
        return;
      case "undo":
      case "redo":
        return;
    }
  }

  private task(key: string): Task {
    const t = findTaskByKey(this.ctx.state.plan, key);
    if (!t) throw new Error(`Task ${key} no longer exists.`);
    return t;
  }

  private editableLeaf(key: string): Task {
    const t = this.task(key);
    if (!isLeaf(t) || !isOpen(t.status) || t.kind !== "task") {
      throw new Error(
        `${t.id ?? t.title} cannot be changed from the Gantt (only open leaf tasks).`
      );
    }
    return t;
  }

  private lines(t: Task) {
    const f = this.ctx.state.plan.file(t.file);
    if (!f) throw new Error(`File not loaded: ${t.file}`);
    return f.lines;
  }

  /** Drag a bar: writes `@start` (snapped to a working day). */
  async move(key: string, startIso: string): Promise<boolean> {
    const t = this.editableLeaf(key);
    const day = parseDate(startIso);
    if (day === undefined) throw new Error(`Invalid date ${startIso}`);
    const s = this.ctx.state.schedule;
    const snapped = s.calendar.nextWorkingDay(day);
    const date = formatDate(snapped);
    const ok = await this.ctx.history.apply(
      [{ path: t.file, edits: setAttr(this.lines(t), t, "start", date) }],
      `Move ${t.id ?? t.title} to ${date}`
    );
    const ts = s.tasks.get(t);
    if (ok && ts?.earliest !== undefined && snapped < ts.earliest && !ts.task.start) {
      this.notice(
        "info",
        `${t.id ?? t.title} cannot start before its dependencies finish; @start is set to ${date}, the schedule keeps it later.`
      );
    } else if (ok && !t.start) {
      // Dragging pins the task; say so the first time, as it stays when the plan changes.
      this.notice(
        "info",
        `${t.id ?? t.title} is pinned: it starts no earlier than ${date} (@start), even when its dependencies finish sooner. Right-click the bar → Remove fixed start to let the scheduler place it again.`
      );
    }
    return ok;
  }

  /** Drag the end of a bar: the new span becomes the remaining work, written as `@est` in hours. */
  async resize(key: string, finishIso: string): Promise<boolean> {
    const t = this.editableLeaf(key);
    const s = this.ctx.state.schedule;
    const ts = s.tasks.get(t);
    const finish = parseDate(finishIso);
    if (!ts || ts.start === undefined || finish === undefined)
      throw new Error(`${t.id ?? t.title} has no scheduled dates to resize.`);
    const from = s.calendar.nextWorkingDay(Math.max(ts.start, s.start));
    const to = Math.max(from, finish);
    let remaining = 0;
    for (let d = from; d <= to; d++) remaining += s.calendar.capacity(ts.resource, d);
    if (remaining <= 0) {
      for (let d = from; d <= to; d++)
        if (s.calendar.isWorkingDay(d)) remaining += s.calendar.hoursPerDay;
    }
    remaining = Math.max(0.5, Math.round(remaining * 2) / 2);
    let est =
      t.progress !== undefined && t.progress < 1
        ? remaining / (1 - t.progress)
        : remaining + (t.act ?? 0);
    est = Math.round(est * 2) / 2;
    const value = formatHours(est);
    return this.ctx.history.apply(
      [{ path: t.file, edits: setAttr(this.lines(t), t, "est", value) }],
      `Set ${t.id ?? t.title} estimate to ${value}`
    );
  }

  /** Drag from one bar to another: the target gets `@dep` on the source (ids added if missing). */
  async link(fromKey: string, toKey: string): Promise<boolean> {
    const plan = this.ctx.state.plan;
    const pred = this.task(fromKey);
    const succ = this.task(toKey);
    if (pred === succ) return false;
    if (succ.kind !== "task" || pred.kind !== "task")
      throw new Error("Dependencies connect milestone tasks only.");
    if (wouldCreateCycle(this.ctx.state.schedule.graph, pred, succ)) {
      throw new Error(
        `${succ.id ?? succ.title} → ${pred.id ?? pred.title} would create a circular dependency.`
      );
    }
    const edits: FileEdit[] = [];
    let predId = pred.id;
    if (!predId) {
      predId = nextId(plan, "T");
      edits.push({
        path: pred.file,
        edits: editTaskLine(this.lines(pred), pred, (e) => e.setId(predId)),
      });
    }
    const depEdits = addDependency(this.lines(succ), succ, predId);
    if (depEdits.length === 0) {
      this.notice("info", `${succ.id ?? succ.title} already depends on ${predId}.`);
      return false;
    }
    edits.push({ path: succ.file, edits: depEdits });
    return this.ctx.history.apply(
      mergeEdits(edits),
      `Add dependency ${succ.id ?? succ.title} → ${predId}`
    );
  }

  async unlink(fromKey: string, toKey: string): Promise<boolean> {
    const pred = this.task(fromKey);
    const succ = this.task(toKey);
    if (!pred.id) return false;
    return this.ctx.history.apply(
      [{ path: succ.file, edits: removeDependency(this.lines(succ), succ, pred.id) }],
      `Remove dependency ${succ.id ?? succ.title} → ${pred.id}`
    );
  }

  /** Inline edit of title, owner and estimate in one minimal edit. */
  async edit(
    key: string,
    change: { title?: string; owner?: string | null; estimate?: string }
  ): Promise<boolean> {
    const t = this.task(key);
    const hpd = this.ctx.state.plan.project.hoursPerDay;
    if (change.estimate !== undefined && parseDuration(change.estimate, hpd) === undefined) {
      throw new Error(`Invalid estimate "${change.estimate}" (e.g. 12h, 2d, 1w).`);
    }
    if (change.title !== undefined && change.title.trim() === "")
      throw new Error("The title cannot be empty.");
    const edits = editTaskLine(this.lines(t), t, (e) => {
      if (change.title !== undefined) e.setTitle(change.title.replace(/\s+/g, " ").trim());
      if (change.owner !== undefined) e.setAttr("owner", change.owner ?? undefined);
      if (change.estimate !== undefined) e.setAttr("est", change.estimate);
    });
    return this.ctx.history.apply([{ path: t.file, edits }], `Edit ${t.id ?? t.title}`);
  }

  override dispose(): void {
    if (GanttPanel.current === this) GanttPanel.current = undefined;
    super.dispose();
  }
}

/** Combines edits of the same file into one FileEdit. */
export function mergeEdits(edits: FileEdit[]): FileEdit[] {
  const map = new Map<string, FileEdit>();
  for (const e of edits) {
    const existing = map.get(e.path);
    if (existing) existing.edits.push(...e.edits);
    else map.set(e.path, { path: e.path, edits: [...e.edits] });
  }
  return [...map.values()];
}
