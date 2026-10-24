// Baselines: snapshots of the schedule (planned start, finish and hours per task) saved as JSON in
// plan/baselines/, compared against the current schedule in the Gantt and the dashboard.
import { type DayNumber, formatDate, parseDate } from "./dates";
import { type Plan } from "./resolve";
import { estimateHours, isLeaf } from "./rollup";
import { type Schedule, taskKey } from "./scheduler";
import { type BaselineLookup } from "./views/gantt";

export interface BaselineTask {
  title: string;
  start?: string;
  finish?: string;
  hours: number;
}

export interface BaselineMilestone {
  title: string;
  target?: string;
  start?: string;
  forecast?: string;
  hours: number;
}

export interface Baseline {
  name: string;
  /** ISO date the baseline was taken (the schedule's today). */
  date: string;
  project: string;
  tasks: Record<string, BaselineTask>;
  milestones: Record<string, BaselineMilestone>;
}

export function createBaseline(plan: Plan, schedule: Schedule, name: string): Baseline {
  const tasks: Record<string, BaselineTask> = {};
  for (const t of plan.tasks) {
    const ts = schedule.tasks.get(t);
    const roll = schedule.parents.get(t);
    if (!ts && !roll) continue;
    const start = ts?.start ?? roll?.start;
    const finish = ts?.finish ?? roll?.finish;
    tasks[taskKey(t)] = {
      title: t.title,
      start: start === undefined ? undefined : formatDate(start),
      finish: finish === undefined ? undefined : formatDate(finish),
      hours: isLeaf(t) ? (estimateHours(t) ?? 0) : (roll?.hours ?? 0),
    };
  }
  const milestones: Record<string, BaselineMilestone> = {};
  for (const m of plan.milestones) {
    const ms = schedule.milestones.get(m.id);
    if (!ms) continue;
    milestones[m.id] = {
      title: m.title,
      target: m.target,
      start: ms.start === undefined ? undefined : formatDate(ms.start),
      forecast: ms.forecast === undefined ? undefined : formatDate(ms.forecast),
      hours: ms.hours,
    };
  }
  return { name, date: formatDate(schedule.today), project: plan.project.name, tasks, milestones };
}

export function baselineSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "baseline"
  );
}

/** `baselines/2026-10-14-kickoff.json` */
export function baselineFileName(b: Pick<Baseline, "date" | "name">): string {
  return `${b.date}-${baselineSlug(b.name)}.json`;
}

export function baselineText(b: Baseline): string {
  return JSON.stringify(b, null, 2) + "\n";
}

/** Parses a baseline file; throws with a readable message when it is not one. */
export function parseBaseline(text: string, fileName = "baseline"): Baseline {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${fileName} is not valid JSON.`);
  }
  const b = data as Partial<Baseline>;
  if (
    !b ||
    typeof b !== "object" ||
    typeof b.name !== "string" ||
    typeof b.date !== "string" ||
    typeof b.tasks !== "object"
  ) {
    throw new Error(`${fileName} is not a planner baseline.`);
  }
  return {
    name: b.name,
    date: b.date,
    project: b.project ?? "",
    tasks: b.tasks ?? {},
    milestones: b.milestones ?? {},
  };
}

/** Adapter for the Gantt view model: task keys and `milestone:<id>` keys. */
export function baselineLookup(b: Baseline): BaselineLookup {
  const day = (s: string | undefined): DayNumber | undefined => (s ? parseDate(s) : undefined);
  return {
    name: b.name,
    task(key: string) {
      if (key.startsWith("milestone:")) {
        const m = b.milestones[key.slice("milestone:".length)];
        return m ? { start: day(m.start), finish: day(m.forecast) } : undefined;
      }
      const t = b.tasks[key];
      return t ? { start: day(t.start), finish: day(t.finish) } : undefined;
    },
  };
}

export interface MilestoneTrend {
  baseline: string;
  /** Working days the forecast moved since the baseline (positive = later). */
  slip?: number;
  baselineForecast?: string;
}

/** Forecast movement of each milestone against a baseline. */
export function milestoneTrends(
  plan: Plan,
  schedule: Schedule,
  b: Baseline
): Map<string, MilestoneTrend> {
  const out = new Map<string, MilestoneTrend>();
  for (const m of plan.milestones) {
    const ms = schedule.milestones.get(m.id);
    const bm = b.milestones[m.id];
    const before = bm?.forecast ? parseDate(bm.forecast) : undefined;
    out.set(m.id, {
      baseline: b.name,
      baselineForecast: bm?.forecast,
      slip:
        before !== undefined && ms?.forecast !== undefined
          ? schedule.calendar.workingDaysBetween(before, ms.forecast)
          : undefined,
    });
  }
  return out;
}

/** The latest baseline (by date, then name). */
export function latestBaseline<T extends Pick<Baseline, "date" | "name">>(
  baselines: T[]
): T | undefined {
  return [...baselines]
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name))
    .at(-1);
}
