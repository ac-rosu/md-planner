// Resource heatmap: person × ISO week, scheduled hours versus capacity, time off hatched, planned
// overtime and extra working days marked.
import { UNASSIGNED } from "../calendar";
import { type DayNumber, formatDate, isoWeek, parseDate, weekStart } from "../dates";
import { type LoadLevel, loadLevel, overtimeAllocations, teamLoad } from "../load";
import { type Plan } from "../resolve";
import { findTaskByKey, type Schedule } from "../scheduler";
import { NEUTRAL, personColor } from "./colors";

export interface HeatTask {
  key: string;
  id?: string;
  title: string;
  hours: number;
  /** Of which overtime or extra working day hours. */
  overtime?: number;
}

export interface HeatCell {
  week: string;
  start: DayNumber;
  hours: number;
  /** Capacity including overtime and extra working days. */
  capacity: number;
  /** Capacity without overtime and extra working days. */
  normal: number;
  /** Overtime and extra working days planned in team.md. */
  overtimeCapacity: number;
  /** Scheduled hours above the normal capacity (at most `overtimeCapacity`). */
  overtime: number;
  /** Extra working days (weekends, holidays) of the person in this week, as ISO dates. */
  extraDays: string[];
  level: LoadLevel;
  off: "none" | "part" | "full";
  tasks: HeatTask[];
}

export interface HeatRow {
  id: string;
  name: string;
  role?: string;
  color: string;
  cells: HeatCell[];
  hours: number;
  capacity: number;
  overWeeks: number;
  /** Scheduled overtime over all weeks. */
  overtime: number;
}

export interface ResourcesModel {
  mode: "capacity" | "demand";
  weeks: Array<{ key: string; start: DayNumber; label: string; month: string }>;
  rows: HeatRow[];
  todayWeek: string;
  projectName: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function buildResourcesModel(
  plan: Plan,
  schedule: Schedule,
  options: { from?: DayNumber; to?: DayNumber } = {}
): ResourcesModel {
  const cal = schedule.calendar;
  const projectStart = plan.project.start ? parseDate(plan.project.start)! : schedule.start;
  const projectEnd = plan.project.end
    ? parseDate(plan.project.end)!
    : (schedule.finish ?? schedule.start + 90);
  const from = weekStart(options.from ?? Math.min(projectStart, schedule.today));
  const to = options.to ?? Math.max(projectEnd, schedule.finish ?? projectEnd);
  // Overtime per resource, week and task.
  const overtime = new Map<string, number>();
  for (const a of overtimeAllocations(schedule)) {
    const k = `${a.resource}|${weekStart(a.day)}|${a.key}`;
    overtime.set(k, (overtime.get(k) ?? 0) + a.hours);
  }
  const rows = teamLoad(plan, schedule, from, to).map((row, index): HeatRow => {
    const person = plan.personById(row.id);
    const cells = row.weeks.map((w): HeatCell => {
      let workdays = 0;
      let off = 0;
      const extraDays: string[] = [];
      for (let d = w.start; d < w.start + 7; d++) {
        if (!cal.isPersonWorkday(row.id, d)) {
          if (cal.capacity(row.id, d) > 0) extraDays.push(formatDate(d));
          continue;
        }
        workdays++;
        if (cal.isOff(row.id, d)) off++;
      }
      const tasks = [...w.tasks.entries()]
        .map(([key, hours]) => {
          const t = findTaskByKey(plan, key);
          const ot = overtime.get(`${row.id.toLowerCase()}|${w.start}|${key}`);
          return {
            key,
            id: t?.id,
            title: t?.title ?? key,
            hours: Math.round(hours * 100) / 100,
            ...(ot && ot > 0.05 ? { overtime: Math.round(ot * 10) / 10 } : {}),
          };
        })
        .sort((a, b) => b.hours - a.hours);
      return {
        week: w.week,
        start: w.start,
        hours: Math.round(w.hours * 100) / 100,
        capacity: Math.round(w.capacity * 100) / 100,
        normal: Math.round(w.normal * 100) / 100,
        overtimeCapacity: Math.round(w.overtimeCapacity * 100) / 100,
        overtime: Math.round(w.overtime * 100) / 100,
        extraDays,
        level: loadLevel(w.hours, w.capacity),
        off: workdays > 0 && off === workdays ? "full" : off > 0 ? "part" : "none",
        tasks,
      };
    });
    return {
      id: row.id,
      name: row.name,
      role: person?.role,
      color: row.id === UNASSIGNED ? NEUTRAL : personColor(person?.color, index),
      cells,
      hours: Math.round(cells.reduce((s, c) => s + c.hours, 0) * 10) / 10,
      capacity: Math.round(cells.reduce((s, c) => s + c.capacity, 0) * 10) / 10,
      overWeeks: cells.filter((c) => c.level === "over").length,
      overtime: Math.round(cells.reduce((s, c) => s + c.overtime, 0) * 10) / 10,
    };
  });
  const weeks = (rows[0]?.cells ?? []).map((c) => {
    const date = new Date(c.start * 86_400_000);
    return {
      key: c.week,
      start: c.start,
      label: `W${String(isoWeek(c.start).week).padStart(2, "0")}`,
      month: `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`,
    };
  });
  const tw = isoWeek(schedule.today);
  return {
    mode: schedule.mode,
    weeks,
    rows,
    todayWeek: `${tw.year}-W${String(tw.week).padStart(2, "0")}`,
    projectName: plan.project.name,
  };
}

/** Scheduled overtime per person and week (weeks without overtime left out). */
export function plannedOvertime(model: ResourcesModel): Array<{
  id: string;
  name: string;
  hours: number;
  weeks: Array<{ week: string; hours: number }>;
}> {
  return model.rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      hours: r.overtime,
      weeks: r.cells
        .filter((c) => c.overtime > 0.05)
        .map((c) => ({ week: c.week, hours: c.overtime })),
    }))
    .filter((r) => r.weeks.length > 0);
}

/** Person-weeks over capacity, e.g. `mark: 2026-W47, 2026-W48`. */
export function overloadedWeeks(model: ResourcesModel): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of model.rows) {
    const weeks = r.cells.filter((c) => c.level === "over").map((c) => c.week);
    if (weeks.length) out.set(r.id, weeks);
  }
  return out;
}
