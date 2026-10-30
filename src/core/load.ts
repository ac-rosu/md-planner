// Scheduled hours versus capacity per person and ISO week.
import { UNASSIGNED } from "./calendar";
import { type DayNumber, isoWeekKey, weekStart } from "./dates";
import { type Plan } from "./resolve";
import { type Allocation, type Schedule } from "./scheduler";

export interface WeekLoad {
  week: string;
  /** Monday of the week. */
  start: DayNumber;
  hours: number;
  /** Capacity including overtime and extra working days. */
  capacity: number;
  /** Capacity without overtime and extra working days. */
  normal: number;
  /** Overtime and extra working days planned in `team.md` (capacity − normal). */
  overtimeCapacity: number;
  /** Scheduled hours above the normal capacity, day by day, at most the overtime capacity. */
  overtime: number;
  /** Working days of the person lost to time off in this week. */
  offDays: number;
  /** Task keys with hours in this week. */
  tasks: Map<string, number>;
}

export type LoadLevel = "none" | "under" | "near" | "over";

/** under < 80 % ≤ near ≤ 100 % < over (with a small tolerance for rounding). */
export function loadLevel(hours: number, capacity: number): LoadLevel {
  if (hours <= 0.001) return "none";
  if (capacity <= 0) return "over";
  const ratio = hours / capacity;
  if (ratio > 1.0001) return "over";
  if (ratio >= 0.8) return "near";
  return "under";
}

/** Weekly load of one resource between two days (inclusive), Monday-aligned. */
export function weeklyLoad(
  schedule: Schedule,
  resource: string,
  from: DayNumber,
  to: DayNumber
): WeekLoad[] {
  const id = resource.toLowerCase();
  const cal = schedule.calendar;
  const weeks: WeekLoad[] = [];
  const first = weekStart(from);
  for (let w = first; w <= to; w += 7) {
    let capacity = 0;
    let normal = 0;
    let offDays = 0;
    for (let d = w; d < w + 7; d++) {
      capacity += cal.capacity(id, d);
      normal += cal.normalCapacity(id, d);
      if (cal.isOff(id, d) && cal.isPersonWorkday(id, d)) offDays++;
    }
    const wl: WeekLoad = {
      week: isoWeekKey(w),
      start: w,
      hours: 0,
      capacity,
      normal,
      overtimeCapacity: Math.max(0, capacity - normal),
      overtime: 0,
      offDays,
      tasks: new Map(),
    };
    weeks.push(wl);
  }
  for (const a of allocationsOf(schedule, id)) {
    if (a.day < from || a.day > to) continue;
    const wl = weeks[(weekStart(a.day) - first) / 7];
    if (!wl) continue;
    wl.hours += a.hours;
    wl.tasks.set(a.key, (wl.tasks.get(a.key) ?? 0) + a.hours);
  }
  for (const a of overtimeOf(schedule, id)) {
    if (a.day < from || a.day > to) continue;
    const wl = weeks[(weekStart(a.day) - first) / 7];
    if (wl) wl.overtime += a.hours;
  }
  return weeks;
}

const byResourceCache = new WeakMap<Schedule, Map<string, Allocation[]>>();

/**
 * The allocations of one resource, in the order they were booked. Grouped once per schedule: the
 * team load asks for every person, and a long plan has millions of allocations.
 */
function allocationsOf(schedule: Schedule, resource: string): Allocation[] {
  return groupByResource(byResourceCache, schedule, () => schedule.allocations).get(resource) ?? [];
}

function groupByResource(
  cache: WeakMap<Schedule, Map<string, Allocation[]>>,
  schedule: Schedule,
  allocations: () => Allocation[]
): Map<string, Allocation[]> {
  let groups = cache.get(schedule);
  if (!groups) {
    groups = new Map();
    for (const a of allocations()) {
      const list = groups.get(a.resource);
      if (list) list.push(a);
      else groups.set(a.resource, [a]);
    }
    cache.set(schedule, groups);
  }
  return groups;
}

const overtimeCache = new WeakMap<Schedule, Allocation[]>();
const overtimeByResourceCache = new WeakMap<Schedule, Map<string, Allocation[]>>();

function overtimeOf(schedule: Schedule, resource: string): Allocation[] {
  return (
    groupByResource(overtimeByResourceCache, schedule, () => overtimeAllocations(schedule)).get(
      resource
    ) ?? []
  );
}

/**
 * The overtime part of each allocation: the hours booked on a day above the person's normal
 * capacity, at most the overtime and extra working day hours planned for that day. Tasks get a
 * day's hours in priority order, so the last hours booked on a day are its overtime (and every
 * hour on an extra working day). Only people with overtime or extra working days in team.md can
 * have any: the others' allocations are not looked at.
 */
export function overtimeAllocations(schedule: Schedule): Allocation[] {
  const cached = overtimeCache.get(schedule);
  if (cached) return cached;
  const cal = schedule.calendar;
  // Hours booked so far per resource and day; null for a resource without extra hours.
  const booked = new Map<string, Map<DayNumber, number> | null>();
  const out: Allocation[] = [];
  for (const a of schedule.allocations) {
    let days = booked.get(a.resource);
    if (days === undefined)
      booked.set(a.resource, (days = cal.hasExtraHours(a.resource) ? new Map() : null));
    if (!days) continue;
    const before = days.get(a.day) ?? 0;
    const after = before + a.hours;
    days.set(a.day, after);
    const normal = cal.normalCapacity(a.resource, a.day);
    const extra = cal.overtimeCapacity(a.resource, a.day);
    if (extra <= 0) continue;
    const hours = Math.min(after, normal + extra) - Math.max(before, normal);
    if (hours > 0.001) out.push({ ...a, hours });
  }
  overtimeCache.set(schedule, out);
  return out;
}

export interface TaskOvertime {
  hours: number;
  /** Days with overtime, in order, and whether each is an extra working day. */
  days: Array<{ day: DayNumber; hours: number; extraDay: boolean }>;
}

const taskOvertimeCache = new WeakMap<Schedule, Map<string, TaskOvertime>>();

/** Overtime per task key (tasks without overtime are left out). */
export function taskOvertime(schedule: Schedule): Map<string, TaskOvertime> {
  const cached = taskOvertimeCache.get(schedule);
  if (cached) return cached;
  const cal = schedule.calendar;
  const out = new Map<string, TaskOvertime>();
  for (const a of overtimeAllocations(schedule)) {
    let t = out.get(a.key);
    if (!t) out.set(a.key, (t = { hours: 0, days: [] }));
    t.hours += a.hours;
    t.days.push({
      day: a.day,
      hours: a.hours,
      extraDay: cal.normalCapacity(a.resource, a.day) === 0,
    });
  }
  for (const t of out.values()) t.days.sort((x, y) => x.day - y.day);
  taskOvertimeCache.set(schedule, out);
  return out;
}

/** "1.6 h overtime on 2026-11-02" / "4 h on extra working day 2026-11-27" … for tooltips. */
export function describeOvertime(o: TaskOvertime, format: (d: DayNumber) => string): string {
  const r = (n: number) => Math.round(n * 10) / 10;
  const extra = o.days.filter((d) => d.extraDay);
  const normal = o.days.filter((d) => !d.extraDay);
  const parts: string[] = [];
  const dates = (ds: typeof o.days) =>
    ds.length <= 3
      ? ds.map((d) => format(d.day)).join(", ")
      : `${format(ds[0].day)} … ${format(ds[ds.length - 1].day)} (${ds.length} days)`;
  if (normal.length)
    parts.push(`${r(normal.reduce((s, d) => s + d.hours, 0))} h overtime on ${dates(normal)}`);
  if (extra.length)
    parts.push(
      `${r(extra.reduce((s, d) => s + d.hours, 0))} h on extra working day${extra.length === 1 ? "" : "s"} ${dates(extra)}`
    );
  return parts.join("; ");
}

/** Load of the week containing `day` (used for "34/32 h" labels). */
export function weekLoadAt(schedule: Schedule, resource: string, day: DayNumber): WeekLoad {
  const w = weekStart(day);
  return weeklyLoad(schedule, resource, w, w + 6)[0];
}

export interface TeamLoadRow {
  id: string;
  name: string;
  weeks: WeekLoad[];
}

/** Load of every team member (and the unassigned pool when used) over a range of weeks. */
export function teamLoad(
  plan: Plan,
  schedule: Schedule,
  from: DayNumber,
  to: DayNumber
): TeamLoadRow[] {
  const rows: TeamLoadRow[] = plan.people.map((p) => ({
    id: p.id,
    name: p.name,
    weeks: weeklyLoad(schedule, p.id, from, to),
  }));
  if (schedule.allocations.some((a) => a.resource === UNASSIGNED)) {
    rows.push({
      id: UNASSIGNED,
      name: "Unassigned",
      weeks: weeklyLoad(schedule, UNASSIGNED, from, to),
    });
  }
  return rows;
}

export function formatLoad(hours: number, capacity: number): string {
  const r = (n: number) => String(Math.round(n * 10) / 10);
  return `${r(hours)}/${r(capacity)} h`;
}
