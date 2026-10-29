// Gantt panel host: builds the view model and turns webview gestures into minimal Markdown edits.
import * as vscode from "vscode";
import { formatDate, parseDate } from "../../core/dates";
import { formatHours, parseDuration } from "../../core/duration";
import { wouldCreateCycle } from "../../core/graph";
import { isOpen, type Task } from "../../core/model";
import { isLeaf } from "../../core/rollup";
import {
  describeMove,
  describeResize,
  describeScheduleChange,
  resizeTo,
  scheduleAfter,
  sharedIdReason,
} from "../../core/drag";
import { titleMarkup } from "../../core/parser/taskLine";
import { findTaskByKey, schedulePlan } from "../../core/scheduler";
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
      order: this.options.order,
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
      case "options": {
        // Zooming is up to the webview: only other options change the model.
        const zoomOnly = sameExceptZoom(this.options, m.options);
        this.options = m.options;
        await this.ctx.memento.update(OPTIONS_KEY, m.options);
        if (!zoomOnly) this.sendModel();
        return;
      }
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

  /** The task of a bar to change. */
  private editable(key: string): Task {
    const t = this.task(key);
    // Bars of tasks with the same id send the same key: the gesture may be on the other one.
    const shared = sharedIdReason(this.ctx.state.plan, t);
    if (shared) throw new Error(shared);
    return t;
  }

  private editableLeaf(key: string): Task {
    const t = this.editable(key);
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
    const state = this.ctx.state;
    const s = state.schedule;
    const snapped = s.calendar.nextWorkingDay(day);
    const date = formatDate(snapped);
    const edits = setAttr(this.lines(t), t, "start", date);
    if (edits.length === 0) {
      // Dropped on its own fixed start (or on days off just before it): nothing to write or undo.
      this.notice("info", describeMove(state.plan, s, s, t, day, snapped));
      return false;
    }
    // The schedule after the move, before writing it: where the bar ends up, why, and what else
    // moves. Every drag is reported with an Undo button, so an accidental one is noticed right away.
    const after = schedulePlan(state.plan, {
      ...state.scheduleOptions(),
      whatIf: { task: t, start: snapped },
    });
    const message = describeMove(state.plan, s, after, t, day, snapped);
    const ok = await this.ctx.history.apply(
      [{ path: t.file, edits }],
      `Move ${t.id ?? t.title} to ${date}`
    );
    if (ok) this.changed(message);
    return ok;
  }

  /**
   * Drag the end of a bar: the estimate becomes the largest one found near the current one with
   * which the task ends on the dropped day, next to the owner's other work (resizeTo), written as
   * `@est` in hours (and the `@est` of a parent whose budget the subtasks share, so the others keep
   * their hours). When more work does not end it any later, or the work it gets by then does not
   * end it there, nothing is written and the notice says why.
   */
  async resize(key: string, finishIso: string): Promise<boolean> {
    const t = this.editableLeaf(key);
    const state = this.ctx.state;
    const s = state.schedule;
    const ts = s.tasks.get(t);
    const finish = parseDate(finishIso);
    if (!ts || ts.start === undefined || finish === undefined)
      throw new Error(`${t.id ?? t.title} has no scheduled dates to resize.`);
    const r = resizeTo(state.plan, state.scheduleOptions(), s, t, finish);
    if ("why" in r) {
      this.notice("info", r.why);
      return false;
    }
    const message = describeResize(state.plan, s, t, r);
    const parents = r.parents.map((p) => `${p.task.id ?? p.task.title} to ${formatHours(p.est)}`);
    const ok = await this.ctx.history.apply(
      r.edits,
      `Set ${t.id ?? t.title} estimate to ${formatHours(r.est)}${parents.length ? ` (${parents.join(", ")})` : ""}`
    );
    if (ok) this.changed(message);
    return ok;
  }

  /** Drag from one bar to another: the target gets `@dep` on the source (ids added if missing). */
  async link(fromKey: string, toKey: string): Promise<boolean> {
    const plan = this.ctx.state.plan;
    const pred = this.editable(fromKey);
    const succ = this.editable(toKey);
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
    const ok = await this.ctx.history.apply(
      mergeEdits(edits),
      `Add dependency ${succ.id ?? succ.title} → ${predId}`
    );
    if (ok) this.changed(`${succ.id ?? succ.title} now waits for ${predId}.`);
    return ok;
  }

  /**
   * Remove an arrow: the target's `@dep` loses the source's id. That edit is the same whichever
   * task with that id the arrow comes from, so only a target whose id another task has is refused.
   */
  async unlink(fromKey: string, toKey: string): Promise<boolean> {
    const pred = this.task(fromKey);
    const succ = this.editable(toKey);
    if (!pred.id) return false;
    const edits = removeDependency(this.lines(succ), succ, pred.id);
    if (edits.length === 0) {
      this.notice("info", `${succ.id ?? succ.title} does not depend on ${pred.id}.`);
      return false;
    }
    const ok = await this.ctx.history.apply(
      [{ path: succ.file, edits }],
      `Remove dependency ${succ.id ?? succ.title} → ${pred.id}`
    );
    if (ok) this.changed(`${succ.id ?? succ.title} no longer waits for ${pred.id}.`);
    return ok;
  }

  /** Inline edit of title, owner and estimate in one minimal edit. */
  async edit(
    key: string,
    change: { title?: string; owner?: string | null; estimate?: string }
  ): Promise<boolean> {
    const t = this.editable(key);
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
    // A new owner or estimate can move other work: the notice says what (see describeScheduleChange).
    const state = this.ctx.state;
    const before = state.schedule;
    const after = edits.length
      ? scheduleAfter(state.plan, state.scheduleOptions(), [{ path: t.file, edits }])
      : before;
    const ok = await this.ctx.history.apply([{ path: t.file, edits }], `Edit ${t.id ?? t.title}`);
    // A title is written as typed: say when part of it became a tag or an attribute.
    const markup = change.title !== undefined ? titleMarkup(change.title) : [];
    const note = markup.length
      ? ` Not part of the title: ${markup.join(" ")} (read as a tag, attribute or id); put such text in brackets to keep it, e.g. (#42).`
      : "";
    if (ok && edits.length)
      this.changed(
        `${state.service.savedMessage(t.id ?? t.title, [t.file])}.${note} ${describeScheduleChange(before, after)}`.trim()
      );
    return ok;
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

function sameExceptZoom(a: GanttViewOptions, b: GanttViewOptions): boolean {
  const rest = (o: GanttViewOptions) =>
    JSON.stringify({ ...o, zoom: undefined, pxPerDay: undefined });
  return rest(a) === rest(b);
}
