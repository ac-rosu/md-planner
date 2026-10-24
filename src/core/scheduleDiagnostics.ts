// Diagnostics that need a schedule: tasks finishing after their deadline, unschedulable tasks,
// milestones that float, and people whose workload makes tasks late.
import { type DayNumber, formatDate } from "./dates";
import { formatHours } from "./duration";
import { describeLateCause, lateCause, unscheduledCause } from "./lateCause";
import { type Issue } from "./model";
import { isFloatingMilestone, previousMilestone } from "./queries";
import { type Plan } from "./resolve";
import { remainingHours } from "./rollup";
import { range } from "./text";
import { type Schedule } from "./scheduler";
import { lineContentRange } from "./validate";

export function scheduleDiagnostics(
  plan: Plan,
  schedule: Schedule,
  options: { workload?: boolean } = {}
): Issue[] {
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
  if (options.workload) issues.push(...workloadDiagnostics(plan, schedule));
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
 * One info per person whose workload makes their tasks late, on the person's heading in team.md:
 * how much open work they have, until when it is planned, and which tasks finish after their
 * deadline because the person has other work first. (It used to report weeks where everything
 * started at once would exceed capacity, a what-if that read as nonsense: "244h for 36h".)
 */
export function workloadDiagnostics(plan: Plan, schedule: Schedule): Issue[] {
  const issues: Issue[] = [];
  for (const p of plan.people) {
    const id = p.id.toLowerCase();
    const mine = [...schedule.tasks.values()].filter((ts) => ts.resource === id && !ts.done);
    const late = mine.filter((ts) => {
      if (!ts.late) return false;
      const cause = lateCause(schedule, ts.task);
      return cause?.kind === "busy" && cause.resource === id;
    });
    if (late.length === 0) continue;
    const hours = mine.reduce((sum, ts) => sum + remainingHours(ts.task), 0);
    const days = p.workweek?.size ?? plan.project.workweek.size;
    const weekly = p.capacityPer === "week" ? p.capacityHours : p.capacityHours * days;
    const finishes = mine.flatMap((ts) => (ts.finish !== undefined ? [ts.finish] : []));
    const until = finishes.length ? formatDate(Math.max(...finishes)) : undefined;
    const waiting = mine.filter((ts) => ts.unscheduled).length;
    const lateList = late
      .slice(0, 5)
      .map((ts) => {
        const d = schedule.calendar.workingDaysBetween(ts.deadline!, ts.finish!);
        return `${ts.task.id ?? ts.task.title} (${d} working day${d === 1 ? "" : "s"} late)`;
      })
      .join(", ");
    const line = Math.max(0, p.headingLine);
    issues.push({
      file: p.file,
      range: range(line, 0, plan.file(p.file)?.lines.line(line).length ?? 0),
      severity: "info",
      code: "overbooked",
      message:
        `${p.name} has ${formatHours(Math.round(hours * 10) / 10)} of open work` +
        (weekly > 0
          ? `, about ${Math.ceil(hours / weekly)} weeks at ${formatHours(weekly)} a week`
          : "") +
        (until ? `, planned until ${until}` : "") +
        (waiting
          ? ` (${waiting} more task${waiting === 1 ? "" : "s"} cannot be scheduled yet)`
          : "") +
        `. ${late.length === 1 ? "This task finishes" : `${late.length} tasks finish`} after the deadline because ${p.name} has other work first: ${lateList}${late.length > 5 ? ", …" : ""}. Give some of this work to someone else, or move the deadlines.`,
      data: { person: p.id },
    });
  }
  return issues;
}
