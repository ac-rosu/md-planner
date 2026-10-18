// Durations are written as `12h`, `1.5d`, `1w`. Work is measured in hours everywhere in the core:
// `d` = hoursPerDay hours, `w` = 5 days.

const DURATION = /^(\d+(?:\.\d+)?)(h|d|w)$/i;

export const DAYS_PER_WEEK = 5;

/** Returns hours, or undefined if the text is not a valid duration. */
export function parseDuration(text: string, hoursPerDay: number): number | undefined {
  const m = DURATION.exec(text.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  switch (m[2].toLowerCase()) {
    case "h":
      return n;
    case "d":
      return n * hoursPerDay;
    default:
      return n * hoursPerDay * DAYS_PER_WEEK;
  }
}

/** Formats hours as a compact duration such as `12h` or `5.25h` (at most two decimals). */
export function formatHours(hours: number): string {
  return `${formatNumber(hours)}h`;
}

export function formatNumber(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return String(rounded);
}

/** Parses `40%` (or `40`) into a fraction 0..1; undefined if invalid or out of range. */
export function parsePercent(text: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)%?$/.exec(text.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (n < 0 || n > 100) return undefined;
  return n / 100;
}

/** Capacity such as `32h/week` or `6.5h/day`. */
export interface CapacitySpec {
  hours: number;
  per: "week" | "day";
}

export function parseCapacity(text: string): CapacitySpec | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*h\s*\/\s*(week|wk|w|day|d)$/i.exec(text.trim());
  if (!m) return undefined;
  const per = m[2].toLowerCase().startsWith("w") ? "week" : "day";
  return { hours: Number(m[1]), per };
}

/** Extra capacity such as `+8h/week` or `+2h/day` (the plus sign is optional). */
export function parseExtraCapacity(text: string): CapacitySpec | undefined {
  const spec = parseCapacity(text.trim().replace(/^\+\s*/, ""));
  return spec && spec.hours > 0 ? spec : undefined;
}

export interface DepRef {
  id: string;
  /** Lag in hours (converted to working days by the scheduler). */
  lagHours: number;
  /** The raw text of this reference, e.g. `T102+2d`. */
  raw: string;
  valid: boolean;
}

/** Parses `T101,T102+2d` into dependency references. */
export function parseDeps(text: string, hoursPerDay: number): DepRef[] {
  const refs: DepRef[] = [];
  for (const raw of text.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^([A-Za-z][\w-]*?)(?:\+(.+))?$/.exec(part);
    if (!m) {
      refs.push({ id: part, lagHours: 0, raw: part, valid: false });
      continue;
    }
    let lagHours = 0;
    let valid = true;
    if (m[2] !== undefined) {
      const lag = parseDuration(m[2], hoursPerDay);
      if (lag === undefined) valid = false;
      else lagHours = lag;
    }
    refs.push({ id: m[1], lagHours, raw: part, valid });
  }
  return refs;
}
