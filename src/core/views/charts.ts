// Chart geometry shared by the dashboard webview (Preact) and the static HTML report (strings).
import { type DayNumber } from "../dates";
import { type BurnUp } from "../metrics";

export interface Tick {
  pos: number;
  label: string;
}

export interface BurnUpGeometry {
  width: number;
  height: number;
  plot: { left: number; top: number; right: number; bottom: number };
  scope: string;
  done: string;
  forecast: string;
  todayX?: number;
  xTicks: Tick[];
  yTicks: Tick[];
  max: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Lines of a burn-up chart: scope, done (to today) and forecast (from today). */
export function burnUpGeometry(burn: BurnUp, width = 640, height = 240): BurnUpGeometry {
  const plot = { left: 48, top: 12, right: width - 12, bottom: height - 28 };
  const pts = burn.points;
  const max = niceMax(
    Math.max(burn.scope, ...pts.map((p) => Math.max(p.done ?? 0, p.forecast ?? 0)), 1)
  );
  const first = pts[0]?.week ?? burn.today;
  const last = (pts[pts.length - 1]?.week ?? burn.today) + 6;
  const span = Math.max(7, last - first);
  const x = (day: DayNumber) => plot.left + ((day - first) / span) * (plot.right - plot.left);
  const y = (h: number) => plot.bottom - (h / max) * (plot.bottom - plot.top);
  const line = (sel: (p: (typeof pts)[number]) => number | undefined) => {
    let d = "";
    for (const p of pts) {
      const v = sel(p);
      if (v === undefined) continue;
      d += `${d ? "L" : "M"}${round(x(p.week + 6))},${round(y(v))}`;
    }
    return d;
  };
  const xTicks: Tick[] = [];
  let lastMonth = -1;
  for (const p of pts) {
    const date = new Date(p.week * 86_400_000);
    const month = date.getUTCMonth();
    if (month !== lastMonth) {
      // First Monday of a month (or the first point); skip labels that would overlap.
      const pos = round(x(p.week));
      const prev = xTicks[xTicks.length - 1];
      const label =
        MONTHS[month] + (month === 0 || xTicks.length === 0 ? ` ${date.getUTCFullYear()}` : "");
      if (prev && pos - prev.pos < 56)
        xTicks[xTicks.length - 1] = { pos, label: `${MONTHS[month]} ${date.getUTCFullYear()}` };
      else xTicks.push({ pos, label });
      lastMonth = month;
    }
  }
  const yTicks: Tick[] = [];
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    yTicks.push({ pos: round(y(v)), label: `${Math.round(v)}h` });
  }
  const todayX = burn.today >= first && burn.today <= last ? round(x(burn.today)) : undefined;
  return {
    width,
    height,
    plot,
    scope: line((p) => p.scope),
    done: line((p) => p.done),
    forecast: line((p) => p.forecast),
    todayX,
    xTicks,
    yTicks,
    max,
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** A round axis maximum: 1, 2, 2.5 or 5 × 10^n above the value. */
export function niceMax(v: number): number {
  const exp = Math.pow(10, Math.floor(Math.log10(Math.max(v, 1))));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= v) return m * exp;
  return 10 * exp;
}
