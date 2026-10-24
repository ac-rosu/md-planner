// PlannerState: the plan plus everything derived from it (schedule, demand schedule, diagnostics),
// recomputed once per change and shared by every view.
import * as vscode from "vscode";
import { formatDate, parseDate } from "../core/dates";
import { describeLateCause, lateCause, unscheduledCause } from "../core/lateCause";
import { describeOvertime, formatLoad, loadLevel, taskOvertime, weekLoadAt } from "../core/load";
import { type Issue, isOpen, type Task } from "../core/model";
import { type Plan } from "../core/resolve";
import { isLeaf } from "../core/rollup";
import { scheduleDiagnostics } from "../core/scheduleDiagnostics";
import { scheduleJsonText } from "../core/scheduleJson";
import { type Schedule, schedulePlan, type TaskSchedule } from "../core/scheduler";
import { unscheduledText } from "../core/views/gantt";
import { validatePlan } from "../core/validate";
import { type PlanService } from "./planService";
import { config, encode } from "./util";
import { type TaskDecorations } from "./views/common";

export class PlannerState implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires after the plan and the schedule were recomputed. */
  readonly onDidUpdate = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private computed:
    { plan: Plan; today: string; schedule: Schedule; demand?: Schedule } | undefined;
  private issueCache:
    { plan: Plan; today: string; missingIds: boolean; issues: Issue[] } | undefined;
  private lastCache: string | undefined;

  constructor(readonly service: PlanService) {
    this.disposables.push(
      this.emitter,
      service.onDidChange(() => this.recompute())
    );
  }

  get plan(): Plan {
    return this.service.plan;
  }

  get today(): string {
    return this.service.today();
  }

  /** The resource-constrained schedule of the current plan. */
  get schedule(): Schedule {
    return this.ensure().schedule;
  }

  /** ASAP schedule ignoring capacity (raw demand), computed on first use. */
  get demand(): Schedule {
    const c = this.ensure();
    if (!c.demand) c.demand = schedulePlan(c.plan, { ...this.scheduleOptions(), mode: "demand" });
    return c.demand;
  }

  /** Recomputes derived data and notifies listeners. */
  recompute(): void {
    this.computed = undefined;
    this.issueCache = undefined;
    const c = this.ensure();
    void this.writeCache(c.plan, c.schedule);
    this.emitter.fire();
  }

  private scheduleOptions() {
    return {
      today: this.today,
      unassignedCapacity: config().get<number>("scheduling.unassignedCapacity", 40),
    };
  }

  private ensure(): { plan: Plan; today: string; schedule: Schedule; demand?: Schedule } {
    const plan = this.plan;
    const today = this.today;
    if (!this.computed || this.computed.plan !== plan || this.computed.today !== today) {
      const started = Date.now();
      const schedule = schedulePlan(plan, this.scheduleOptions());
      this.computed = { plan, today, schedule };
      this.service.log.debug(
        `Scheduled ${schedule.tasks.size} tasks in ${Date.now() - started} ms`
      );
    }
    return this.computed;
  }

  /** Writes plan/.planner/schedule.json when it changed (generated cache, gitignored). */
  private async writeCache(plan: Plan, schedule: Schedule): Promise<void> {
    const root = this.service.root;
    if (!root || plan.files.length === 0) return;
    const text = scheduleJsonText(plan, schedule);
    if (text === this.lastCache) return;
    this.lastCache = text;
    try {
      const dir = vscode.Uri.joinPath(root, ".planner");
      await vscode.workspace.fs.createDirectory(dir);
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, "schedule.json"), encode(text));
    } catch (err) {
      this.service.log.warn(`Could not write the schedule cache: ${String(err)}`);
    }
  }

  /** All diagnostics for the current plan and schedule (cached). */
  issues(options: { missingIds: boolean }): Issue[] {
    const plan = this.plan;
    const today = this.today;
    const c = this.issueCache;
    if (c && c.plan === plan && c.today === today && c.missingIds === options.missingIds)
      return c.issues;
    const issues = [
      ...validatePlan(plan, { missingIds: options.missingIds, graph: this.schedule.graph }),
      ...scheduleDiagnostics(plan, this.schedule, {
        workload: config().get<boolean>("diagnostics.overbooked", true),
      }),
    ];
    this.issueCache = { plan, today, missingIds: options.missingIds, issues };
    return issues;
  }

  taskSchedule(t: Task): TaskSchedule | undefined {
    return this.schedule.tasks.get(t);
  }

  /** Parts of the milestone CodeLens after "done/total · %": forecast and variance. */
  milestoneLensParts(id: string): string[] {
    const ms = this.schedule.milestones.get(id);
    const m = this.plan.milestoneById(id);
    if (!ms || !m) return [];
    const parts: string[] = [];
    if (ms.forecast !== undefined) parts.push(`forecast ${formatDate(ms.forecast)}`);
    if (ms.variance !== undefined) {
      if (ms.variance > 0) parts.push(`${ms.variance} d late`);
      else if (ms.variance < 0) parts.push(`${-ms.variance} d ahead`);
      else parts.push("on target");
    } else if (m.target) {
      parts.push(`target ${m.target}`);
    }
    return parts;
  }

  /** CodeLens text above a task: `scheduled 2026-11-10 → 11-13 · slack 2 d`. */
  taskLens(t: Task): string | undefined {
    const s = this.schedule;
    if (t.kind !== "task" || t.status === "cancelled") return undefined;
    if (isLeaf(t)) {
      const ts = s.tasks.get(t);
      if (!ts) return undefined;
      if (ts.unscheduled) return `not scheduled: ${unscheduledText(ts.unscheduled)}`;
      if (ts.done) return ts.finish !== undefined ? `done ${formatDate(ts.finish)}` : undefined;
      if (ts.start === undefined || ts.finish === undefined) return undefined;
      const parts = [`scheduled ${range(ts.start, ts.finish)}`];
      if (ts.slack !== undefined) parts.push(`slack ${ts.slack} d`);
      if (ts.critical) parts.push("critical");
      if (ts.late && ts.deadline !== undefined)
        parts.push(`⚠ late (due ${formatDate(ts.deadline)})`);
      if (ts.unassigned) parts.push("unassigned");
      const ot = taskOvertime(s).get(ts.key);
      if (ot) parts.push(`${Math.round(ot.hours * 10) / 10} h overtime`);
      return parts.join(" · ");
    }
    const r = s.parents.get(t);
    if (!r || r.start === undefined || r.finish === undefined) return undefined;
    return `${range(r.start, r.finish)} · ${Math.round(r.progress * 100)}%`;
  }

  /** Extra description parts and late flags for a task in tree views. */
  decorations(t: Task): TaskDecorations {
    const ts = this.schedule.tasks.get(t);
    if (!ts || ts.done) return {};
    if (ts.unscheduled) return { late: "not scheduled" };
    return ts.late ? { late: "late" } : {};
  }

  /** Extra tooltip lines for a task. */
  tooltipLines(t: Task): string[] {
    const s = this.schedule;
    const ts = s.tasks.get(t);
    if (ts) {
      if (ts.unscheduled)
        return [
          `Not scheduled: ${unscheduledCause(this.plan, s, t) ?? unscheduledText(ts.unscheduled)}`,
        ];
      if (ts.done || ts.start === undefined || ts.finish === undefined) return [];
      const lines = [`Scheduled: ${formatDate(ts.start)} → ${formatDate(ts.finish)}`];
      if (ts.slack !== undefined)
        lines.push(
          `Slack: ${ts.slack} working day${Math.abs(ts.slack) === 1 ? "" : "s"}${ts.critical ? " (critical path)" : ""}`
        );
      if (ts.late && ts.deadline !== undefined) {
        lines.push(`Late: deadline ${formatDate(ts.deadline)}`);
        const cause = lateCause(s, t);
        if (cause) lines.push(describeLateCause(this.plan, t, cause));
      }
      if (t.start) lines.push(`Fixed start: not before ${t.start} (@start)`);
      const ot = taskOvertime(s).get(ts.key);
      if (ot) lines.push(describeOvertime(ot, formatDate));
      return lines;
    }
    const r = s.parents.get(t);
    if (r?.start !== undefined && r.finish !== undefined)
      return [`Scheduled: ${formatDate(r.start)} → ${formatDate(r.finish)}`];
    return [];
  }

  /** Orders a person's open tasks by scheduled start (then file order). */
  sortForPerson(tasks: Task[]): Task[] {
    const s = this.schedule;
    const key = (t: Task) => s.tasks.get(t)?.start ?? Number.MAX_SAFE_INTEGER;
    return [...tasks].sort((a, b) => key(a) - key(b) || a.order - b.order);
  }

  /** This week's scheduled load of a person: `34/32 h`, red when over, with planned overtime. */
  weekLoad(personId: string): { label: string; over: boolean; overtime?: string } | undefined {
    const today = parseDate(this.today);
    if (today === undefined) return undefined;
    const w = weekLoadAt(this.schedule, personId, today);
    if (w.capacity <= 0 && w.hours <= 0) return { label: "off this week", over: false };
    const r = (n: number) => Math.round(n * 10) / 10;
    return {
      label: formatLoad(w.hours, w.capacity),
      over: loadLevel(w.hours, w.capacity) === "over",
      overtime:
        w.overtimeCapacity > 0
          ? `${r(w.overtime)} of ${r(w.overtimeCapacity)} h overtime scheduled`
          : undefined,
    };
  }

  /** A short late label for a milestone, or undefined when on time. */
  milestoneLate(id: string): string | undefined {
    const m = this.plan.milestoneById(id);
    if (!m || m.status === "done" || m.status === "cancelled") return undefined;
    const ms = this.schedule.milestones.get(id);
    if (ms?.late) return `${ms.variance ?? ""} d late`.trim();
    if (m.target && m.target < this.today && m.tasks.some((t) => isOpen(t.status)))
      return "overdue";
    return undefined;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

function range(a: number, b: number): string {
  const from = formatDate(a);
  const to = formatDate(b);
  return `${from} → ${from.slice(0, 4) === to.slice(0, 4) ? to.slice(5) : to}`;
}
