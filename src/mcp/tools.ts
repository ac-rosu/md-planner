// The MCP tools as plain functions over a plan folder on disk. Every call re-reads the plan (so
// edits made in VS Code are seen), and every write goes through the minimal-diff writer and
// returns the changed lines.
import { existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { formatDate, isValidDate, localToday, parseDate, weekStart } from "../core/dates";
import { matchesFilter, type TaskFilter } from "../core/filter";
import { isMissing, loadPlanIndex } from "../core/fsLoader";
import { taskOvertime, teamLoad } from "../core/load";
import { describeAccuracy, estimateAccuracy } from "../core/metrics";
import { type Status, type Task } from "../core/model";
import { describeReadError } from "../core/parser/files";
import { type Plan } from "../core/resolve";
import { actualHours, estimateHours, isLeaf, ownerOf, remainingHours } from "../core/rollup";
import { scheduleDiagnostics } from "../core/scheduleDiagnostics";
import { scheduleToJson } from "../core/scheduleJson";
import { findTaskByKey, type Schedule, schedulePlan, taskKey } from "../core/scheduler";
import { countResults } from "../core/testRun";
import { newErrors, type PlanErrors, planErrors } from "../core/newErrors";
import { validatePlan } from "../core/validate";
import { readNotes } from "../core/writer";
import { unassignedCapacitySetting } from "../core/settingValues";
import { findWorkspace, workspaceSettings } from "./settings";
import { type ChangedLines, Staging, ToolError } from "./staging";

export { changedLines, type ChangedLines, ToolError } from "./staging";

export interface ToolsOptions {
  planDir: string;
  /** The workspace folder (settings, TODO comments, relative paths); found when not given. */
  workspaceDir?: string;
  /** Fixed "today" (ISO); defaults to the local date at each call. */
  today?: string;
  unassignedCapacity?: number;
}

/**
 * A task, punch or inbox item by id or key (`file#line`, as list tools return for items without
 * an id), or an inbox item by position: `inbox:<n>` (1-based). The one lookup of every tool.
 */
export function findTask(plan: Plan, ref: string): Task | undefined {
  const r = ref.trim();
  const inbox = /^inbox[:#](\d+)$/i.exec(r);
  if (inbox) return plan.inbox.filter((t) => !t.parent)[Number(inbox[1]) - 1];
  return findTaskByKey(plan, r);
}

export class PlannerTools {
  private loaded!: Plan;
  private scheduled: Schedule | undefined;
  /** The errors of the plan on disk when each staging began. */
  private readonly baselines = new WeakMap<Staging, PlanErrors>();

  constructor(private readonly options: ToolsOptions) {}

  get today(): string {
    return this.options.today ?? localToday();
  }

  get planDir(): string {
    return this.options.planDir;
  }

  get workspaceDir(): string {
    return this.options.workspaceDir ?? findWorkspace(this.options.planDir);
  }

  /**
   * `planner.scheduling.unassignedCapacity`: given to the server, else the workspace setting (read
   * at each schedule, like the other settings), else 40. A value that is not hours is 40, with a
   * line in the server's log (stderr).
   */
  get unassignedCapacity(): number {
    if (this.options.unassignedCapacity !== undefined) return this.options.unassignedCapacity;
    const setting = unassignedCapacitySetting(
      workspaceSettings(this.workspaceDir)["scheduling.unassignedCapacity"]
    );
    if (setting.invalid && setting.invalid !== this.loggedSetting) {
      this.loggedSetting = setting.invalid;
      process.stderr.write(`md-planner MCP server: ${setting.invalid}\n`);
    }
    return setting.hours;
  }

  /** The last setting problem written to the log (each once). */
  private loggedSetting: string | undefined;

  /** The plan as of the last `load` or `commit` (call `load` first). */
  get plan(): Plan {
    return this.loaded;
  }

  /** The schedule of `plan`, computed when first asked for. */
  get schedule(): Schedule {
    return (this.scheduled ??= this.scheduleOf(this.loaded));
  }

  /** True when the plan folder has a project.md (in any casing: `Project.md` is read too). */
  hasPlan(): boolean {
    this.checkFolder();
    let names: string[];
    try {
      names = readdirSync(this.options.planDir);
    } catch (err) {
      if (isMissing(err)) return false;
      throw new ToolError(
        `Cannot read the plan folder ${this.options.planDir}: ${describeReadError(err)}.`
      );
    }
    return names.some((name) => name.toLowerCase() === "project.md");
  }

  /**
   * Refuses a plan folder that is not there when the folder it should be in is not there either:
   * the server was configured for a project that has been moved or deleted since, and creating a
   * plan would bring back the whole old path.
   */
  private checkFolder(): void {
    const dir = this.options.planDir;
    if (existsSync(dir)) return;
    const workspace = this.options.workspaceDir ?? dirname(dir);
    if (existsSync(workspace)) return;
    throw new ToolError(
      `The plan folder ${dir} does not exist, and neither does ${workspace}: this MCP server is configured for a project that was moved or deleted. Re-run "Planner: Configure MCP for Claude Code" in VS Code (or fix the --plan path), then restart the server.`
    );
  }

  private checkPlan(): void {
    if (!this.hasPlan())
      throw new ToolError(
        `There is no plan in ${this.options.planDir} yet (no project.md). Create one with create_project, or with build_plan and project settings.`
      );
  }

  /** Reloads the plan from disk. */
  load(): Plan {
    this.checkPlan();
    this.loaded = loadPlanIndex(this.options.planDir).plan;
    this.scheduled = undefined;
    return this.loaded;
  }

  scheduleOf(plan: Plan, mode: "capacity" | "demand" = "capacity"): Schedule {
    return schedulePlan(plan, {
      today: this.today,
      mode,
      unassignedCapacity: this.unassignedCapacity,
    });
  }

  /** Staged changes on top of the plan on disk (see staging.ts). */
  stage(options: { allowMissingPlan?: boolean } = {}): Staging {
    if (!options.allowMissingPlan) this.checkPlan();
    else this.checkFolder();
    const st = new Staging(this.options.planDir);
    this.baselines.set(st, planErrors(st.exists("project.md") ? st.plan : undefined));
    return st;
  }

  /**
   * Writes staged changes, which then are the plan. Refuses (writing nothing) when the change would
   * add validation errors the plan did not have: unknown dependencies, cycles, duplicate ids …
   */
  commit(
    st: Staging,
    options: { allowErrors?: boolean; renamed?: Array<[from: string, to: string]> } = {}
  ): ChangedLines[] {
    if (!options.allowErrors) {
      const added = this.newErrors(st, options.renamed);
      if (added.length)
        throw new ToolError(
          `Nothing was written: the change would add ${added.length === 1 ? "this error" : "these errors"}:\n- ${added.join("\n- ")}`
        );
    }
    const changed = st.commit();
    if (this.hasPlan()) {
      this.loaded = st.plan;
      this.scheduled = undefined;
    }
    return changed;
  }

  /**
   * Validation errors the staged plan has and the plan on disk does not (see core/newErrors.ts),
   * with the names in `renamed` (old → new) taken as the same.
   */
  newErrors(st: Staging, renamed: Array<[from: string, to: string]> = []): string[] {
    const before =
      this.baselines.get(st) ??
      planErrors(this.hasPlan() ? loadPlanIndex(this.options.planDir).plan : undefined);
    return newErrors(before, planErrors(st.plan), renamed);
  }

  task(id: string, plan: Plan = this.loaded): Task {
    const t = findTask(plan, id);
    if (!t) throw new ToolError(`Unknown task id "${id}".`);
    return t;
  }

  row(t: Task) {
    const ts = this.schedule.tasks.get(t);
    const roll = this.schedule.parents.get(t);
    const start = ts?.start ?? roll?.start;
    const finish = ts?.finish ?? roll?.finish;
    const r = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 100) / 100);
    return {
      id: taskKey(t),
      title: t.title,
      status: t.status,
      milestone: t.milestoneId,
      section: t.section,
      parent: t.parent ? taskKey(t.parent) : undefined,
      owner: ownerOf(t),
      estimate: r(estimateHours(t)),
      actual: r(actualHours(t)) || undefined,
      remaining: r(remainingHours(t)),
      priority: t.prio,
      due: t.due,
      fixedStart: t.start,
      dependsOn: t.deps.map((d) => d.raw),
      tags: t.tags.map((x) => x.tag),
      scheduledStart: start === undefined ? undefined : formatDate(start),
      scheduledFinish: finish === undefined ? undefined : formatDate(finish),
      slack: ts?.slack,
      critical: ts?.critical,
      late: ts?.late,
      overtime: ts
        ? r(taskOvertime(this.schedule).get(ts.key)?.hours ?? 0) || undefined
        : undefined,
      blocked: t.blocked,
      location: `${t.file}:${t.line + 1}`,
    };
  }

  // --- read tools ---------------------------------------------------------------------------

  listTasks(args: {
    milestone?: string;
    owner?: string;
    status?: Status[];
    tag?: string;
    text?: string;
    from?: string;
    to?: string;
    leavesOnly?: boolean;
    limit?: number;
  }) {
    this.load();
    for (const d of [args.from, args.to])
      if (d && !isValidDate(d)) throw new ToolError(`Invalid date "${d}" (YYYY-MM-DD).`);
    const filter: TaskFilter = {
      owner: args.owner ? [args.owner] : undefined,
      milestone: args.milestone ? [args.milestone] : undefined,
      status: args.status,
      tag: args.tag ? [args.tag] : undefined,
      text: args.text,
    };
    const from = args.from ? parseDate(args.from)! : undefined;
    const to = args.to ? parseDate(args.to)! : undefined;
    const tasks = this.plan.tasks.filter((t) => {
      if ((args.leavesOnly ?? true) && !isLeaf(t)) return false;
      if (!matchesFilter(t, filter)) return false;
      if (from !== undefined || to !== undefined) {
        const ts = this.schedule.tasks.get(t) ?? this.schedule.parents.get(t);
        if (!ts || ts.start === undefined || ts.finish === undefined) return false;
        if (from !== undefined && ts.finish < from) return false;
        if (to !== undefined && ts.start > to) return false;
      }
      return true;
    });
    const limit = args.limit ?? 200;
    return {
      count: tasks.length,
      truncated: tasks.length > limit,
      tasks: tasks.slice(0, limit).map((t) => this.row(t)),
    };
  }

  getTask(args: { id: string }) {
    this.load();
    const t = this.task(args.id);
    const dependents = this.plan.tasks
      .filter((x) => x.deps.some((d) => d.id === t.id))
      .map((x) => ({ id: taskKey(x), title: x.title }));
    const file = this.plan.file(t.file)!;
    return {
      ...this.row(t),
      kind: t.kind,
      line: file.lines.line(t.line),
      notes: readNotes(file.lines, t),
      attributes: Object.fromEntries(t.attrs.map((a) => [a.key, a.value])),
      dependencies: t.deps.map((d) => ({
        id: d.id,
        lagHours: d.lagHours,
        title: this.plan.taskById(d.id)?.title,
        status: this.plan.taskById(d.id)?.status,
      })),
      dependents,
      subtasks: t.children.map((c) => this.row(c)),
      milestoneTitle: this.plan.milestoneById(t.milestoneId)?.title,
      test: t.test,
      equipment: t.eq,
      source: t.src,
    };
  }

  getSchedule(args: { milestone?: string }) {
    this.load();
    const json = scheduleToJson(this.plan, this.schedule);
    if (!args.milestone) return json;
    const m = this.plan.milestoneById(args.milestone);
    if (!m) throw new ToolError(`Unknown milestone "${args.milestone}".`);
    return {
      ...json,
      milestones: json.milestones.filter((x) => x.id === m.id),
      tasks: json.tasks.filter((x) => x.milestone === m.id),
      load: undefined,
    };
  }

  getTeamLoad(args: { from?: string; to?: string; mode?: "capacity" | "demand" }) {
    this.load();
    for (const d of [args.from, args.to])
      if (d && !isValidDate(d)) throw new ToolError(`Invalid date "${d}" (YYYY-MM-DD).`);
    const s =
      args.mode === "demand"
        ? schedulePlan(this.plan, {
            today: this.today,
            mode: "demand",
            unassignedCapacity: this.unassignedCapacity,
          })
        : this.schedule;
    const from = args.from ? parseDate(args.from)! : weekStart(s.today);
    const to = args.to ? parseDate(args.to)! : from + 8 * 7 - 1;
    return {
      mode: s.mode,
      from: formatDate(from),
      to: formatDate(to),
      people: teamLoad(this.plan, s, from, to).map((r) => ({
        id: r.id,
        name: r.name,
        weeks: r.weeks.map((w) => ({
          week: w.week,
          hours: Math.round(w.hours * 10) / 10,
          capacity: Math.round(w.capacity * 10) / 10,
          over: w.hours > w.capacity + 0.001,
          daysOff: w.offDays,
          ...(w.overtimeCapacity > 0
            ? {
                overtimeCapacity: Math.round(w.overtimeCapacity * 10) / 10,
                overtime: Math.round(w.overtime * 10) / 10,
              }
            : {}),
        })),
      })),
    };
  }

  getEstimateStats() {
    this.load();
    const acc = estimateAccuracy(this.plan);
    const name = (id: string) => this.plan.personById(id)?.name ?? id;
    return {
      ...acc,
      summary: [
        describeAccuracy(acc.overall, "All completed tasks"),
        ...acc.byPerson.map((r) => describeAccuracy(r, name(r.key))),
        ...acc.byTag.map((r) => describeAccuracy(r, `#${r.key} tasks`)),
      ],
    };
  }

  listTests(args: { id?: string }) {
    this.load();
    const plans = this.plan.tests.filter(
      (t) => !args.id || t.id.toLowerCase() === args.id.toLowerCase()
    );
    if (args.id && plans.length === 0) throw new ToolError(`Unknown test plan "${args.id}".`);
    return plans.map((tp) => ({
      id: tp.id,
      title: tp.title,
      type: tp.type,
      milestone: tp.milestone,
      equipment: tp.eq,
      witness: tp.witness,
      counts: countResults(tp),
      runs: tp.runs.map((r) => ({
        date: r.date,
        ...Object.fromEntries(r.props.entries.map((e) => [e.key, e.value])),
      })),
      cases: tp.cases.map((c) => ({
        id: c.id,
        title: c.title,
        pre: c.pre,
        steps: c.steps
          .flatMap((s) => [s, ...s.children])
          .map((s, i) => ({
            step: i + 1,
            text: s.title,
            result: s.result ?? "open",
            note: s.note,
            punch: s.punch,
          })),
      })),
    }));
  }

  validatePlan() {
    this.load();
    const issues = [
      ...validatePlan(this.plan, { graph: this.schedule.graph }),
      ...scheduleDiagnostics(this.plan, this.schedule, { workload: true }),
    ];
    return {
      errors: issues.filter((i) => i.severity === "error").length,
      warnings: issues.filter((i) => i.severity === "warning").length,
      issues: issues.map((i) => ({
        severity: i.severity,
        code: i.code,
        message: i.message,
        location: `${i.file}:${i.range.start.line + 1}:${i.range.start.character + 1}`,
      })),
    };
  }
}
