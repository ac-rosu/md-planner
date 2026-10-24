// Hours budget of the project (`budget:` in project.md) against the plan: what is estimated, what
// has been logged, what the project will take at this rate, and why it goes over. Pure; the
// dashboard, the status report, the diagnostics and the MCP server all use it.
import { formatDate } from "./dates";
import { type DepNode, isSchedulableTask } from "./graph";
import { type Issue, type Task } from "./model";
import { type Plan } from "./resolve";
import {
  estimateHours,
  isEffectivelyCancelled,
  isEffectivelyDone,
  isLeaf,
  leavesOf,
  remainingHours,
} from "./rollup";
import { type Schedule } from "./scheduler";

export interface BudgetFigures {
  /** Sum of the estimates of the tasks that are not cancelled. */
  planned: number;
  /** Hours logged (`@act`), on cancelled tasks too: those hours were spent. */
  spent: number;
  /** Work still to do. */
  remaining: number;
  /** What the work will take: logged (or, without `@act`, estimated) hours plus the remaining. */
  forecast: number;
}

export interface BudgetSummary extends BudgetFigures {
  /** From project.md; undefined when no budget is set. */
  budget?: number;
  /** Open tasks without an estimate: the forecast does not include them yet. */
  unestimated: Task[];
  /** Tasks that take more than their estimate, by how much (most first). */
  overruns: Array<{ task: Task; hours: number }>;
  /** Hours saved on tasks that took less than their estimate. */
  savings: number;
  milestones: Array<BudgetFigures & { id: string; title: string }>;
}

const round = (h: number) => Math.round(h * 10) / 10;

/** Forecast hours of one leaf task (see BudgetFigures.forecast). */
function leafForecast(t: Task): number {
  if (isEffectivelyCancelled(t)) return t.act ?? 0;
  const est = estimateHours(t) ?? 0;
  if (isEffectivelyDone(t)) return t.act ?? est;
  const done = t.act ?? (t.progress !== undefined ? est * t.progress : 0);
  return done + remainingHours(t);
}

export function budgetSummary(plan: Plan): BudgetSummary {
  const leaves = plan.tasks.filter(isLeaf);
  const figures = (tasks: Task[]): BudgetFigures => {
    let planned = 0;
    let spent = 0;
    let remaining = 0;
    let forecast = 0;
    for (const t of tasks) {
      spent += t.act ?? 0;
      forecast += leafForecast(t);
      if (isEffectivelyCancelled(t) || !isSchedulableTask(plan, t)) continue;
      planned += estimateHours(t) ?? 0;
      remaining += remainingHours(t);
    }
    return {
      planned: round(planned),
      spent: round(spent),
      remaining: round(remaining),
      forecast: round(forecast),
    };
  };
  const counted = leaves.filter((t) => !isEffectivelyCancelled(t) && isSchedulableTask(plan, t));
  const overruns: BudgetSummary["overruns"] = [];
  let savings = 0;
  for (const t of counted) {
    const est = estimateHours(t);
    if (est === undefined) continue;
    const diff = leafForecast(t) - est;
    if (diff > 0.05) overruns.push({ task: t, hours: round(diff) });
    else if (diff < -0.05) savings += -diff;
  }
  overruns.sort((a, b) => b.hours - a.hours || a.task.order - b.task.order);
  return {
    budget: plan.project.budget,
    ...figures(leaves),
    unestimated: counted.filter((t) => !isEffectivelyDone(t) && estimateHours(t) === undefined),
    overruns,
    savings: round(savings),
    milestones: plan.milestones
      .filter((m) => m.status !== "cancelled")
      .map((m) => ({
        id: m.id,
        title: m.title,
        ...figures(leaves.filter((t) => t.milestoneId === m.id)),
      })),
  };
}

/**
 * Why the forecast is over the budget, in plain words, biggest cause first: estimates that already
 * add up to more than the budget, tasks taking longer than estimated (blocked ones named as
 * such), and open tasks that have no estimate yet. Empty when within the budget or without one.
 */
export function overBudgetReasons(s: BudgetSummary): string[] {
  if (s.budget === undefined || s.forecast <= s.budget) return [];
  const h = (n: number) => `${Math.round(n)} h`;
  const out: string[] = [];
  if (s.planned > s.budget)
    out.push(
      `The estimates add up to ${h(s.planned)}, ${h(s.planned - s.budget)} over the budget.`
    );
  else out.push(`The estimates add up to ${h(s.planned)}, within the budget.`);
  const over = s.overruns.reduce((sum, o) => sum + o.hours, 0);
  if (over > 0) {
    const names = s.overruns
      .slice(0, 4)
      .map(
        (o) =>
          `${o.task.id ?? o.task.title} +${h(o.hours)}${o.task.status === "blocked" ? " (blocked)" : ""}`
      )
      .join(", ");
    const more = s.overruns.length > 4 ? ` and ${s.overruns.length - 4} more` : "";
    out.push(`Tasks taking longer than estimated add ${h(over)}: ${names}${more}.`);
  }
  if (s.savings > 0) out.push(`Tasks done in less than their estimate save ${h(s.savings)}.`);
  if (s.unestimated.length)
    out.push(
      `${s.unestimated.length} open task(s) have no estimate yet, so the forecast will grow: ${s.unestimated
        .slice(0, 4)
        .map((t) => t.id ?? t.title)
        .join(", ")}${s.unestimated.length > 4 ? ", …" : ""}.`
    );
  return out;
}

export interface BlockedImpact {
  task: Task;
  /** Work left on the blocked task itself. */
  hours: number;
  /** Open tasks that wait for it (directly or further down the chain), and their remaining work. */
  waiting: Task[];
  waitingHours: number;
  /** On the critical path: once its slack is used up, every day blocked moves the end date. */
  critical: boolean;
  /** The last working day it can stay blocked without delaying anything; undefined if unknown. */
  until?: string;
  /** Already later than that: it is holding the plan up now. */
  late: boolean;
}

/**
 * What each blocked task holds up. The schedule plans blocked tasks as if they could go ahead;
 * this says how long they can stay blocked before something moves: their latest start (scheduled
 * start plus slack), and the work that waits for them.
 */
export function blockedImpact(plan: Plan, schedule: Schedule): BlockedImpact[] {
  const graph = schedule.graph;
  const cal = schedule.calendar;
  const out: BlockedImpact[] = [];
  const blockedTasks = plan.tasks.filter(
    (t) => t.status === "blocked" && !isEffectivelyCancelled(t)
  );
  if (blockedTasks.length === 0) return out;
  const groupsOf = new Map<Task, DepNode[]>();
  for (const g of graph.groups.values())
    for (const m of g.members) groupsOf.set(m, [...(groupsOf.get(m) ?? []), g]);
  for (const blocked of blockedTasks) {
    const leaves = isLeaf(blocked) ? [blocked] : leavesOf(blocked);
    const own = new Set(leaves);
    // Everything that waits for one of its leaves, through tasks, parents and milestones; each
    // node's dependents are looked at once.
    const waiting = new Set<Task>();
    const seen = new Set<DepNode>();
    const queue = [...leaves];
    for (let i = 0; i < queue.length; i++) {
      const t = queue[i];
      const leaf = graph.leafNode.get(t);
      for (const n of [...(leaf ? [leaf] : []), ...(groupsOf.get(t) ?? [])]) {
        if (seen.has(n)) continue;
        seen.add(n);
        for (const d of graph.dependents.get(n) ?? [])
          if (!waiting.has(d) && !own.has(d)) {
            waiting.add(d);
            queue.push(d);
          }
      }
    }
    const open = [...waiting].filter((t) => !isEffectivelyDone(t) && !isEffectivelyCancelled(t));
    // It can stay blocked until the working day before its latest start (start + slack).
    let latest: number | undefined;
    let critical = false;
    for (const l of leaves) {
      const ts = schedule.tasks.get(l);
      if (!ts || ts.done || ts.start === undefined || ts.slack === undefined) continue;
      critical ||= ts.critical;
      const latestStart = cal.addWorkingDays(Math.max(ts.start, schedule.start), ts.slack);
      const lastOk = ts.slack < 0 ? schedule.start - 1 : cal.previousWorkingDay(latestStart - 1);
      latest = latest === undefined ? lastOk : Math.min(latest, lastOk);
    }
    out.push({
      task: blocked,
      hours: round(leaves.reduce((s, l) => s + remainingHours(l), 0)),
      waiting: open,
      waitingHours: round(open.reduce((s, t) => s + remainingHours(t), 0)),
      critical,
      until: latest === undefined ? undefined : formatDate(latest),
      late: latest !== undefined && latest < schedule.start,
    });
  }
  return out;
}

/** "3 tasks (24 h) wait for it · can stay blocked until 2026-10-21" for the dashboard. */
export function describeBlockedImpact(b: BlockedImpact): string {
  const parts: string[] = [];
  if (b.waiting.length)
    parts.push(
      `${b.waiting.length} task${b.waiting.length === 1 ? "" : "s"} (${Math.round(b.waitingHours)} h) wait${b.waiting.length === 1 ? "s" : ""} for it`
    );
  if (b.late)
    parts.push(
      b.critical
        ? "already delaying the end date: every day blocked moves it"
        : "already delaying the plan"
    );
  else if (b.until)
    parts.push(
      `can stay blocked until ${b.until}${b.critical ? " (critical path: after that the end date moves)" : ""}`
    );
  return parts.join(" · ");
}

/** A warning on `budget:` in project.md when the forecast is over it, with the reasons. */
export function budgetIssues(plan: Plan): Issue[] {
  const entry = plan.project.props.entries.find((e) => e.key.toLowerCase() === "budget");
  const s = budgetSummary(plan);
  if (!entry || s.budget === undefined || s.forecast <= s.budget) return [];
  const h = (n: number) => `${Math.round(n)} h`;
  return [
    {
      file: plan.project.file,
      range: entry.valueRange,
      severity: "warning",
      code: "over-budget",
      message: `Forecast ${h(s.forecast)} is ${h(s.forecast - s.budget)} over the budget of ${h(s.budget)}. ${overBudgetReasons(s).join(" ")}`,
    },
  ];
}
