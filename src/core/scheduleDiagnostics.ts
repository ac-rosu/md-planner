// Diagnostics that need a schedule: tasks finishing after their deadline, unschedulable tasks and
// (with a demand schedule) overbooked people.
import { formatDate } from "./dates";
import { loadLevel, weeklyLoad } from "./load";
import { type Issue } from "./model";
import { type Plan } from "./resolve";
import { type Schedule } from "./scheduler";
import { lineContentRange } from "./validate";

export function scheduleDiagnostics(plan: Plan, schedule: Schedule, demand?: Schedule): Issue[] {
  const issues: Issue[] = [];
  for (const ts of schedule.tasks.values()) {
    const t = ts.task;
    if (ts.done) continue;
    if (ts.unscheduled === "horizon") {
      issues.push({
        file: t.file,
        range: lineContentRange(plan, t),
        severity: "warning",
        code: "unschedulable",
        message: `Cannot be scheduled: ${ts.resource === "unassigned" ? "the unassigned pool" : ts.resource} has no capacity for it within 10 years.`,
      });
      continue;
    }
    if (ts.unscheduled === "blocked-by-cycle") {
      issues.push({
        file: t.file,
        range: lineContentRange(plan, t),
        severity: "warning",
        code: "blocked-by-cycle",
        message: "Not scheduled: depends on tasks in a circular dependency.",
      });
      continue;
    }
    if (ts.late && ts.finish !== undefined && ts.deadline !== undefined) {
      const late = schedule.calendar.workingDaysBetween(ts.deadline, ts.finish);
      const what = t.due ? `@due ${t.due}` : deadlineSource(plan, t);
      issues.push({
        file: t.file,
        range: lineContentRange(plan, t),
        severity: "warning",
        code: "late-task",
        message: `Scheduled to finish ${formatDate(ts.finish)}, after ${what} (${late} working day${late === 1 ? "" : "s"} late).`,
      });
    }
  }
  if (demand) issues.push(...overbookedDiagnostics(plan, demand));
  return issues;
}

function deadlineSource(plan: Plan, t: Plan["tasks"][number]): string {
  for (let p = t.parent; p; p = p.parent) if (p.due) return `the parent's @due ${p.due}`;
  const m = plan.milestoneById(t.milestoneId);
  return m?.target ? `the ${m.id} target ${m.target}` : "its deadline";
}

/**
 * Info on each task that contributes to a person-week whose demand (ASAP, ignoring capacity)
 * exceeds the person's capacity.
 */
export function overbookedDiagnostics(plan: Plan, demand: Schedule): Issue[] {
  const issues: Issue[] = [];
  const end = demand.finish ?? demand.start;
  for (const p of plan.people) {
    for (const w of weeklyLoad(demand, p.id, demand.start, end)) {
      if (loadLevel(w.hours, w.capacity) !== "over") continue;
      for (const key of w.tasks.keys()) {
        const ts = demand.byKey.get(key);
        if (!ts || ts.done) continue;
        const t = ts.task;
        issues.push({
          file: t.file,
          range: lineContentRange(plan, t),
          severity: "info",
          code: "overbooked",
          message: `${p.name} is overbooked in ${w.week}: ${Math.round(w.hours)}h of work for ${Math.round(w.capacity)}h capacity.`,
          data: { person: p.id, week: w.week },
        });
      }
    }
  }
  return issues;
}
