// Time tracking helpers: rounding timer minutes and parsing manually logged time.
import { formatHours } from "./duration";
import { type Task } from "./model";

/** Rounds elapsed minutes up to the next multiple of `rounding` (at least one increment). */
export function roundMinutes(elapsedMinutes: number, rounding: number): number {
  const step = Math.max(1, rounding);
  if (elapsedMinutes <= 0) return 0;
  return Math.ceil(elapsedMinutes / step - 1e-9) * step;
}

/** Parses `1.5`, `1.5h`, `90m`, `1h30m`, `1:30` into hours; undefined when invalid or ≤ 0. */
export function parseLoggedTime(text: string): number | undefined {
  const t = text.trim().toLowerCase().replace(/\s+/g, "");
  let hours: number | undefined;
  let m: RegExpExecArray | null;
  if ((m = /^(\d+(?:\.\d+)?)h?$/.exec(t))) hours = Number(m[1]);
  else if ((m = /^(\d+(?:\.\d+)?)m(?:in)?$/.exec(t))) hours = Number(m[1]) / 60;
  else if ((m = /^(\d+)h(\d+)m?$/.exec(t))) hours = Number(m[1]) + Number(m[2]) / 60;
  else if ((m = /^(\d+):(\d{2})$/.exec(t))) hours = Number(m[1]) + Number(m[2]) / 60;
  if (hours === undefined || !Number.isFinite(hours) || hours <= 0) return undefined;
  return Math.round(hours * 100) / 100;
}

/** The new `@act` value after adding hours. */
export function addActual(current: number | undefined, hours: number): string {
  return formatHours((current ?? 0) + hours);
}

/**
 * Why hours cannot be added to a task's `@act`: it has one the planner does not read as a duration
 * (typed by hand as `@act:90m`, say), which adding would replace with the hours added. Says what to
 * write instead: the value as the Log time prompt reads it (`@act:1.5h`), when it does. Undefined
 * when hours can be added.
 */
export function unreadableActual(t: Pick<Task, "attrs" | "act">): string | undefined {
  // Only the first @act counts (a repeated one is ignored with a warning).
  const act = t.attrs.find((a) => a.key === "act");
  if (!act || t.act !== undefined) return undefined;
  const hours = parseLoggedTime(act.value);
  const as = hours === undefined ? "hours (e.g. @act:1.5h)" : `@act:${formatHours(hours)}`;
  return `@act:${act.value} is not read as hours; write it as ${as} first`;
}

/**
 * Elapsed time for the status bar: `42m`, `1h 05m`, `17h 42m`. Hours and minutes are named, so it
 * cannot be read as a time of day. Undefined for a negative time (the clock was set back).
 */
export function formatElapsed(ms: number): string | undefined {
  if (ms < 0) return undefined;
  const minutes = Math.floor(ms / 60_000);
  const h = Math.floor(minutes / 60);
  return h ? `${h}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}

/**
 * Whether a timer ran long enough to ask before its time is logged: longer than a working day
 * (`hoursPerDay`), or from one day into another (`startDay` and `endDay`, the local dates it
 * started and stopped). A timer left running overnight, over a weekend or while VS Code was closed
 * would otherwise log all of it.
 */
export function timerRanLong(
  elapsedMs: number,
  hoursPerDay: number,
  startDay: string,
  endDay: string
): boolean {
  return elapsedMs > hoursPerDay * 3_600_000 || startDay !== endDay;
}
