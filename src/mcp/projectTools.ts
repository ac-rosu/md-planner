// Project tools: create a plan from a template (also when there is no plan yet), change the
// project settings, and an overview of the whole plan for an agent to start from.
import { budgetSummary, overBudgetReasons } from "../core/budget";
import { formatDate, isValidDate, parseWorkweek } from "../core/dates";
import { ambiguousBudgetMessage, parseBudget } from "../core/resolve";
import { listItems, type ProjectChange, changeProject } from "../core/writer/entities";
import { defaultEndDate, instantiateTemplate } from "../core/templates";
import { milestoneStats } from "../core/queries";
import { nextId } from "../core/writer";
import { nextMilestoneId } from "../core/writer/entities";
import { type Staging } from "./staging";
import { workspacePath } from "./paths";
import { availableTemplates } from "./templates";
import { type PlannerTools, ToolError } from "./tools";

export interface ProjectSettings {
  name?: string;
  code?: string;
  start?: string;
  end?: string;
  /** e.g. mon-fri, mon-thu, sun-thu */
  workweek?: string;
  hoursPerDay?: number;
  /** Hours budget: `1200h`, `150d`, `30w` or a number of hours; "" removes it. */
  budget?: string;
  /** Replaces the holidays: dates or ranges from..to. */
  holidays?: string[];
  addHolidays?: string[];
  removeHolidays?: string[];
}

/** A custom templates folder from a tool call: inside the workspace only. */
function templatesFolder(tools: PlannerTools, folder: string | undefined): string | undefined {
  return folder ? workspacePath(tools.workspaceDir, folder, "templatesFolder") : undefined;
}

export function listTemplates(tools: PlannerTools, args: { templatesFolder?: string }) {
  return availableTemplates(templatesFolder(tools, args.templatesFolder)).map((t) => ({
    name: t.name,
    description: t.description,
    files: Object.keys(t.files).sort(),
  }));
}

export interface CreateProjectArgs extends ProjectSettings {
  name: string;
  /** "empty" (default), "blank", "software" or a custom template from templatesFolder. */
  template?: string;
  templatesFolder?: string;
  /** Name of the first team member (the project lead), added to team.md. */
  lead?: string;
}

/** Stages a new plan folder; refuses when project.md exists. */
export function stageProject(tools: PlannerTools, st: Staging, args: CreateProjectArgs): void {
  if (st.exists("project.md"))
    throw new ToolError(`There is already a plan in ${tools.planDir} (project.md exists).`);
  if (!args.name?.trim()) throw new ToolError("The project needs a name.");
  const start = args.start ?? tools.today;
  if (!isValidDate(start)) throw new ToolError(`Invalid start date "${start}" (YYYY-MM-DD).`);
  const end = args.end ?? defaultEndDate(start);
  if (!isValidDate(end)) throw new ToolError(`Invalid end date "${end}" (YYYY-MM-DD).`);
  if (end < start) throw new ToolError("The end date is before the start date.");
  const name = args.template ?? "empty";
  const templates = availableTemplates(templatesFolder(tools, args.templatesFolder));
  const template = templates.find((t) => t.name === name);
  if (!template)
    throw new ToolError(`Unknown template "${name}" (${templates.map((t) => t.name).join(", ")}).`);
  const files = instantiateTemplate(template.files, {
    name: args.name.trim(),
    code: args.code?.trim() || undefined,
    start,
    end,
    today: tools.today,
    lead: name === "empty" ? undefined : args.lead?.trim() || undefined,
  });
  for (const [path, text] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))
    st.create(path, text);
  applySettings(st, {
    ...args,
    name: undefined,
    code: undefined,
    start: undefined,
    end: undefined,
  });
}

export function createProject(tools: PlannerTools, args: CreateProjectArgs) {
  const st = tools.stage({ allowMissingPlan: true });
  stageProject(tools, st, args);
  const changed = tools.commit(st);
  return { planFolder: tools.planDir, template: args.template ?? "empty", changed };
}

export function updateProject(tools: PlannerTools, args: ProjectSettings) {
  const st = tools.stage();
  applySettings(st, args);
  return { changed: tools.commit(st) };
}

/** Validates and stages project settings on the staged project.md. */
export function applySettings(st: Staging, args: ProjectSettings): void {
  const plan = st.plan;
  const file = plan.file(plan.project.file);
  if (!file) throw new ToolError("There is no project.md.");
  for (const [key, value] of [
    ["start", args.start],
    ["end", args.end],
  ] as const)
    if (value !== undefined && value !== "" && !isValidDate(value))
      throw new ToolError(`Invalid ${key} date "${value}" (YYYY-MM-DD).`);
  if (args.workweek !== undefined && args.workweek !== "" && !parseWorkweek(args.workweek))
    throw new ToolError(`Invalid work week "${args.workweek}" (e.g. mon-fri, mon-thu, sun-thu).`);
  if (args.hoursPerDay !== undefined && !(args.hoursPerDay > 0 && args.hoursPerDay <= 24))
    throw new ToolError(`Invalid hours per day ${args.hoursPerDay} (more than 0, at most 24).`);
  if (
    args.budget !== undefined &&
    args.budget.trim() !== "" &&
    parseBudget(args.budget, args.hoursPerDay ?? plan.project.hoursPerDay) === undefined
  ) {
    throw new ToolError(
      ambiguousBudgetMessage(args.budget) ??
        `Invalid budget "${args.budget}" (hours such as 1200h, or 150d, 30w).`
    );
  }
  let holidays: string[] | undefined;
  if (args.holidays || args.addHolidays || args.removeHolidays) {
    const current = listItems(
      plan.project.props.entries.find((e) => e.key.toLowerCase() === "holidays")?.value ?? ""
    );
    const remove = new Set(args.removeHolidays ?? []);
    holidays = [...(args.holidays ?? current), ...(args.addHolidays ?? [])].filter(
      (h, i, all) => !remove.has(h) && all.indexOf(h) === i
    );
    for (const h of holidays)
      if (!/^\d{4}-\d{2}-\d{2}(\.\.\d{4}-\d{2}-\d{2})?$/.test(h) || !isValidDate(h.slice(0, 10)))
        throw new ToolError(`Invalid holiday "${h}" (YYYY-MM-DD or YYYY-MM-DD..YYYY-MM-DD).`);
    holidays.sort();
  }
  const change: ProjectChange = {
    name: args.name,
    code: args.code,
    start: args.start,
    end: args.end,
    workweek: args.workweek,
    hoursPerDay: args.hoursPerDay === undefined ? undefined : String(args.hoursPerDay),
    budget: args.budget,
    holidays,
  };
  st.apply({ path: file.path, edits: changeProject(file.lines, plan.project, change) });
}

/** Everything an agent needs to know about the plan in one call. */
export function planOverview(tools: PlannerTools) {
  if (!tools.hasPlan())
    return {
      planFolder: tools.planDir,
      exists: false,
      hint: "There is no plan yet. Call create_project, or build_plan with project settings.",
    };
  const plan = tools.load();
  const s = tools.schedule;
  const fmt = (d: number | undefined) => (d === undefined ? undefined : formatDate(d));
  const range = ([a, b]: [number, number]) => (a === b ? fmt(a) : `${fmt(a)}..${fmt(b)}`);
  const p = plan.project;
  return {
    planFolder: tools.planDir,
    exists: true,
    today: tools.today,
    project: {
      name: p.name,
      code: p.code,
      start: p.start,
      end: p.end,
      workweek: p.workweekText,
      hoursPerDay: p.hoursPerDay,
      holidays: p.holidays.map(range),
      forecastFinish: fmt(s.finish),
      hours: (() => {
        const b = budgetSummary(plan);
        return {
          budget: b.budget,
          planned: b.planned,
          logged: b.spent,
          remaining: b.remaining,
          forecast: b.forecast,
          overBudget: b.budget !== undefined ? Math.max(0, b.forecast - b.budget) : undefined,
          whyOverBudget: overBudgetReasons(b),
        };
      })(),
    },
    people: plan.people.map((x) => ({
      id: x.id,
      name: x.name,
      role: x.role,
      capacity: `${x.capacityHours}h/${x.capacityPer}`,
      workweek: x.workweek ? [...x.workweek].join(",") : undefined,
      skills: x.skills,
      color: x.color,
      timeOff: x.off.map(range),
      capacityChanges: x.capacityChanges.map((c) => `${fmt(c.from)} ${c.hours}h/${c.per}`),
      overtime: x.overtime.map((o) => `${range([o.from, o.to])} +${o.hours}h/${o.per}`),
      extraWorkdays: x.workdays.map(
        (w) => `${range([w.from, w.to])}${w.hours !== undefined ? ` ${w.hours}h` : ""}`
      ),
    })),
    milestones: plan.milestones.map((m) => {
      const ms = s.milestones.get(m.id);
      const st = milestoneStats(m);
      return {
        id: m.id,
        title: m.title,
        file: m.file,
        status: m.status,
        target: m.target,
        depends: m.depends,
        forecast: fmt(ms?.forecast),
        late: ms?.late ?? false,
        variance: ms?.variance,
        progress: Math.round(st.progress * 100) / 100,
        tasks: { done: st.done, total: st.total },
        sections: m.sections.map((x) => ({ title: x.title, tasks: x.tasks.length })),
      };
    }),
    counts: {
      tasks: plan.tasks.length,
      openTasks: plan.tasks.filter((t) => !["done", "cancelled"].includes(t.status)).length,
      inbox: plan.inbox.filter((t) => !t.parent).length,
      openPunchItems: plan.punch.filter(
        (t) => !t.parent && !["done", "cancelled"].includes(t.status)
      ).length,
      testPlans: plan.tests.length,
      issues: plan.issues.length,
    },
    tests: plan.tests.map((t) => ({
      id: t.id,
      title: t.title,
      type: t.type,
      milestone: t.milestone,
    })),
    nextIds: {
      task: nextId(plan, "T"),
      punch: nextId(plan, "P"),
      milestone: nextMilestoneId(plan),
    },
    criticalPath: s.criticalPath.map((t) => t.id ?? t.title),
  };
}
