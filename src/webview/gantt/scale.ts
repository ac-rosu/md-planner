// Time scale of the Gantt chart: day ↔ x conversions and header ticks. Pure and DOM-free.
import { isoWeek, isoWeekday, weekStart } from "../../core/dates";
import { type GanttZoom } from "../shared/protocol";

export const ZOOM_PX: Record<GanttZoom, number> = { day: 32, week: 14, month: 4.5, quarter: 1.6 };

export interface Scale {
  /** First day shown (a Monday). */
  start: number;
  days: number;
  px: number;
  width: number;
}

export function makeScale(rangeStart: number, rangeEnd: number, px: number): Scale {
  const start = weekStart(rangeStart - 7);
  const days = Math.max(28, rangeEnd + 21 - start);
  return { start, days, px, width: Math.ceil(days * px) };
}

export function dayToX(scale: Scale, day: number): number {
  return (day - scale.start) * scale.px;
}

export function xToDay(scale: Scale, x: number): number {
  return scale.start + Math.floor(x / scale.px);
}

/** Pixels per day that fit the range into `width` pixels (clamped to sensible bounds). */
export function fitPx(rangeStart: number, rangeEnd: number, width: number): number {
  const days = Math.max(14, rangeEnd - rangeStart + 28);
  return Math.min(48, Math.max(0.8, width / days));
}

/** Zoom limits in pixels per day: several years on screen, to wide single days. */
export const MIN_PX = 0.8;
export const MAX_PX = 64;

/**
 * Pixels per day after one wheel event of a zoom gesture (a trackpad pinch, or Ctrl/Cmd + wheel).
 * A pinch sends many small deltas, a mouse wheel a few large ones (about 100 px, or 3 lines, per
 * notch): one notch zooms by about a quarter, a pinch follows the fingers smoothly.
 */
export function zoomPx(px: number, deltaY: number, deltaMode = 0): number {
  const pixels = deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * 800 : deltaY;
  const step = Math.max(-200, Math.min(200, pixels));
  return Math.min(MAX_PX, Math.max(MIN_PX, px * Math.pow(2, -step / 250)));
}

/**
 * The horizontal scroll that keeps `day` under the pointer after zooming: `pointerX` is measured
 * from the left edge of the scroll area, `chartLeft` is where the chart starts in it (after the
 * task list).
 */
export function anchoredScroll(
  scale: Scale,
  day: number,
  pointerX: number,
  chartLeft: number
): number {
  return Math.max(0, chartLeft + (day - scale.start) * scale.px - pointerX);
}

/** The named zoom closest to a pixel density (for labelling and tick choice). */
export function zoomFor(px: number): GanttZoom {
  if (px >= 24) return "day";
  if (px >= 8) return "week";
  if (px >= 3) return "month";
  return "quarter";
}

export interface Tick {
  x: number;
  width: number;
  label: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function dateParts(day: number): { y: number; m: number; d: number } {
  const date = new Date(day * 86_400_000);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth(), d: date.getUTCDate() };
}

function dayOf(y: number, m: number, d = 1): number {
  return Math.round(Date.UTC(y, m, d) / 86_400_000);
}

/** Two header rows: a coarse one (top) and a fine one (bottom), depending on the density. */
export function headerTicks(scale: Scale): { top: Tick[]; bottom: Tick[] } {
  const end = scale.start + scale.days;
  const zoom = zoomFor(scale.px);
  const months = (): Tick[] => {
    const out: Tick[] = [];
    let { y, m } = dateParts(scale.start);
    for (let day = dayOf(y, m); day < end;) {
      const next = dayOf(m === 11 ? y + 1 : y, (m + 1) % 12);
      const from = Math.max(day, scale.start);
      out.push({
        x: dayToX(scale, from),
        width: (next - from) * scale.px,
        label: `${MONTHS[m]} ${y}`,
      });
      day = next;
      if (m === 11) y++;
      m = (m + 1) % 12;
    }
    return out;
  };
  const weeks = (labelFn: (day: number) => string): Tick[] => {
    const out: Tick[] = [];
    for (let day = weekStart(scale.start); day < end; day += 7) {
      const from = Math.max(day, scale.start);
      out.push({ x: dayToX(scale, from), width: (day + 7 - from) * scale.px, label: labelFn(day) });
    }
    return out;
  };
  switch (zoom) {
    case "day": {
      const bottom: Tick[] = [];
      for (let day = scale.start; day < end; day++) {
        bottom.push({
          x: dayToX(scale, day),
          width: scale.px,
          label: `${DAYS[isoWeekday(day) - 1]} ${dateParts(day).d}`,
        });
      }
      return {
        top: weeks((d) => {
          const p = dateParts(d);
          return `W${String(isoWeek(d).week).padStart(2, "0")} · ${p.d} ${MONTHS[p.m]} ${p.y}`;
        }),
        bottom,
      };
    }
    case "week":
      return {
        top: months(),
        bottom: weeks((d) => `W${String(isoWeek(d).week).padStart(2, "0")}`),
      };
    case "month": {
      const ms = months().map((t) => ({ ...t, label: t.label.slice(0, 3) }));
      const years: Tick[] = [];
      for (const t of months()) {
        const y = t.label.slice(4);
        const last = years[years.length - 1];
        if (last && last.label === y) last.width += t.width;
        else years.push({ x: t.x, width: t.width, label: y });
      }
      return { top: years, bottom: ms };
    }
    case "quarter": {
      const quarters: Tick[] = [];
      const years: Tick[] = [];
      for (const t of months()) {
        const [mon, y] = t.label.split(" ");
        const q = `Q${Math.floor(MONTHS.indexOf(mon) / 3) + 1}`;
        const lastQ = quarters[quarters.length - 1];
        if (lastQ && lastQ.label === `${q} ${y}`) lastQ.width += t.width;
        else quarters.push({ x: t.x, width: t.width, label: `${q} ${y}` });
        const lastY = years[years.length - 1];
        if (lastY && lastY.label === y) lastY.width += t.width;
        else years.push({ x: t.x, width: t.width, label: y });
      }
      return { top: years, bottom: quarters.map((q) => ({ ...q, label: q.label.split(" ")[0] })) };
    }
  }
}

/** Vertical grid lines: week starts at day/week zoom, month starts otherwise. */
export function gridLines(scale: Scale): number[] {
  const end = scale.start + scale.days;
  const out: number[] = [];
  if (scale.px >= 8) {
    for (let d = weekStart(scale.start); d < end; d += 7)
      if (d >= scale.start) out.push(dayToX(scale, d));
    return out;
  }
  let { y, m } = dateParts(scale.start);
  for (let day = dayOf(y, m); day < end;) {
    if (day >= scale.start) out.push(dayToX(scale, day));
    if (m === 11) y++;
    m = (m + 1) % 12;
    day = dayOf(y, m);
  }
  return out;
}
