// Row helpers for the Gantt webview: visibility under collapsed groups, keyboard stepping over
// working days. Pure functions, unit-tested.
import { isoWeekday } from "../../core/dates";
import { type GanttModel, type GanttRow } from "../../core/views/gantt";
import { dayToX, type Scale } from "./scale";

/** Rows not hidden by a collapsed ancestor. */
export function visibleRows(rows: GanttRow[], collapsed: Set<string>): GanttRow[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const hidden = (r: GanttRow): boolean => {
    for (let p = r.parent; p; p = byKey.get(p)?.parent) if (collapsed.has(p)) return true;
    return false;
  };
  return rows.filter((r) => !hidden(r));
}

export function isWorkingDay(
  model: Pick<GanttModel, "workweek" | "holidays">,
  holidays: Set<number>,
  day: number
): boolean {
  return model.workweek.includes(isoWeekday(day)) && !holidays.has(day);
}

/** The working day `steps` working days away from `day` (negative = backwards). */
export function stepWorkingDays(
  model: Pick<GanttModel, "workweek" | "holidays">,
  day: number,
  steps: number
): number {
  const holidays = new Set(model.holidays);
  let d = day;
  const dir = steps < 0 ? -1 : 1;
  let left = Math.abs(steps);
  for (let guard = 0; left > 0 && guard < 3660; guard++) {
    d += dir;
    if (isWorkingDay(model, holidays, d)) left--;
  }
  return d;
}

/** Bar colour for a row under the current colour mode. */
export function rowColor(row: GanttRow, mode: "owner" | "status" | "milestone"): string {
  return row.colors[mode];
}

/**
 * The `data-vscode-context` of a row or bar: VS Code shows the planner's context menu for it
 * (edit, status, owner … for tasks; add task, edit milestone for milestone and section rows).
 */
export function vscodeContext(row: GanttRow): string {
  const section = row.task
    ? "task"
    : row.kind === "milestone"
      ? "milestone"
      : row.key.startsWith("section:")
        ? "section"
        : undefined;
  return JSON.stringify({
    ...(section ? { webviewSection: section, key: row.task ?? row.key } : {}),
    ...(row.task && row.fixedStart !== undefined ? { pinned: true } : {}),
    preventDefaultContextMenuItems: true,
  });
}

/** Slack around a bar for dropping a link on it. */
const LINK_SLACK = 6;

/**
 * The bar a link drag from `from` ends on at (x, y): another task or parent bar under the pointer,
 * or right next to it. Releasing anywhere else in a row adds no dependency.
 */
export function linkTargetAt(
  rows: GanttRow[],
  scale: Scale,
  from: string,
  x: number,
  y: number,
  rowHeight: number
): GanttRow | undefined {
  const target = rows[Math.floor(y / rowHeight)];
  if (!target || target.key === from || !target.task) return undefined;
  if (target.kind !== "task" && target.kind !== "parent") return undefined;
  if (target.start === undefined || target.finish === undefined) return undefined;
  const left = dayToX(scale, target.start) - LINK_SLACK;
  const right = dayToX(scale, target.finish + 1) + LINK_SLACK;
  return x >= left && x <= right ? target : undefined;
}

/**
 * Width of the resize handle at the end of a bar `width` pixels wide: at most a third of the bar,
 * none on bars under 12 px (they can only be moved, so a drag never changes an estimate by accident).
 */
export function resizeHandleWidth(width: number): number {
  return width < 12 ? 0 : Math.min(8, Math.floor(width / 3));
}
