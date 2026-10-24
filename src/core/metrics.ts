// Project metrics: estimate accuracy, burn-up, attention lists, test and punch statistics.
import { type DayNumber, formatDate, parseDate, weekStart } from "./dates";
import { isOpen, type Task, type TestPlan } from "./model";
import { deadlineOf, isOpenTask } from "./queries";
import { type Plan } from "./resolve";
import { isEffectivelyCancelled, isLeaf, ownerOf, progressOf, startedOn } from "./rollup";
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
}

/**
 * Weekly burn-up of estimated hours. `done` counts completed tasks by their `@done` date (past and
 * current weeks); `forecast` (current and future weeks) counts tasks by their scheduled finish plus
 * the work already done on open tasks; `scope` is the current total estimate.
 */
export function burnUp(plan: Plan, schedule: Schedule, milestoneId?: string): BurnUp {
  const leaves = plan.tasks.filter(
    (t) =>
      isLeaf(t) &&
      !isEffectivelyCancelled(t) &&
      (!milestoneId || t.milestoneId === milestoneId) &&
      schedule.tasks.has(t)
  );
  const scope = leaves.reduce((s, t) => s + (t.est ?? 0), 0);
  const projectStart = plan.project.start ? parseDate(plan.project.start)! : schedule.start;
  let first = projectStart;
  let last = schedule.today;
  const doneAt = new Map<Task, DayNumber>();
  for (const t of leaves) {
    const ts = schedule.tasks.get(t)!;
    if (t.status === "done") {
      const d = t.done ? parseDate(t.done)! : projectStart;
      doneAt.set(t, d);
      if (d < first) first = d;
    }
    if (ts.finish !== undefined && ts.finish > last) last = ts.finish;
  }
  const end = plan.project.end ? Math.max(parseDate(plan.project.end)!, last) : last;
  const points: BurnPoint[] = [];
  const todayWeek = weekStart(schedule.today);
  for (let w = weekStart(first); w <= end + 6; w += 7) {
    const weekEnd = w + 6;
    const point: BurnPoint = { week: w, scope };
    if (w <= todayWeek) {
      let done = 0;
      for (const t of leaves) {
        const d = doneAt.get(t);
        if (d !== undefined && d <= Math.min(weekEnd, schedule.today)) done += t.est ?? 0;
      }
      point.done = done;
    }
    if (weekEnd >= schedule.today) {
      let forecast = 0;
      for (const t of leaves) {
        const ts = schedule.tasks.get(t)!;
        const finish = t.status === "done" ? doneAt.get(t) : ts.finish;
        if (finish !== undefined && finish <= weekEnd) forecast += t.est ?? 0;
        else if (t.status !== "done" && finish !== undefined)
          forecast += (t.est ?? 0) - Math.max(0, remainingOf(t));
      }
      point.forecast = forecast;
    }
    points.push(point);
  }
  return { points, scope, today: schedule.today };
}

function remainingOf(t: Task): number {
  const est = t.est ?? 0;
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
        return (
          ts?.start !== undefined && ts.start >= weekFrom && ts.start <= weekTo && !startedOn(t)
        );
      })
      .sort((a, b) => startOf(a) - startOf(b) || a.order - b.order),
    unassigned: open.filter((t) => !ownerOf(t)),
    unestimated: open.filter((t) => t.est === undefined),
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

/** Hours-weighted completion of the whole project (all milestone leaves). */
export function projectProgress(plan: Plan): number {
  let total = 0;
  let done = 0;
  for (const t of plan.tasks) {
    if (!isLeaf(t) || isEffectivelyCancelled(t)) continue;
    const est = t.est ?? 0;
    total += est;
    done += est * progressOf(t);
  }
  return total > 0 ? done / total : 0;
}
