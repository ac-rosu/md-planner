// Stable JSON form of a schedule: written to plan/.planner/schedule.json, returned by the MCP
// server and the CLI, and compared byte for byte by the golden schedule test.
import { formatDate } from "./dates";
import { taskOvertime, teamLoad } from "./load";
import { type Plan } from "./resolve";
import { type Schedule } from "./scheduler";

export interface ScheduleJson {
  today: string;
  mode: string;
  start: string;
  finish?: string;
  reference?: string;
  criticalPath: string[];
  milestones: Array<{
    id: string;
    title: string;
    target?: string;
    start?: string;
    forecast?: string;
    late: boolean;
    variance?: number;
    progress: number;
  }>;
  tasks: Array<{
    id: string;
    title: string;
    milestone?: string;
    owner: string;
    status: string;
    start?: string;
    finish?: string;
    hours: number;
    slack?: number;
    critical: boolean;
    late: boolean;
    deadline?: string;
    unscheduled?: string;
    flags?: string[];
    /** Hours of overtime and extra working days (only when there are any). */
    overtime?: number;
  }>;
  load: Array<{
    person: string;
    week: string;
    hours: number;
    capacity: number;
    /** Hours scheduled as overtime or on extra working days (only when there are any). */
    overtime?: number;
  }>;
}

const d = (n: number | undefined) => (n === undefined ? undefined : formatDate(n));
const r2 = (n: number) => Math.round(n * 100) / 100;

export function scheduleToJson(plan: Plan, s: Schedule): ScheduleJson {
  const overtime = taskOvertime(s);
  const tasks = [...s.tasks.values()]
    .sort((a, b) => a.task.order - b.task.order)
    .map((ts) => {
      const flags: string[] = [];
      if (ts.unassigned) flags.push("unassigned");
      if (ts.unknownOwner) flags.push("unknown-owner");
      if (ts.unestimated && !ts.done) flags.push("unestimated");
      return {
        id: ts.key,
        title: ts.task.title,
        milestone: ts.task.milestoneId,
        owner: ts.resource,
        status: ts.task.status,
        start: d(ts.start),
        finish: d(ts.finish),
        hours: r2(ts.scheduledHours),
        slack: ts.slack,
        critical: ts.critical,
        late: ts.late,
        deadline: d(ts.deadline),
        unscheduled: ts.unscheduled,
        flags: flags.length ? flags : undefined,
        overtime: overtime.has(ts.key) ? r2(overtime.get(ts.key)!.hours) : undefined,
      };
    });
  const milestones = plan.milestones.map((m) => {
    const ms = s.milestones.get(m.id)!;
    return {
      id: m.id,
      title: m.title,
      target: d(ms.target),
      start: d(ms.start),
      forecast: d(ms.forecast),
      late: ms.late,
      variance: ms.variance,
      progress: r2(ms.progress),
    };
  });
  const from = s.start;
  const to = Math.max(s.finish ?? s.start, s.start);
  const load = teamLoad(plan, s, from, to).flatMap((row) =>
    row.weeks
      .filter((w) => w.hours > 0)
      .map((w) => ({
        person: row.id,
        week: w.week,
        hours: r2(w.hours),
        capacity: r2(w.capacity),
        ...(w.overtime > 0.001 ? { overtime: r2(w.overtime) } : {}),
      }))
  );
  return {
    today: formatDate(s.today),
    mode: s.mode,
    start: formatDate(s.start),
    finish: d(s.finish),
    reference: d(s.reference),
    criticalPath: s.criticalPath.map((t) => t.id ?? `${t.file}#${t.line + 1}`),
    milestones,
    tasks,
    load,
  };
}

export function scheduleJsonText(plan: Plan, s: Schedule): string {
  return JSON.stringify(scheduleToJson(plan, s), null, 2) + "\n";
}
