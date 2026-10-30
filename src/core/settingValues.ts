// planner.* settings as people write them by hand: a folder as `./plan`, `plan/` or an absolute
// path, a number as text (`"40"`, `"40h"`). Shared by the extension and the MCP server, so both
// read a setting the same way.

/** `planner.planFolder`: "plan" when it is empty or not text. */
export function planFolderSetting(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "plan";
}

/** True for an absolute path: `/srv/plan`, `C:\plan`, `C:/plan`, `\\server\share\plan`. */
export function isAbsolutePath(path: string): boolean {
  return /^[\\/]/.test(path) || /^[A-Za-z]:[\\/]/.test(path);
}

/** The folders of a relative path, without `.` and empty ones (`./plan/` → `plan`); `..` stays. */
export function pathSegments(path: string): string[] {
  return path.split(/[\\/]/).filter((s) => s !== "" && s !== ".");
}

/**
 * A number setting: a finite number, or text that is one, optionally followed by one of `units`
 * (`"40"`, `"40h"`, `"15 min"`). Undefined for anything else.
 */
export function settingNumber(value: unknown, units: readonly string[] = []): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const m = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*([a-z]*)\s*$/i.exec(value);
  if (!m || (m[2] && !units.includes(m[2].toLowerCase()))) return undefined;
  return Number(m[1]);
}

export const DEFAULT_UNASSIGNED_CAPACITY = 40;

/**
 * `planner.scheduling.unassignedCapacity` in hours per week: a number, also written as text
 * (`"40"`, `"40h"`). Anything else is the default (40), with `invalid` saying what was ignored,
 * so the caller can log it: a value nobody reads as hours would leave every task without an
 * owner unscheduled.
 */
export function unassignedCapacitySetting(value: unknown): { hours: number; invalid?: string } {
  if (value === undefined || value === null) return { hours: DEFAULT_UNASSIGNED_CAPACITY };
  const hours = settingNumber(value, ["h", "hour", "hours"]);
  if (hours !== undefined && hours >= 0) return { hours };
  return {
    hours: DEFAULT_UNASSIGNED_CAPACITY,
    invalid: `planner.scheduling.unassignedCapacity is ${JSON.stringify(value)}, not a number of hours per week: ${DEFAULT_UNASSIGNED_CAPACITY} is used.`,
  };
}
