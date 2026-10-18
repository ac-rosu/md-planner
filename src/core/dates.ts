// Date helpers. Dates are ISO strings (YYYY-MM-DD); arithmetic uses UTC day numbers
// (days since 1970-01-01) so results never depend on the local time zone.

/** Days since 1970-01-01 (UTC). */
export type DayNumber = number;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** Parses `YYYY-MM-DD` into a day number; returns undefined for malformed or impossible dates. */
export function parseDate(text: string): DayNumber | undefined {
  const m = ISO_DATE.exec(text.trim());
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return undefined;
  return Math.round(ms / MS_PER_DAY);
}

export function isValidDate(text: string): boolean {
  return parseDate(text) !== undefined;
}

export function formatDate(day: DayNumber): string {
  const d = new Date(day * MS_PER_DAY);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(day: DayNumber): number {
  // 1970-01-01 was a Thursday (ISO 4).
  return ((((day + 3) % 7) + 7) % 7) + 1;
}

/** The Monday of the ISO week containing `day`. */
export function weekStart(day: DayNumber): DayNumber {
  return day - (isoWeekday(day) - 1);
}

export interface IsoWeek {
  year: number;
  week: number;
}

export function isoWeek(day: DayNumber): IsoWeek {
  const thursday = day + (4 - isoWeekday(day));
  const year = new Date(thursday * MS_PER_DAY).getUTCFullYear();
  const jan1 = Math.round(Date.UTC(year, 0, 1) / MS_PER_DAY);
  return { year, week: Math.floor((thursday - jan1) / 7) + 1 };
}

/** `2026-W46` */
export function isoWeekKey(day: DayNumber): string {
  const { year, week } = isoWeek(day);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Monday of a week key such as `2026-W46`. */
export function weekKeyStart(key: string): DayNumber | undefined {
  const m = /^(\d{4})-W(\d{2})$/.exec(key);
  if (!m) return undefined;
  const year = Number(m[1]);
  const week = Number(m[2]);
  const jan4 = Math.round(Date.UTC(year, 0, 4) / MS_PER_DAY);
  return weekStart(jan4) + (week - 1) * 7;
}

/** Today's date in the local time zone of the machine, as an ISO date. Only callers outside the
 * core use this; the core always receives `today` as a parameter. */
export function localToday(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export const WEEKDAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/**
 * Parses a workweek such as `mon-fri`, `sun-thu`, `mon,tue,thu` or `mon-thu, sat` into the set of
 * ISO weekdays (1–7). Returns undefined when any part is not a weekday name.
 */
export function parseWorkweek(text: string): Set<number> | undefined {
  const days = new Set<number>();
  const parts = text
    .toLowerCase()
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return undefined;
  for (const part of parts) {
    const range = part.split("-").map((p) => p.trim());
    const indexes = range.map((name) => WEEKDAY_NAMES.indexOf(name.slice(0, 3) as never));
    if (indexes.some((i) => i < 0) || range.length > 2) return undefined;
    if (range.length === 1) {
      days.add(indexes[0] + 1);
    } else {
      // Ranges wrap around the week end, e.g. sun-thu.
      let i = indexes[0];
      for (let guard = 0; guard < 7; guard++) {
        days.add(i + 1);
        if (i === indexes[1]) break;
        i = (i + 1) % 7;
      }
    }
  }
  return days;
}

/** Parses `2026-12-22..2027-01-02` or a single date into an inclusive [from, to] range. */
export function parseDateRange(text: string): [DayNumber, DayNumber] | undefined {
  const trimmed = text.trim();
  const sep = trimmed.indexOf("..");
  if (sep < 0) {
    const day = parseDate(trimmed);
    return day === undefined ? undefined : [day, day];
  }
  const from = parseDate(trimmed.slice(0, sep));
  const to = parseDate(trimmed.slice(sep + 2));
  if (from === undefined || to === undefined || to < from) return undefined;
  return [from, to];
}

export interface DateSuggestion {
  label: string;
  date: string;
}

/** Relative dates offered by completion: today, tomorrow, next Monday, end of week … */
const WEEKDAY_LABELS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Days off coming up (weekends and holidays outside `workweek`), as candidates for an extra
 * working day: from `from` to `to` (default: the next six weeks), at most `limit`.
 */
export function daysOffSuggestions(
  from: DayNumber,
  workweek: Set<number>,
  holidays: Array<[DayNumber, DayNumber]>,
  options: { to?: DayNumber; limit?: number } = {}
): DateSuggestion[] {
  const out: DateSuggestion[] = [];
  const to = options.to ?? from + 42;
  for (let d = from; d <= to && out.length < (options.limit ?? 8); d++) {
    const holiday = holidays.some(([a, b]) => d >= a && d <= b);
    if (workweek.has(isoWeekday(d)) && !holiday) continue;
    const date = new Date(d * MS_PER_DAY);
    const label = `${WEEKDAY_LABELS[isoWeekday(d) - 1]} ${date.getUTCDate()} ${MONTH_LABELS[date.getUTCMonth()]}${holiday ? " (holiday)" : ""}`;
    out.push({ label, date: formatDate(d) });
  }
  return out;
}

export function dateSuggestions(today: string): DateSuggestion[] {
  const t = parseDate(today);
  if (t === undefined) return [];
  const wd = isoWeekday(t);
  const nextMonday = t + (8 - wd);
  const friday = wd <= 5 ? t + (5 - wd) : t + (12 - wd);
  const d = new Date(t * MS_PER_DAY);
  const endOfMonth = Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0) / MS_PER_DAY);
  return [
    { label: "today", date: formatDate(t) },
    { label: "tomorrow", date: formatDate(t + 1) },
    { label: "next Monday", date: formatDate(nextMonday) },
    { label: "end of week", date: formatDate(friday) },
    { label: "end of next week", date: formatDate(friday + 7) },
    { label: "end of month", date: formatDate(endOfMonth) },
  ];
}
