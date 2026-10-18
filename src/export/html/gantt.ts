// Static SVG Gantt for reports: milestone grouping, limited to a window of weeks around today.
import { type DayNumber, isoWeek, weekStart } from "../../core/dates";
import { hexOf } from "../../core/views/colors";
import { type GanttModel, type GanttRow } from "../../core/views/gantt";
import { esc } from "./util";

const ROW = 18;
const LABEL = 300;
const HEAD = 34;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface StaticGanttOptions {
  /** Weeks shown after the current week (the previous week is shown too). */
  weeks: number;
  width?: number;
}

/** Rows that overlap the window, keeping the groups that contain visible tasks. */
export function rowsInWindow(model: GanttModel, from: DayNumber, to: DayNumber): GanttRow[] {
  const overlaps = (r: GanttRow) =>
    (r.start !== undefined && r.finish !== undefined && r.finish >= from && r.start <= to) ||
    (r.kind === "milestone" && r.target !== undefined && r.target >= from && r.target <= to);
  const byKey = new Map(model.rows.map((r) => [r.key, r]));
  const keep = new Set<string>();
  for (const r of model.rows) {
    if (r.kind !== "task" || !overlaps(r)) continue;
    keep.add(r.key);
    for (let p = r.parent; p; p = byKey.get(p)?.parent) keep.add(p);
  }
  for (const r of model.rows) if (r.kind === "milestone" && overlaps(r)) keep.add(r.key);
  return model.rows.filter((r) => keep.has(r.key));
}

export function staticGanttSvg(model: GanttModel, options: StaticGanttOptions): string {
  const width = options.width ?? 1040;
  const from = weekStart(model.today) - 7;
  const to = from + (options.weeks + 1) * 7 - 1;
  const rows = rowsInWindow(model, from, to);
  const days = to - from + 1;
  const px = (width - LABEL) / days;
  const x = (d: DayNumber) => LABEL + (Math.max(from, Math.min(to + 1, d)) - from) * px;
  const height = HEAD + rows.length * ROW + 4;
  const parts: string[] = [];

  // Header: months and ISO weeks.
  let monthStart = from;
  for (let d = from; d <= to + 1; d++) {
    const date = new Date(d * 86_400_000);
    const newMonth = d === to + 1 || (date.getUTCDate() === 1 && d !== from);
    if (newMonth) {
      const m = new Date(monthStart * 86_400_000);
      if ((d - monthStart) * px > 34)
        parts.push(
          `<text x="${x(monthStart) + 3}" y="12" class="h">${MONTHS[m.getUTCMonth()]} ${m.getUTCFullYear()}</text>`
        );
      parts.push(`<line x1="${x(d)}" y1="0" x2="${x(d)}" y2="16" stroke="#d1d9e0"/>`);
      monthStart = d;
    }
  }
  for (let w = from; w <= to; w += 7) {
    parts.push(
      `<rect x="${x(w)}" y="${HEAD}" width="${7 * px}" height="${rows.length * ROW}" fill="${isoWeek(w).week % 2 === 0 ? "#f6f8fa" : "#ffffff"}"/>`
    );
    parts.push(
      `<text x="${x(w) + 3}" y="29" class="w">W${String(isoWeek(w).week).padStart(2, "0")}</text>`
    );
  }
  // Rows.
  rows.forEach((r, i) => {
    const y = HEAD + i * ROW;
    const indent = 6 + r.level * 12;
    const weight = r.kind === "task" ? "400" : "600";
    const title =
      r.title.length > 42 - r.level * 2 ? `${r.title.slice(0, 40 - r.level * 2)}…` : r.title;
    parts.push(
      `<text x="${indent}" y="${y + 13}" class="l" font-weight="${weight}">${esc(title)}</text>`
    );
    if (r.ownerInitials && r.kind === "task")
      parts.push(`<text x="${LABEL - 26}" y="${y + 13}" class="o">${esc(r.ownerInitials)}</text>`);
    parts.push(`<line x1="0" y1="${y + ROW}" x2="${width}" y2="${y + ROW}" stroke="#eaeef2"/>`);
    if (r.start !== undefined && r.finish !== undefined && r.finish >= from && r.start <= to) {
      const x1 = x(r.start);
      const x2 = Math.max(x1 + 2, x(r.finish + 1));
      if (r.kind === "task") {
        const fill = hexOf(r.colors.owner);
        const stroke = r.critical ? ` stroke="#cf222e" stroke-width="1.5"` : "";
        const opacity = r.status === "done" ? ` fill-opacity="0.45"` : "";
        parts.push(
          `<rect x="${x1}" y="${y + 4}" width="${x2 - x1}" height="${ROW - 8}" rx="2" fill="${fill}"${opacity}${stroke}/>`
        );
        if (r.progress > 0 && r.status !== "done") {
          parts.push(
            `<rect x="${x1}" y="${y + 4}" width="${(x2 - x1) * Math.min(1, r.progress)}" height="${ROW - 8}" rx="2" fill="#000" fill-opacity="0.2"/>`
          );
        }
      } else {
        parts.push(`<rect x="${x1}" y="${y + 7}" width="${x2 - x1}" height="4" fill="#57606a"/>`);
      }
    }
    if (r.kind === "milestone" && r.target !== undefined && r.target >= from && r.target <= to) {
      const cx = x(r.target) + px / 2;
      const cy = y + ROW / 2;
      parts.push(
        `<path d="M${cx},${cy - 6} L${cx + 6},${cy} L${cx},${cy + 6} L${cx - 6},${cy} z" fill="${r.late ? "#cf222e" : "#1f2328"}"/>`
      );
    }
  });
  if (model.today >= from && model.today <= to) {
    const tx = x(model.today);
    parts.push(
      `<line x1="${tx}" y1="${HEAD - 4}" x2="${tx}" y2="${height}" stroke="#cf222e" stroke-width="1.5"/>`
    );
  }
  parts.push(`<line x1="${LABEL}" y1="0" x2="${LABEL}" y2="${height}" stroke="#d1d9e0"/>`);
  const style = `<style>.h{font:600 11px sans-serif;fill:#1f2328}.w{font:10px sans-serif;fill:#59636e}.l{font-size:11px;font-family:sans-serif;fill:#1f2328}.o{font:10px sans-serif;fill:#59636e}</style>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Gantt chart">${style}${parts.join("")}</svg>`;
}
