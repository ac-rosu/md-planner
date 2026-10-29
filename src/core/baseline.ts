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

/**
 * The task ids saved baselines name (`T407`, not the `file#line` keys of tasks without an id): a
 * deleted task's id stays taken while a baseline remembers it. Files that are not baselines are
 * left out.
 */
export function baselineIds(texts: Iterable<{ text: string; name: string }>): Set<string> {
  const ids = new Set<string>();
  for (const { text, name } of texts) {
    try {
      for (const key of Object.keys(parseBaseline(text, name).tasks))
        if (/^[A-Za-z]+\d+$/.test(key)) ids.add(key);
    } catch {
      // Not a baseline: skipped here as everywhere else.
    }
  }
  return ids;
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

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Own entries only, so that keys like `constructor` never reach `Object.prototype`. */
const own = <T>(map: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(map, key) ? map[key] : undefined;

/**
 * Parses a baseline file; throws with a readable message when it is not one. Every field is
 * checked (text, dates as text, hours as numbers), so that a hand-edited or foreign file is
 * rejected here instead of failing later in the Gantt, the dashboard or a report.
 */
export function parseBaseline(text: string, fileName = "baseline"): Baseline {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${fileName} is not valid JSON.`);
  }
  const fail = (what?: string): never => {
    throw new Error(`${fileName} is not a planner baseline${what ? ` (${what})` : ""}.`);
  };
  if (!isRecord(data) || typeof data.name !== "string" || typeof data.date !== "string")
    return fail();
  if (!isRecord(data.tasks)) return fail("tasks must be an object");
  if (data.project !== undefined && data.project !== null && typeof data.project !== "string")
    fail("project must be text");
  if (data.milestones !== undefined && data.milestones !== null && !isRecord(data.milestones))
    fail("milestones must be an object");

  // Optional fields may be missing or null (absent); present ones must have the right type.
  const optText = (v: unknown, where: string): string | undefined => {
    if (v === undefined || v === null) return undefined;
    return typeof v === "string" ? v : fail(`${where} must be text`);
  };
  const hours = (v: unknown, where: string): number => {
    if (v === undefined || v === null) return 0;
    return typeof v === "number" && Number.isFinite(v) ? v : fail(`${where} must be a number`);
  };
  const entry = (v: unknown, where: string): Json =>
    isRecord(v) ? v : fail(`${where} must be an object`);

  const tasks: Record<string, BaselineTask> = {};
  for (const [key, value] of Object.entries(data.tasks)) {
    const where = `task ${key}`;
    const t = entry(value, where);
    tasks[key] = {
      title: optText(t.title, `${where}: title`) ?? "",
      start: optText(t.start, `${where}: start`),
      finish: optText(t.finish, `${where}: finish`),
      hours: hours(t.hours, `${where}: hours`),
    };
  }
  const milestones: Record<string, BaselineMilestone> = {};
  for (const [id, value] of Object.entries(isRecord(data.milestones) ? data.milestones : {})) {
    const where = `milestone ${id}`;
    const m = entry(value, where);
    milestones[id] = {
      title: optText(m.title, `${where}: title`) ?? "",
      target: optText(m.target, `${where}: target`),
      start: optText(m.start, `${where}: start`),
      forecast: optText(m.forecast, `${where}: forecast`),
      hours: hours(m.hours, `${where}: hours`),
    };
  }
  return {
    name: data.name,
    date: data.date,
    project: typeof data.project === "string" ? data.project : "",
    tasks,
    milestones,
  };
}

/** True for the key of a task without an id (`milestones/M1.md#12`), which moves with its line. */
const isLineKey = (key: string) => /#\d+$/.test(key);

/** The Gantt's baseline lookup; `task` also takes the task's title (see {@link baselineLookup}). */
export interface TaskBaselineLookup extends BaselineLookup {
  task(key: string, title?: string): { start?: DayNumber; finish?: DayNumber } | undefined;
}

/**
 * Adapter for the Gantt view model: task keys and `milestone:<id>` keys. A task without an id is
 * stored under its file and line; given the task's title, an entry with another title is not
 * matched, because lines inserted or removed above the task since the baseline put another
 * task's entry under its key.
 */
export function baselineLookup(b: Baseline): TaskBaselineLookup {
  const day = (s: string | undefined): DayNumber | undefined => (s ? parseDate(s) : undefined);
  return {
    name: b.name,
    task(key: string, title?: string) {
      if (key.startsWith("milestone:")) {
        const m = own(b.milestones, key.slice("milestone:".length));
        return m ? { start: day(m.start), finish: day(m.forecast) } : undefined;
      }
      const t = own(b.tasks, key);
      if (!t) return undefined;
      if (title !== undefined && isLineKey(key) && t.title && t.title !== title) return undefined;
      return { start: day(t.start), finish: day(t.finish) };
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
    const bm = own(b.milestones, m.id);
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
