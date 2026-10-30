// Project metrics: estimate accuracy, burn-up, attention lists, test and punch statistics.
import { loggedWithinEstimate } from "./budget";
import { type DayNumber, formatDate, parseDate, weekStart } from "./dates";
import { isSchedulableTask } from "./graph";
import { isOpen, type Task, type TestPlan } from "./model";
import { deadlineOf, isOpenTask } from "./queries";
import { type Plan } from "./resolve";
import {
  estimateHours,
  isEffectivelyCancelled,
  isLeaf,
  ownerOf,
  progressOf,
  startedOn,
  workHours,
} from "./rollup";
import { type Schedule } from "./scheduler";

// ---------------------------------------------------------------------------------------------
// Estimate accuracy (deterministic; the AI "Calibrate" command only receives these numbers)

export interface AccuracyRow {
  key: string;
  /** Done tasks with both @est and @act. */
  n: number;
  est: number;
  act: number;
  /** act / est: 1.28 = underestimated by 28 %. */
  ratio: number;
}

export interface EstimateAccuracy {
  overall: AccuracyRow;
  byTag: AccuracyRow[];
  byPerson: AccuracyRow[];
}

/** Tags of a task including its ancestors' tags. */
export function effectiveTags(t: Task): string[] {
  const tags = new Set<string>();
  for (let p: Task | undefined = t; p; p = p.parent) for (const tag of p.tags) tags.add(tag.tag);
  return [...tags];
}

export function estimateAccuracy(plan: Plan): EstimateAccuracy {
  const done = plan.tasks.filter(
    (t) =>
      isLeaf(t) && t.status === "done" && t.est !== undefined && t.est > 0 && t.act !== undefined
  );
  const group = (keyOf: (t: Task) => string[]): AccuracyRow[] => {
    const map = new Map<string, AccuracyRow>();
    for (const t of done) {
      for (const key of keyOf(t)) {
        const row = map.get(key) ?? { key, n: 0, est: 0, act: 0, ratio: 0 };
        row.n++;
        row.est += t.est!;
        row.act += t.act!;
        map.set(key, row);
      }
    }
    return [...map.values()]
      .map((r) => ({ ...r, ratio: r.est > 0 ? r.act / r.est : 0 }))
      .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
  };
  const overall = group(() => ["all"])[0] ?? { key: "all", n: 0, est: 0, act: 0, ratio: 0 };
  return {
    overall,
    byTag: group((t) => effectiveTags(t)),
    byPerson: group((t) => [ownerOf(t)?.toLowerCase() ?? "unassigned"]),
  };
}

/** `#frontend tasks: you underestimate by 28% (n = 14)` */
export function describeAccuracy(row: AccuracyRow, label: string): string {
  const pct = Math.round(Math.abs(row.ratio - 1) * 100);
  if (row.n === 0) return `${label}: no completed tasks with estimate and actual yet`;
  if (pct < 5) return `${label}: estimates are accurate (n = ${row.n})`;
  return `${label}: ${row.ratio > 1 ? "underestimated" : "overestimated"} by ${pct}% (n = ${row.n})`;
}

// ---------------------------------------------------------------------------------------------
// Burn-up

export interface BurnPoint {
  /** Monday of the week (the point is the end of that week). */
  week: DayNumber;
  scope: number;
  done?: number;
  forecast?: number;
}

export interface BurnUp {
  points: BurnPoint[];
  scope: number;
  today: DayNumber;
  /** The project's hours budget, drawn as a line (whole project only). */
  budget?: number;
}

/**
 * Without a project start the burn-up starts at the earliest date found, at most this many days
 * before today (ten years): one mistyped year must not draw a thousand of them.
 */
const MAX_HISTORY_DAYS = 3653;

/** Hours logged on a parent that its own estimate covers, and the day they count from. */
interface LoggedOnParent {
  hours: number;
  day: DayNumber;
}

/**
 * Weekly burn-up of estimated hours. `done` counts completed tasks by their `@done` date (past and
 * current weeks); `forecast` (current and future weeks) counts tasks by their scheduled finish plus
 * the work already done on open tasks; `scope` is the current total estimate. A done task without
 * an estimate counts the hours logged on it (see `workHours`). The chart starts at the project
 * start: work done before it counts there, and work marked done after today counts today.
 */
export function burnUp(plan: Plan, schedule: Schedule, milestoneId?: string): BurnUp {
  const leaves = plan.tasks.filter(
    (t) => (!milestoneId || t.milestoneId === milestoneId) && isBurnUpLeaf(t, schedule)
  );
  const logged = plan.tasks.flatMap((t) => {
    if (milestoneId && t.milestoneId !== milestoneId) return [];
    const p = loggedOnParent(plan, schedule, t);
    return p ? [p] : [];
  });
  return burnUpOf(plan, schedule, leaves, logged);
}

/** The burn-up of each of these milestones (see `burnUp`), going through the plan once. */
export function milestoneBurnUps(
  plan: Plan,
  schedule: Schedule,
  milestoneIds: string[]
): Record<string, BurnUp> {
  const leaves = new Map<string, Task[]>(milestoneIds.map((id) => [id, []]));
  const logged = new Map<string, LoggedOnParent[]>(milestoneIds.map((id) => [id, []]));
  for (const t of plan.tasks) {
    const id = t.milestoneId;
    if (id === undefined || !leaves.has(id)) continue;
    if (isBurnUpLeaf(t, schedule)) leaves.get(id)!.push(t);
    const p = loggedOnParent(plan, schedule, t);
    if (p) logged.get(id)!.push(p);
  }
  const out: Record<string, BurnUp> = {};
  for (const id of milestoneIds)
    out[id] = burnUpOf(plan, schedule, leaves.get(id)!, logged.get(id)!);
  return out;
}

function isBurnUpLeaf(t: Task, schedule: Schedule): boolean {
  return isLeaf(t) && !isEffectivelyCancelled(t) && schedule.tasks.has(t);
}

/**
 * Hours logged on a parent that its own @est covers are planned work already done: its subtasks
 * share only what is left of the estimate (see loggedWithinEstimate). They count from its
 * `@started` (else `@done`, else today).
 */
function loggedOnParent(plan: Plan, schedule: Schedule, t: Task): LoggedOnParent | undefined {
  if (isLeaf(t) || !isSchedulableTask(plan, t)) return undefined;
  const hours = loggedWithinEstimate(t);
  if (hours <= 0) return undefined;
  const on = t.started ?? t.done;
  return { hours, day: (on ? parseDate(on) : undefined) ?? schedule.today };
}

function burnUpOf(
  plan: Plan,
  schedule: Schedule,
  leaves: Task[],
  logged: LoggedOnParent[]
): BurnUp {
  const today = schedule.today;
  const projectStart = plan.project.start ? parseDate(plan.project.start) : undefined;
  // A done task without @done counts at the project start (else at the start of the schedule).
  const doneAt = new Map<Task, DayNumber>();
  for (const t of leaves)
    if (t.status === "done")
      doneAt.set(t, (t.done ? parseDate(t.done) : undefined) ?? projectStart ?? schedule.start);
  let first = projectStart;
  if (first === undefined) {
    first = schedule.start;
    for (const d of doneAt.values()) first = Math.min(first, d);
    for (const p of logged) first = Math.min(first, p.day);
    first = Math.max(first, today - MAX_HISTORY_DAYS);
  }
  const from = first;
  // Hours by the day they count from: for `done` (up to today) and for the forecast (open tasks
  // add what is left of them on their finish; the work done on them counts from the start).
  const done: Array<[DayNumber, number]> = [];
  const forecast: Array<[DayNumber, number]> = [];
  let underWay = 0;
  let scope = 0;
  let last = today;
  for (const t of leaves) {
    const hours = workHours(t) ?? 0;
    scope += hours;
    const d = doneAt.get(t);
    if (d !== undefined) {
      const day = Math.max(from, Math.min(d, today));
      done.push([day, hours]);
      forecast.push([day, hours]);
      continue;
    }
    const finish = schedule.tasks.get(t)!.finish;
    if (finish === undefined) continue;
    if (finish > last) last = finish;
    const worked = hours - Math.max(0, remainingOf(t));
    underWay += worked;
    forecast.push([finish, hours - worked]);
  }
  for (const p of logged) {
    scope += p.hours;
    const day = Math.max(from, p.day);
    done.push([day, p.hours]);
    forecast.push([day, p.hours]);
  }
  done.sort((a, b) => a[0] - b[0]);
  forecast.sort((a, b) => a[0] - b[0]);
  const end = plan.project.end ? Math.max(parseDate(plan.project.end)!, last) : last;
  const points: BurnPoint[] = [];
  const todayWeek = weekStart(today);
  // Running totals: each week adds the hours of the days up to its end.
  let doneSum = 0;
  let doneNext = 0;
  let forecastSum = underWay;
  let forecastNext = 0;
  for (let w = weekStart(from); w <= end + 6; w += 7) {
    const weekEnd = w + 6;
    const point: BurnPoint = { week: w, scope };
    if (w <= todayWeek) {
      const until = Math.min(weekEnd, today);
      while (doneNext < done.length && done[doneNext][0] <= until) doneSum += done[doneNext++][1];
      point.done = doneSum;
    }
    if (weekEnd >= today) {
      while (forecastNext < forecast.length && forecast[forecastNext][0] <= weekEnd)
        forecastSum += forecast[forecastNext++][1];
      point.forecast = forecastSum;
    }
    points.push(point);
  }
  return { points, scope, today };
}

function remainingOf(t: Task): number {
  const est = estimateHours(t) ?? 0;
  if (t.progress !== undefined) return est * (1 - t.progress);
  return Math.max(0, est - (t.act ?? 0));
}

// ---------------------------------------------------------------------------------------------
// Attention lists

export interface AttentionLists {
  overdue: Task[];
  blocked: Task[];
  startingThisWeek: Task[];
  unassigned: Task[];
  unestimated: Task[];
}

export function attentionLists(plan: Plan, schedule: Schedule): AttentionLists {
  const today = formatDate(schedule.today);
  const weekFrom = weekStart(schedule.today);
  const weekTo = weekFrom + 6;
  const open = plan.tasks.filter((t) => isLeaf(t) && isOpenTask(t));
  const startOf = (t: Task) => schedule.tasks.get(t)?.start ?? Number.MAX_SAFE_INTEGER;
  return {
    overdue: open.filter((t) => {
      const d = deadlineOf(plan, t);
      return d !== undefined && d < today;
    }),
    blocked: plan.tasks.filter((t) => t.status === "blocked" && !isEffectivelyCancelled(t)),
    startingThisWeek: open
      .filter((t) => {
        const ts = schedule.tasks.get(t);
        // Not work already under way: started, or in progress or review without @started.
        return (
          ts?.start !== undefined &&
          ts.start >= weekFrom &&
          ts.start <= weekTo &&
          !startedOn(t) &&
          t.status !== "doing" &&
          t.status !== "review"
        );
      })
      .sort((a, b) => startOf(a) - startOf(b) || a.order - b.order),
    unassigned: open.filter((t) => !ownerOf(t)),
    unestimated: open.filter((t) => estimateHours(t) === undefined),
  };
}

// ---------------------------------------------------------------------------------------------
// Tests and punch list

export interface TestStats {
  id: string;
  title: string;
  type?: string;
  milestone?: string;
  steps: number;
  pass: number;
  fail: number;
  na: number;
  open: number;
  cases: number;
  runs: number;
  lastRun?: string;
}

export function testStats(tp: TestPlan): TestStats {
  const steps = tp.cases.flatMap((c) => c.steps.flatMap((s) => [s, ...s.children]));
  const pass = steps.filter((s) => s.result === "pass").length;
  const fail = steps.filter((s) => s.result === "fail").length;
  const na = steps.filter((s) => s.result === "na").length;
  const runs = tp.runs.filter((r) => r.date);
  return {
    id: tp.id,
    title: tp.title,
    type: tp.type,
    milestone: tp.milestone,
    steps: steps.length,
    pass,
    fail,
    na,
    open: steps.length - pass - fail - na,
    cases: tp.cases.length,
    runs: tp.runs.length,
    lastRun: runs.length
      ? runs
          .map((r) => r.date)
          .sort()
          .at(-1)
      : undefined,
  };
}

export interface PunchStats {
  open: number;
  closed: number;
  bySeverity: Record<"A" | "B" | "C" | "none", number>;
  overdue: number;
}

export function punchStats(plan: Plan, today: string): PunchStats {
  const stats: PunchStats = {
    open: 0,
    closed: 0,
    bySeverity: { A: 0, B: 0, C: 0, none: 0 },
    overdue: 0,
  };
  for (const p of plan.punch) {
    if (p.parent) continue;
    if (!isOpen(p.status)) {
      stats.closed++;
      continue;
    }
    stats.open++;
    const sev = (p.sev ?? "none") as keyof PunchStats["bySeverity"];
    stats.bySeverity[sev in stats.bySeverity ? sev : "none"]++;
    if (p.due && p.due < today) stats.overdue++;
  }
  return stats;
}

/** Hours-weighted completion of the whole project (all milestone leaves; see `workHours`). */
export function projectProgress(plan: Plan): number {
  let total = 0;
  let done = 0;
  for (const t of plan.tasks) {
    if (!isLeaf(t) || isEffectivelyCancelled(t)) continue;
    const est = workHours(t) ?? 0;
    total += est;
    done += est * progressOf(t);
  }
  return total > 0 ? done / total : 0;
}
