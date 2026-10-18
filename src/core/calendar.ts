// Working calendar: project workweek and holidays, per-person daily capacity with time off,
// capacity changes, overtime and extra working days. All days are UTC day numbers.
import { type DayNumber, isoWeekday } from "./dates";
import { type ExtraWorkday, type Overtime, type Person, type Project } from "./model";

/** Id of the virtual resource that runs unassigned tasks. */
export const UNASSIGNED = "unassigned";

export interface CalendarOptions {
  /** Capacity of the virtual "Unassigned" pool in hours per week. */
  unassignedCapacity: number;
}

export const DEFAULT_CALENDAR_OPTIONS: CalendarOptions = { unassignedCapacity: 40 };

interface Resource {
  workweek: Set<number>;
  base: { hours: number; per: "week" | "day" };
  changes: Array<{ from: DayNumber; hours: number; per: "week" | "day" }>;
  off: Array<[DayNumber, DayNumber]>;
  overtime: Overtime[];
  workdays: ExtraWorkday[];
}

export class Calendar {
  private readonly holidays = new Set<DayNumber>();
  private readonly resources = new Map<string, Resource>();
  private readonly capacityCache = new Map<string, Map<DayNumber, number>>();

  constructor(
    readonly project: Project,
    people: readonly Person[],
    readonly options: CalendarOptions = DEFAULT_CALENDAR_OPTIONS
  ) {
    for (const [from, to] of project.holidays)
      for (let d = from; d <= to; d++) this.holidays.add(d);
    for (const p of people) {
      this.resources.set(p.id.toLowerCase(), {
        workweek: p.workweek ?? project.workweek,
        base: { hours: p.capacityHours, per: p.capacityPer },
        changes: p.capacityChanges,
        off: p.off,
        overtime: p.overtime,
        workdays: p.workdays,
      });
    }
    this.resources.set(UNASSIGNED, {
      workweek: project.workweek,
      base: { hours: options.unassignedCapacity, per: "week" },
      changes: [],
      off: [],
      overtime: [],
      workdays: [],
    });
  }

  get hoursPerDay(): number {
    return this.project.hoursPerDay;
  }

  isHoliday(day: DayNumber): boolean {
    return this.holidays.has(day);
  }

  /** A working day of the project calendar (workweek minus holidays). */
  isWorkingDay(day: DayNumber): boolean {
    return this.project.workweek.has(isoWeekday(day)) && !this.holidays.has(day);
  }

  /** The first working day on or after `day`. */
  nextWorkingDay(day: DayNumber): DayNumber {
    let d = day;
    for (let guard = 0; guard < 3660 && !this.isWorkingDay(d); guard++) d++;
    return d;
  }

  /** The working day `n` working days after `day` (n = 0 → the next working day on or after it). */
  addWorkingDays(day: DayNumber, n: number): DayNumber {
    let d = this.nextWorkingDay(day);
    for (let i = 0; i < n; i++) d = this.nextWorkingDay(d + 1);
    return d;
  }

  /** The last working day on or before `day`. */
  previousWorkingDay(day: DayNumber): DayNumber {
    let d = day;
    for (let guard = 0; guard < 3660 && !this.isWorkingDay(d); guard++) d--;
    return d;
  }

  /** Number of working days in [from, to). Negative when to < from. */
  workingDaysBetween(from: DayNumber, to: DayNumber): number {
    if (to < from) return -this.workingDaysBetween(to, from);
    let n = 0;
    for (let d = from; d < to; d++) if (this.isWorkingDay(d)) n++;
    return n;
  }

  /** Working days per week of the project calendar. */
  get workdaysPerWeek(): number {
    return this.project.workweek.size;
  }

  hasResource(id: string): boolean {
    return this.resources.has(id.toLowerCase());
  }

  /** True when the person is on time off that day (not counting weekends and holidays). */
  isOff(personId: string, day: DayNumber): boolean {
    const r = this.resources.get(personId.toLowerCase());
    return r ? r.off.some(([a, b]) => day >= a && day <= b) : false;
  }

  /** True when the day is in the person's own workweek and not a holiday. */
  isPersonWorkday(personId: string, day: DayNumber): boolean {
    const r = this.resources.get(personId.toLowerCase());
    const ww = r?.workweek ?? this.project.workweek;
    return ww.has(isoWeekday(day)) && !this.holidays.has(day);
  }

  /**
   * Hours the person can work on a day: the normal hours on their working days plus overtime, the
   * hours of an extra working day on weekends and holidays, 0 otherwise and during time off.
   */
  capacity(personId: string, day: DayNumber): number {
    const key = personId.toLowerCase();
    let cache = this.capacityCache.get(key);
    if (!cache) {
      cache = new Map();
      this.capacityCache.set(key, cache);
    }
    const cached = cache.get(day);
    if (cached !== undefined) return cached;
    const value = this.computeCapacity(key, day);
    cache.set(day, value);
    return value;
  }

  /** Hours of a normal working day for the person (no overtime, no extra working days). */
  normalCapacity(personId: string, day: DayNumber): number {
    const r = this.resources.get(personId.toLowerCase());
    if (!r || !this.isRegularDay(r, day) || this.isOffIn(r, day)) return 0;
    return this.dailyHours(r, day);
  }

  /** Capacity above the normal hours: overtime and extra working days. */
  overtimeCapacity(personId: string, day: DayNumber): number {
    return Math.max(0, this.capacity(personId, day) - this.normalCapacity(personId, day));
  }

  /** Sum of daily capacity over the 7 days starting at `from`. */
  weekCapacity(personId: string, from: DayNumber): number {
    let sum = 0;
    for (let d = from; d < from + 7; d++) sum += this.capacity(personId, d);
    return sum;
  }

  /** The nominal weekly capacity in force on a day (ignores time off and holidays). */
  nominalWeeklyCapacity(personId: string, day: DayNumber): number {
    const r = this.resources.get(personId.toLowerCase());
    if (!r) return 0;
    const spec = this.specAt(r, day);
    return spec.per === "week" ? spec.hours : spec.hours * r.workweek.size;
  }

  private specAt(r: Resource, day: DayNumber): { hours: number; per: "week" | "day" } {
    let spec = r.base;
    for (const c of r.changes) if (c.from <= day) spec = c;
    return spec;
  }

  private computeCapacity(key: string, day: DayNumber): number {
    const r = this.resources.get(key);
    if (!r || this.isOffIn(r, day)) return 0;
    if (!this.isRegularDay(r, day)) {
      const extra = r.workdays.find((w) => day >= w.from && day <= w.to);
      return extra ? (extra.hours ?? this.dailyHours(r, day)) : 0;
    }
    let hours = this.dailyHours(r, day);
    for (const o of r.overtime)
      if (day >= o.from && day <= o.to)
        hours += o.per === "day" ? o.hours : o.hours / Math.max(1, r.workweek.size);
    return hours;
  }

  /** A day of the person's own work week that is not a holiday. */
  private isRegularDay(r: Resource, day: DayNumber): boolean {
    return r.workweek.has(isoWeekday(day)) && !this.holidays.has(day);
  }

  private isOffIn(r: Resource, day: DayNumber): boolean {
    return r.off.some(([a, b]) => day >= a && day <= b);
  }

  /** Normal hours per working day from the capacity in force (`h/week` spread over the week). */
  private dailyHours(r: Resource, day: DayNumber): number {
    const spec = this.specAt(r, day);
    return spec.per === "day" ? spec.hours : spec.hours / Math.max(1, r.workweek.size);
  }
}
