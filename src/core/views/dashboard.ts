// Dashboard view model: milestone cards, burn-up, estimate accuracy, attention lists, test and
// punch status. Also used by the HTML status report.
import { type Baseline, milestoneTrends } from "../baseline";
import {
  blockedImpact,
  type BudgetFigures,
  budgetSummary,
  describeBlockedImpact,
  overBudgetReasons,
} from "../budget";
import { formatDate, isoWeekKey, parseDate, weekStart } from "../dates";
import { formatHours } from "../duration";
import {
  attentionLists,
  type BurnUp,
  burnUp,
  type EstimateAccuracy,
  estimateAccuracy,
  projectProgress,
  punchStats,
  type PunchStats,
  testStats,
  type TestStats,
} from "../metrics";
import { type Task } from "../model";
import { milestoneStats, deadlineOf } from "../queries";
import { type Plan } from "../resolve";
import { estimateHours, ownerOf, remainingHours as remainingOf } from "../rollup";
import { taskOvertime } from "../load";
import { type Schedule, taskKey } from "../scheduler";
import { buildResourcesModel, plannedOvertime } from "./resources";

export interface DashboardItem {
  key: string;
  id?: string;
  title: string;
  detail: string;
}

export interface MilestoneCard {
  id: string;
  title: string;
  status: string;
  target?: string;
  forecast?: string;
  late: boolean;
  variance?: number;
  progress: number;
  done: number;
  total: number;
  remaining: number;
  trend?: { baseline: string; slip?: number; baselineForecast?: string };
}

export interface DashboardModel {
  projectName: string;
  code?: string;
  today: string;
  start?: string;
  end?: string;
  progress: number;
  forecastFinish?: string;
  /** Working days between the project end date and the forecast finish (positive = late). */
  endVariance?: number;
  criticalPath: DashboardItem[];
  milestones: MilestoneCard[];
  burnUp: { project: BurnUp; milestones: Record<string, BurnUp> };
  accuracy: EstimateAccuracy;
  personNames: Record<string, string>;
  lists: {
    overdue: DashboardItem[];
    blocked: DashboardItem[];
    startingThisWeek: DashboardItem[];
    unassigned: DashboardItem[];
    unestimated: DashboardItem[];
    /** Tasks with overtime or extra working days from this week on. */
    overtime: DashboardItem[];
  };
  tests: TestStats[];
  punch: PunchStats;
  baseline?: string;
  remainingHours: number;
  /** Overtime and extra working days scheduled from this week on. */
  overtime: { hours: number; byPerson: Array<{ name: string; hours: number; weeks: string[] }> };
  /** Hours: the budget from project.md (if set) against planned, logged and forecast work. */
  budget: BudgetFigures & {
    budget?: number;
    savings: number;
    /** Why the forecast is over the budget (empty when within it). */
    reasons: string[];
    /** Tasks taking longer than estimated, most first. */
    overruns: DashboardItem[];
    unestimated: number;
    milestones: Array<BudgetFigures & { id: string; title: string }>;
    /** The meter: the forecast split into its parts, in hours. */
    bar: BudgetBarPart[];
  };
  /** Blocked tasks: the work that waits for them. */
  blockedWaiting: { tasks: number; hours: number };
}

/** A part of the budget meter, in hours from 0. */
export interface BudgetBarPart {
  /** Logged hours, work done without logged hours, work left, or what lies past the budget. */
  kind: "logged" | "unlogged" | "remaining" | "overrun";
  from: number;
  to: number;
}

/**
 * The budget meter from 0 to the forecast: the logged hours, the work done without logged hours,
 * then the work left, each up to the budget; what lies past the budget is one overrun part.
 */
export function budgetBar(b: BudgetFigures & { budget?: number }): BudgetBarPart[] {
  const limit = Math.min(b.budget ?? Number.POSITIVE_INFINITY, b.forecast);
  const parts: BudgetBarPart[] = [];
  const add = (kind: BudgetBarPart["kind"], from: number, to: number) => {
    if (Math.min(to, limit) > from) parts.push({ kind, from, to: Math.min(to, limit) });
  };
  add("logged", 0, b.spent);
  add("unlogged", b.spent, b.spent + b.unlogged);
  add("remaining", b.spent + b.unlogged, b.forecast);
  if (b.forecast > limit) parts.push({ kind: "overrun", from: limit, to: b.forecast });
  return parts;
}

export function buildDashboardModel(
  plan: Plan,
  schedule: Schedule,
  baseline?: Baseline
): DashboardModel {
  const today = formatDate(schedule.today);
  const trends = baseline ? milestoneTrends(plan, schedule, baseline) : undefined;
  const item = (t: Task, detail: string): DashboardItem => ({
    key: taskKey(t),
    id: t.id,
    title: t.title,
    detail,
  });
  const hoursText = (t: Task) => {
    const h = estimateHours(t);
    return h !== undefined ? ` · ${formatHours(h)}` : "";
  };
  const owner = (t: Task) => {
    const o = ownerOf(t);
    return o ? (plan.personById(o)?.name ?? o) : "unassigned";
  };
  const lists = attentionLists(plan, schedule);
  const budget = budgetSummary(plan);
  const impact = new Map(blockedImpact(plan, schedule).map((b) => [b.task, b]));
  const waitingOnBlocked = new Set([...impact.values()].flatMap((b) => b.waiting));
  const milestones: MilestoneCard[] = plan.milestones
    .filter((m) => m.status !== "cancelled")
    .map((m) => {
      const ms = schedule.milestones.get(m.id);
      const st = milestoneStats(m);
      return {
        id: m.id,
        title: m.title,
        status: m.status,
        target: m.target,
        forecast: ms?.forecast === undefined ? undefined : formatDate(ms.forecast),
        late: ms?.late ?? false,
        variance: ms?.variance,
        progress: st.progress,
        done: st.done,
        total: st.total,
        remaining: Math.round(st.remaining * 10) / 10,
        trend: trends?.get(m.id),
      };
    });
  const end = plan.project.end;
  const endDay = end ? parseDate(end) : undefined;
  const burnMilestones: Record<string, BurnUp> = {};
  for (const m of milestones) burnMilestones[m.id] = burnUp(plan, schedule, m.id);
  const personNames: Record<string, string> = { unassigned: "Unassigned" };
  for (const p of plan.people) personNames[p.id.toLowerCase()] = p.name;
  const remainingHours = milestones.reduce((s, m) => s + m.remaining, 0);
  return {
    projectName: plan.project.name,
    code: plan.project.code,
    today,
    start: plan.project.start,
    end,
    progress: projectProgress(plan),
    forecastFinish: schedule.finish === undefined ? undefined : formatDate(schedule.finish),
    endVariance:
      endDay !== undefined && schedule.finish !== undefined
        ? schedule.calendar.workingDaysLate(endDay, schedule.finish)
        : undefined,
    criticalPath: schedule.criticalPath.map((t) => {
      const ts = schedule.tasks.get(t)!;
      return item(t, `${formatDate(ts.start!)} → ${formatDate(ts.finish!)} · ${owner(t)}`);
    }),
    milestones,
    burnUp: {
      project: { ...burnUp(plan, schedule), budget: plan.project.budget },
      milestones: burnMilestones,
    },
    accuracy: estimateAccuracy(plan),
    personNames,
    lists: {
      overdue: lists.overdue.map((t) => item(t, `due ${deadlineOf(plan, t)} · ${owner(t)}`)),
      blocked: lists.blocked.map((t) => {
        const effect = impact.get(t);
        const why = effect ? describeBlockedImpact(effect) : "";
        return item(t, `${t.blocked ?? "no reason given"} · ${owner(t)}${why ? ` · ${why}` : ""}`);
      }),
      startingThisWeek: lists.startingThisWeek.map((t) => {
        const ts = schedule.tasks.get(t)!;
        return item(t, `${formatDate(ts.start!)} · ${owner(t)}${hoursText(t)}`);
      }),
      unassigned: lists.unassigned.map((t) => item(t, `${t.milestoneId ?? ""}${hoursText(t)}`)),
      unestimated: lists.unestimated.map((t) => item(t, `${t.milestoneId ?? ""} · ${owner(t)}`)),
      overtime: overtimeTasks(schedule).map(({ task, hours, weeks }) =>
        item(task, `${Math.round(hours * 10) / 10} h · ${owner(task)} · ${weeks.join(", ")}`)
      ),
    },
    tests: plan.tests.map(testStats),
    punch: punchStats(plan, today),
    baseline: baseline?.name,
    remainingHours: Math.round(remainingHours * 10) / 10,
    overtime: overtimeSummary(plan, schedule),
    budget: {
      budget: budget.budget,
      planned: budget.planned,
      spent: budget.spent,
      unlogged: budget.unlogged,
      remaining: budget.remaining,
      forecast: budget.forecast,
      savings: budget.savings,
      reasons: overBudgetReasons(budget),
      overruns: budget.overruns.map((o) =>
        item(
          o.task,
          `+${formatHours(o.hours)} over ${formatHours(o.planned)}${o.task.status === "blocked" ? " · blocked" : ""} · ${owner(o.task)}`
        )
      ),
      unestimated: budget.unestimated.length,
      milestones: budget.milestones,
      bar: budgetBar(budget),
    },
    blockedWaiting: {
      tasks: waitingOnBlocked.size,
      hours: Math.round([...waitingOnBlocked].reduce((sum, t) => sum + remainingOf(t), 0)),
    },
  };
}

/** Scheduled overtime from this week to the forecast finish, per person, most first. */
function overtimeSummary(plan: Plan, schedule: Schedule): DashboardModel["overtime"] {
  const from = weekStart(schedule.today);
  const model = buildResourcesModel(plan, schedule, {
    from,
    to: Math.max(schedule.finish ?? from, from),
  });
  const byPerson = plannedOvertime(model)
    .map((p) => ({
      name: p.name,
      hours: Math.round(p.hours * 10) / 10,
      weeks: p.weeks.map((w) => w.week),
    }))
    .sort((a, b) => b.hours - a.hours);
  return {
    hours: Math.round(byPerson.reduce((s, p) => s + p.hours, 0) * 10) / 10,
    byPerson,
  };
}

/** Tasks with overtime or extra working days from this week on, by their first such day. */
function overtimeTasks(schedule: Schedule): Array<{ task: Task; hours: number; weeks: string[] }> {
  const from = weekStart(schedule.today);
  const out: Array<{ task: Task; hours: number; weeks: string[]; first: number }> = [];
  for (const [key, o] of taskOvertime(schedule)) {
    const ts = schedule.byKey.get(key);
    const days = o.days.filter((d) => d.day >= from);
    if (!ts || days.length === 0) continue;
    out.push({
      task: ts.task,
      hours: days.reduce((s, d) => s + d.hours, 0),
      weeks: [...new Set(days.map((d) => isoWeekKey(d.day).slice(-3)))],
      first: days[0].day,
    });
  }
  return out.sort((a, b) => a.first - b.first || a.task.order - b.task.order);
}
