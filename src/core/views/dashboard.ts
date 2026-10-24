// Dashboard view model: milestone cards, burn-up, estimate accuracy, attention lists, test and
// punch status. Also used by the HTML status report.
import { type Baseline, milestoneTrends } from "../baseline";
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
import { estimateHours, ownerOf } from "../rollup";
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
        ? schedule.calendar.workingDaysBetween(endDay, schedule.finish)
        : undefined,
    criticalPath: schedule.criticalPath.map((t) => {
      const ts = schedule.tasks.get(t)!;
      return item(t, `${formatDate(ts.start!)} → ${formatDate(ts.finish!)} · ${owner(t)}`);
    }),
    milestones,
    burnUp: { project: burnUp(plan, schedule), milestones: burnMilestones },
    accuracy: estimateAccuracy(plan),
    personNames,
    lists: {
      overdue: lists.overdue.map((t) => item(t, `due ${deadlineOf(plan, t)} · ${owner(t)}`)),
      blocked: lists.blocked.map((t) =>
        item(t, t.blocked ? `${t.blocked} · ${owner(t)}` : `no reason given · ${owner(t)}`)
      ),
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
