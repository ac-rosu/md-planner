// Row helpers for the Gantt webview: visibility under collapsed groups, keyboard stepping over
// working days. Pure functions, unit-tested.
import { isoWeekday } from "../../core/dates";
import { type GanttLink, type GanttModel, type GanttRow } from "../../core/views/gantt";
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

/** The `data-link` of a dependency line: "T201→T202" (T202 waits for T201). */
export function linkId(l: Pick<GanttLink, "from" | "to">): string {
  return `${l.from}→${l.to}`;
}

export interface RoutedLink {
  link: GanttLink;
  /** SVG path from the predecessor's end to the successor's start. */
  d: string;
}

/** Pixels between the vertical lines of predecessors that finish on the same day. */
const CHANNEL_GAP = 3;
const CORNER = 4;

/**
 * Paths of the dependency lines between visible rows. A line leaves the end of the predecessor,
 * turns in a channel just after it and enters the successor at its start; when the successor
 * starts too soon for that, it goes round through the gap between the rows. Predecessors that
 * finish on the same day get channels a few pixels apart, so their vertical lines do not lie on top
 * of each other, and corners are rounded, so a bend does not look like a crossing.
 */
export function routeLinks(
  links: GanttLink[],
  rows: GanttRow[],
  scale: Scale,
  rowHeight: number
): RoutedLink[] {
  const index = new Map(rows.map((r, i) => [r.key, i]));
  const drawable = links.filter((l) => {
    const a = rows[index.get(l.from) ?? -1];
    const b = rows[index.get(l.to) ?? -1];
    return a?.finish !== undefined && b?.start !== undefined;
  });
  // Channel per predecessor: its rank among the predecessors that end at the same x.
  const sourcesAt = new Map<number, number[]>();
  for (const l of drawable) {
    const x1 = Math.round(dayToX(scale, rows[index.get(l.from)!].finish! + 1));
    const list = sourcesAt.get(x1) ?? [];
    if (!list.includes(index.get(l.from)!)) list.push(index.get(l.from)!);
    sourcesAt.set(x1, list);
  }
  for (const list of sourcesAt.values()) list.sort((a, b) => a - b);
  return drawable.map((l) => {
    const ia = index.get(l.from)!;
    const ib = index.get(l.to)!;
    const x1 = dayToX(scale, rows[ia].finish! + 1);
    const y1 = ia * rowHeight + rowHeight / 2;
    const x2 = dayToX(scale, rows[ib].start!);
    const y2 = ib * rowHeight + rowHeight / 2;
    const offset = CHANNEL_GAP * sourcesAt.get(Math.round(x1))!.indexOf(ia);
    let points: Array<[number, number]>;
    if (x2 - x1 >= 12) {
      const mx = Math.min(x1 + 6 + offset, x2 - 6);
      points = [
        [x1, y1],
        [mx, y1],
        [mx, y2],
        [x2 - 2, y2],
      ];
    } else {
      const midY = y1 + ((y2 >= y1 ? 1 : -1) * rowHeight) / 2;
      const mx = x1 + 6 + offset;
      points = [
        [x1, y1],
        [mx, y1],
        [mx, midY],
        [x2 - 8, midY],
        [x2 - 8, y2],
        [x2 - 2, y2],
      ];
    }
    return { link: l, d: roundedPath(points, CORNER) };
  });
}

/** An orthogonal polyline as a path with corners rounded to radius `r` (less on short legs). */
export function roundedPath(points: Array<[number, number]>, r: number): string {
  const n = (v: number) => Math.round(v * 10) / 10;
  const pts = points.filter(
    (p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]
  );
  let d = `M${n(pts[0][0])},${n(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1];
    const [cx, cy] = pts[i];
    const [nx, ny] = pts[i + 1];
    const inLen = Math.hypot(cx - px, cy - py);
    const outLen = Math.hypot(nx - cx, ny - cy);
    const k = Math.min(r, inLen / 2, outLen / 2);
    const ax = cx - ((cx - px) / inLen) * k;
    const ay = cy - ((cy - py) / inLen) * k;
    const bx = cx + ((nx - cx) / outLen) * k;
    const by = cy + ((ny - cy) / outLen) * k;
    d += ` L${n(ax)},${n(ay)} Q${n(cx)},${n(cy)} ${n(bx)},${n(by)}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${n(last[0])},${n(last[1])}`;
}

export interface LinkFocus {
  /** Ids of the highlighted lines; empty when nothing is in focus (every line is drawn as usual). */
  links: Set<string>;
  /** Rows at the other end of the highlighted lines (both ends for a selected line). */
  rows: Set<string>;
}

/**
 * The dependency lines to bring forward: the selected line, or the lines into and out of the
 * selected row. The rest fade, so one dependency can be followed through a busy chart.
 */
export function linkFocus(
  links: GanttLink[],
  selected: string | undefined,
  selectedLink: Pick<GanttLink, "from" | "to"> | undefined
): LinkFocus {
  if (selectedLink) {
    const found = links.some((l) => linkId(l) === linkId(selectedLink));
    return found
      ? {
          links: new Set([linkId(selectedLink)]),
          rows: new Set([selectedLink.from, selectedLink.to]),
        }
      : { links: new Set(), rows: new Set() };
  }
  const focus: LinkFocus = { links: new Set(), rows: new Set() };
  if (selected === undefined) return focus;
  for (const l of links) {
    if (l.from !== selected && l.to !== selected) continue;
    focus.links.add(linkId(l));
    focus.rows.add(l.from === selected ? l.to : l.from);
  }
  return focus;
}

/** "T491" (or the title of a row without an id). */
export function linkName(rows: GanttRow[], key: string): string {
  const r = rows.find((x) => x.key === key);
  return r?.id ?? r?.title ?? key;
}

/**
 * The help line while dependencies are highlighted: "T122 waits for T121. Delete removes …" for a
 * selected arrow, "T491 waits for T411, T413; T416 waits for T491. …" for a selected bar.
 */
export function describeFocus(
  model: Pick<GanttModel, "rows" | "links">,
  focus: LinkFocus,
  selected: string | undefined,
  selectedLink: GanttLink | undefined
): string | undefined {
  if (focus.links.size === 0) return undefined;
  const name = (key: string) => linkName(model.rows, key);
  if (selectedLink) {
    return `${name(selectedLink.to)} waits for ${name(selectedLink.from)}. Delete removes this dependency; Esc shows all arrows.`;
  }
  if (selected === undefined) return undefined;
  const shown = model.links.filter((l) => focus.links.has(linkId(l)));
  const before = shown.filter((l) => l.to === selected).map((l) => name(l.from));
  const after = shown.filter((l) => l.from === selected).map((l) => name(l.to));
  const parts: string[] = [];
  if (before.length) parts.push(`${name(selected)} waits for ${before.join(", ")}`);
  if (after.length)
    parts.push(
      `${after.join(", ")} ${after.length === 1 ? "waits" : "wait"} for ${name(selected)}`
    );
  return `${parts.join("; ")}. Esc shows all arrows.`;
}

/**
 * Where a bar dragged by `days` calendar days would go, in working days of the project calendar:
 * a moved bar starts on the next working day and keeps its number of working days; a resized bar
 * ends on the last working day on or before the pointer. The schedule decides the final dates
 * (other work of the person can stretch the bar); the notice after the drag gives them.
 */
export function dragPreview(
  model: Pick<GanttModel, "workweek" | "holidays">,
  row: { start: number; finish: number },
  kind: "move" | "resize",
  days: number
): { start: number; finish: number } {
  const holidays = new Set(model.holidays);
  const working = (d: number) => isWorkingDay(model, holidays, d);
  const next = (d: number) => {
    for (let guard = 0; guard < 3660 && !working(d); guard++) d++;
    return d;
  };
  const previous = (d: number) => {
    for (let guard = 0; guard < 3660 && !working(d); guard++) d--;
    return d;
  };
  if (kind === "resize")
    return { start: row.start, finish: Math.max(row.start, previous(row.finish + days)) };
  let length = 0;
  for (let d = row.start; d < row.finish; d++) if (working(d)) length++;
  const start = next(row.start + days);
  return { start, finish: length > 0 ? stepWorkingDays(model, start, length) : start };
}

/** "Fri 2026-11-27": the weekday matters when a drag ends near a weekend. */
export function dayLabel(day: number): string {
  const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][isoWeekday(day) - 1];
  return `${wd} ${new Date(day * 86_400_000).toISOString().slice(0, 10)}`;
}
