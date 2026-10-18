// Time tracking helpers: rounding timer minutes and parsing manually logged time.
import { formatHours } from "./duration";

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

/** `1:05` style elapsed time for the status bar. */
export function formatElapsed(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}
