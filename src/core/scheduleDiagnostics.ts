// Diagnostics that need a schedule: tasks finishing after their deadline, unschedulable tasks and
// (with a demand schedule) overbooked people.
import { type DayNumber, formatDate } from "./dates";
import { describeLateCause, lateCause, unscheduledCause } from "./lateCause";
import { loadLevel, weeklyLoad } from "./load";
import { type Issue } from "./model";
import { isFloatingMilestone, previousMilestone } from "./queries";
import { type Plan } from "./resolve";
import { range } from "./text";
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
        message: `Cannot be scheduled: ${unscheduledCause(plan, schedule, t)}. Give it to someone with time, or change their capacity.`,
      });
      continue;
    }
    if (ts.unscheduled === "waits-for-unscheduled") {
      issues.push({
        file: t.file,
        range: lineContentRange(plan, t),
        severity: "warning",
        code: "blocked-by-unschedulable",
        message: `Not scheduled: ${unscheduledCause(plan, schedule, t)}.`,
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
      const cause = lateCause(schedule, t);
      issues.push({
        file: t.file,
        range: lineContentRange(plan, t),
        severity: "warning",
        code: "late-task",
        message: `Scheduled to finish ${formatDate(ts.finish)}, after ${what} (${late} working day${late === 1 ? "" : "s"} late).${cause ? ` ${describeLateCause(plan, t, cause)}` : ""}`,
      });
    }
  }
  issues.push(...floatingMilestones(plan, schedule));
  if (demand) issues.push(...overbookedDiagnostics(plan, demand));
  return issues;
}

/**
 * Info on a milestone that nothing ties to earlier milestones and whose work starts before the
 * milestone before it finishes: often a milestone added without `depends:`.
 */
function floatingMilestones(plan: Plan, schedule: Schedule): Issue[] {
  const issues: Issue[] = [];
  for (const m of plan.milestones) {
    if (m.status === "done" || m.status === "cancelled" || !isFloatingMilestone(plan, m)) continue;
    const prev = previousMilestone(plan, m);
    const start = openStart(plan, schedule, m.id);
    const finish = prev ? schedule.milestones.get(prev.id)?.forecast : undefined;
    if (!prev || start === undefined || finish === undefined || start > finish) continue;
    const line = Math.max(0, m.headingLine);
    issues.push({
      file: m.file,
      range: range(line, 0, plan.file(m.file)?.lines.line(line).length ?? 0),
      severity: "info",
      code: "floating-milestone",
      message: `${m.id} does not depend on an earlier milestone, so its work starts ${formatDate(start)}, before ${prev.id} finishes (${formatDate(finish)}). Add depends: ${prev.id} if it should wait.`,
      data: { previous: prev.id },
    });
  }
  return issues;
}

/** First scheduled day of a milestone's open work. */
function openStart(plan: Plan, schedule: Schedule, id: string): DayNumber | undefined {
  let start: DayNumber | undefined;
  for (const ts of schedule.tasks.values())
    if (ts.task.milestoneId === id && !ts.done && ts.start !== undefined)
      start = start === undefined ? ts.start : Math.min(start, ts.start);
  return start;
}

function deadlineSource(plan: Plan, t: Plan["tasks"][number]): string {
  for (let p = t.parent; p; p = p.parent) if (p.due) return `the parent's @due ${p.due}`;
  const m = plan.milestoneById(t.milestoneId);
  return m?.target ? `the ${m.id} target ${m.target}` : "its deadline";
}

/**
 * One info per person whose demand (every task as early as it can start, ignoring capacity) exceeds
 * their capacity in some weeks, on the person's heading in team.md. It used to be on every task of
 * those weeks: dozens of notes that did not say where they came from. Tasks that end up late
 * because of it say so in their own late warning.
 */
export function overbookedDiagnostics(plan: Plan, demand: Schedule): Issue[] {
  const issues: Issue[] = [];
  const end = demand.finish ?? demand.start;
  for (const p of plan.people) {
    const over = weeklyLoad(demand, p.id, demand.start, end).filter(
      (w) => loadLevel(w.hours, w.capacity) === "over"
    );
    if (over.length === 0) continue;
    const weeks = over
      .slice(0, 6)
      .map((w) => `${w.week} (${Math.round(w.hours)}h for ${Math.round(w.capacity)}h)`);
    const line = Math.max(0, p.headingLine);
    issues.push({
      file: p.file,
      range: range(line, 0, plan.file(p.file)?.lines.line(line).length ?? 0),
      severity: "info",
      code: "overbooked",
      message: `${p.name} has more work ready than capacity if everything started as early as possible: ${weeks.join(", ")}${over.length > 6 ? `, and ${over.length - 6} more week${over.length - 6 === 1 ? "" : "s"}` : ""}. The schedule spreads this work over later weeks; tasks that end up late because of it say so. Team load → Demand shows these weeks.`,
      data: { person: p.id, weeks: over.map((w) => w.week).join(",") },
    });
  }
  return issues;
}
