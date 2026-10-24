// Gantt view model: rows (groups, parents, tasks, milestones), bars, dependency links and calendar
// data. Built from the plan and schedule; rendered by the Gantt webview and the HTML export.
import { describeLateCause, lateCause } from "../lateCause";
import { UNASSIGNED } from "../calendar";
import { type DayNumber, isoWeekday, parseDate } from "../dates";
import { formatHours } from "../duration";
import { describeOvertime, taskOvertime } from "../load";
import { isOpen, type Milestone, STATUS_LABEL, type Status, type Task } from "../model";
import { type Plan } from "../resolve";
import {
  estimateHours,
  initials,
  isLeaf,
  leavesOf,
  ownerOf,
  progressOf,
  remainingHours,
} from "../rollup";
import { type Schedule, taskKey } from "../scheduler";
import { milestoneColor, NEUTRAL, personColor, statusColor } from "./colors";

export type GanttGrouping = "milestone" | "section" | "owner" | "tag";

export interface GanttRow {
  /** Unique row key. Task rows use the task key. */
  key: string;
  kind: "group" | "milestone" | "parent" | "task";
  title: string;
  level: number;
  /** Key of the collapsible row this row sits under. */
  parent?: string;
  hasChildren: boolean;
  /** Task key (task and parent rows). */
  task?: string;
  id?: string;
  start?: DayNumber;
  finish?: DayNumber;
  progress: number;
  status?: Status;
  owner?: string;
  ownerName?: string;
  ownerInitials?: string;
  milestone?: string;
  colors: { owner: string; status: string; milestone: string };
  critical: boolean;
  slack?: number;
  late: boolean;
  hours?: number;
  remaining?: number;
  /** Raw `@est` value for the edit form. */
  est?: string;
  /** Milestone target (milestone rows) or task deadline. */
  target?: DayNumber;
  deadline?: DayNumber;
  baselineStart?: DayNumber;
  baselineFinish?: DayNumber;
  /** Working days of slip against the baseline finish (positive = later). */
  slip?: number;
  editable: boolean;
  unscheduled?: string;
  fixedStart?: DayNumber;
  /** Hours of overtime and extra working days scheduled (own, or of the tasks below). */
  overtime?: number;
  /** Days with such hours, in order. */
  overtimeDays?: DayNumber[];
  tooltip: string[];
}

export interface GanttLink {
  from: string;
  to: string;
  critical: boolean;
}

export interface GanttModel {
  today: DayNumber;
  /** Range worth showing: project start (or first bar) to project end (or last bar). */
  start: DayNumber;
  end: DayNumber;
  workweek: number[];
  holidays: DayNumber[];
  rows: GanttRow[];
  links: GanttLink[];
  people: Array<{ id: string; name: string; color: string }>;
  grouping: GanttGrouping;
  projectName: string;
  baseline?: string;
}

export interface BaselineLookup {
  name: string;
  task(key: string): { start?: DayNumber; finish?: DayNumber } | undefined;
}

export interface GanttOptions {
  grouping: GanttGrouping;
  baseline?: BaselineLookup;
  /** Hide done tasks (default false). */
  hideDone?: boolean;
}

export function buildGanttModel(plan: Plan, schedule: Schedule, options: GanttOptions): GanttModel {
  const cal = schedule.calendar;
  const people = plan.people.map((p, i) => ({
    id: p.id,
    name: p.name,
    color: personColor(p.color, i),
  }));
  const personIndex = new Map(people.map((p, i) => [p.id.toLowerCase(), i]));
  const milestoneIndex = new Map(plan.milestones.map((m, i) => [m.id, i]));
  const rows: GanttRow[] = [];
  const baseline = options.baseline;

  const colorsFor = (t: Task | undefined, milestoneId: string | undefined) => {
    const owner = t ? ownerOf(t)?.toLowerCase() : undefined;
    const pi = owner ? personIndex.get(owner) : undefined;
    return {
      owner:
        owner === undefined || owner === UNASSIGNED
          ? NEUTRAL
          : pi === undefined
            ? NEUTRAL
            : people[pi].color,
      status: t ? statusColor(t.status) : NEUTRAL,
      milestone: milestoneColor(milestoneIndex.get(milestoneId ?? "") ?? 0),
    };
  };

  const fmt = (d: DayNumber | undefined) => (d === undefined ? "—" : isoOf(d));

  const taskRow = (t: Task, level: number, parent: string | undefined): GanttRow => {
    const key = taskKey(t);
    const leaf = isLeaf(t);
    const ts = schedule.tasks.get(t);
    const roll = schedule.parents.get(t);
    const owner = ownerOf(t);
    const person = owner ? plan.personById(owner) : undefined;
    const start = leaf ? ts?.start : roll?.start;
    const finish = leaf ? ts?.finish : roll?.finish;
    const est = estimateHours(t);
    const b = baseline?.task(key);
    const tooltip = [
      `${t.id ? `${t.id} · ` : ""}${t.title}`,
      `${STATUS_LABEL[t.status]}${person ? ` · ${person.name}` : owner ? ` · ${owner}` : ""}`,
      `${fmt(start)} → ${fmt(finish)}`,
    ];
    if (est !== undefined)
      tooltip.push(`Estimate ${formatHours(est)} · remaining ${formatHours(remainingHours(t))}`);
    if (ts?.slack !== undefined)
      tooltip.push(
        `Slack ${ts.slack} working day${Math.abs(ts.slack) === 1 ? "" : "s"}${ts.critical ? " · critical" : ""}`
      );
    if (ts?.deadline !== undefined)
      tooltip.push(`Deadline ${isoOf(ts.deadline)}${ts.late ? " – late" : ""}`);
    if (ts?.late) {
      const cause = lateCause(schedule, t);
      if (cause) tooltip.push(describeLateCause(plan, t, cause));
    }
    if (t.start)
      tooltip.push(`Fixed start: not before ${t.start} · right-click → Remove fixed start`);
    if (ts?.unscheduled) tooltip.push(`Not scheduled: ${unscheduledText(ts.unscheduled)}`);
    if (t.blocked) tooltip.push(`Blocked: ${t.blocked}`);
    let slip: number | undefined;
    if (b?.finish !== undefined && finish !== undefined) {
      slip = cal.workingDaysBetween(b.finish, finish);
      if (slip !== 0)
        tooltip.push(
          `Baseline ${fmt(b.start)} → ${fmt(b.finish)} (${slip > 0 ? `+${slip}` : slip} d)`
        );
    }
    return {
      key,
      kind: leaf ? "task" : "parent",
      title: t.title || "(untitled)",
      level,
      parent,
      hasChildren: !leaf,
      task: key,
      id: t.id,
      start,
      finish,
      progress: progressOf(t),
      status: t.status,
      owner,
      ownerName: person?.name ?? owner,
      ownerInitials: owner ? initials(person?.name ?? owner) : undefined,
      milestone: t.milestoneId,
      colors: colorsFor(t, t.milestoneId),
      critical: ts?.critical ?? false,
      slack: ts?.slack,
      late: ts?.late ?? false,
      hours: est,
      remaining: remainingHours(t),
      est: t.attrs.find((a) => a.key === "est")?.value,
      deadline: ts?.deadline,
      baselineStart: b?.start,
      baselineFinish: b?.finish,
      slip,
      editable: leaf && isOpen(t.status) && t.kind === "task",
      unscheduled: ts?.unscheduled,
      fixedStart: t.start ? parseDate(t.start) : undefined,
      tooltip,
    };
  };

  const visible = (t: Task) =>
    t.status !== "cancelled" && !(options.hideDone && t.status === "done");

  const addTaskTree = (t: Task, level: number, parent: string | undefined) => {
    if (!visible(t)) return;
    const row = taskRow(t, level, parent);
    rows.push(row);
    for (const c of t.children) addTaskTree(c, level + 1, row.key);
  };

  const milestoneRow = (m: Milestone, level: number, key: string): GanttRow => {
    const ms = schedule.milestones.get(m.id);
    const tooltip = [m.title];
    if (ms?.target !== undefined) tooltip.push(`Target ${isoOf(ms.target)}`);
    if (ms?.forecast !== undefined)
      tooltip.push(
        `Forecast ${isoOf(ms.forecast)}${ms.variance !== undefined && ms.variance !== 0 ? ` (${ms.variance > 0 ? `${ms.variance} d late` : `${-ms.variance} d ahead`})` : ""}`
      );
    tooltip.push(`${Math.round((ms?.progress ?? 0) * 100)}% complete`);
    const b = baseline?.task(`milestone:${m.id}`);
    return {
      key,
      kind: "milestone",
      title: m.title,
      level,
      hasChildren: true,
      id: m.id,
      start: ms?.start,
      finish: ms?.forecast,
      progress: ms?.progress ?? 0,
      milestone: m.id,
      colors: colorsFor(undefined, m.id),
      critical: false,
      late: ms?.late ?? false,
      target: ms?.target,
      baselineStart: b?.start,
      baselineFinish: b?.finish,
      slip:
        b?.finish !== undefined && ms?.forecast !== undefined
          ? cal.workingDaysBetween(b.finish, ms.forecast)
          : undefined,
      editable: false,
      tooltip,
    };
  };

  switch (options.grouping) {
    case "milestone":
      for (const m of plan.milestones) {
        if (m.status === "cancelled") continue;
        const mKey = `milestone:${m.id}`;
        rows.push(milestoneRow(m, 0, mKey));
        for (const t of m.rootTasks) addTaskTree(t, 1, mKey);
        for (const s of m.sections) {
          if (!s.tasks.some(visible)) continue;
          const sKey = `section:${m.id}:${s.line}`;
          const roll = schedule.sections.get(s);
          rows.push({
            key: sKey,
            kind: "group",
            title: s.title,
            level: 1,
            parent: mKey,
            hasChildren: true,
            start: roll?.start,
            finish: roll?.finish,
            progress: roll?.progress ?? 0,
            milestone: m.id,
            colors: colorsFor(undefined, m.id),
            critical: false,
            late: false,
            editable: false,
            tooltip: [
              `${m.id} › ${s.title}`,
              `${fmt(roll?.start)} → ${fmt(roll?.finish)}`,
              `${Math.round((roll?.progress ?? 0) * 100)}% complete`,
            ],
          });
          for (const t of s.tasks) addTaskTree(t, 2, sKey);
        }
      }
      break;
    case "section":
      for (const m of plan.milestones) {
        if (m.status === "cancelled") continue;
        const groups: Array<{ key: string; title: string; tasks: Task[] }> = [];
        if (m.rootTasks.length)
          groups.push({ key: `section:${m.id}:root`, title: m.title, tasks: m.rootTasks });
        for (const s of m.sections)
          groups.push({
            key: `section:${m.id}:${s.line}`,
            title: `${m.id} › ${s.title}`,
            tasks: s.tasks,
          });
        for (const g of groups) {
          const leaves = g.tasks
            .filter(visible)
            .flatMap((t) => leavesOf(t))
            .filter(visible);
          if (leaves.length === 0) continue;
          rows.push(groupRow(g.key, g.title, leaves, m.id));
          for (const t of g.tasks) addTaskTree(t, 1, g.key);
        }
      }
      break;
    case "owner":
    case "tag": {
      const buckets = new Map<string, { title: string; tasks: Task[] }>();
      const order: string[] = [];
      if (options.grouping === "owner") {
        for (const p of plan.people) {
          buckets.set(p.id.toLowerCase(), { title: p.name, tasks: [] });
          order.push(p.id.toLowerCase());
        }
      }
      for (const t of plan.tasks) {
        if (!isLeaf(t) || !visible(t) || !schedule.tasks.has(t)) continue;
        const k =
          options.grouping === "owner"
            ? (ownerOf(t)?.toLowerCase() ?? UNASSIGNED)
            : (t.tags[0]?.tag ?? inheritedTag(t) ?? "");
        if (!buckets.has(k)) {
          const title =
            options.grouping === "owner"
              ? k === UNASSIGNED
                ? "Unassigned"
                : k
              : k === ""
                ? "(no tag)"
                : `#${k}`;
          buckets.set(k, { title, tasks: [] });
          order.push(k);
        }
        buckets.get(k)!.tasks.push(t);
      }
      const keys =
        options.grouping === "tag"
          ? [...order].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
          : order;
      for (const k of keys) {
        const b = buckets.get(k)!;
        if (b.tasks.length === 0) continue;
        const gKey = `${options.grouping}:${k}`;
        rows.push(groupRow(gKey, b.title, b.tasks, undefined));
        for (const t of b.tasks) rows.push(taskRow(t, 1, gKey));
      }
      break;
    }
  }

  function groupRow(
    key: string,
    title: string,
    leaves: Task[],
    milestone: string | undefined
  ): GanttRow {
    let start: DayNumber | undefined;
    let finish: DayNumber | undefined;
    let total = 0;
    let done = 0;
    for (const l of leaves) {
      const ts = schedule.tasks.get(l);
      if (ts?.start !== undefined && (start === undefined || ts.start < start)) start = ts.start;
      if (ts?.finish !== undefined && (finish === undefined || ts.finish > finish))
        finish = ts.finish;
      const est = estimateHours(l) ?? 0;
      total += est;
      done += est * progressOf(l);
    }
    const progress = total > 0 ? done / total : 0;
    return {
      key,
      kind: "group",
      title,
      level: 0,
      hasChildren: true,
      start,
      finish,
      progress,
      milestone,
      colors: colorsFor(undefined, milestone),
      critical: false,
      late: false,
      editable: false,
      tooltip: [
        title,
        `${fmt(start)} → ${fmt(finish)}`,
        `${leaves.length} tasks · ${Math.round(progress * 100)}% complete`,
      ],
    };
  }

  // Dependency links between visible task rows (leaf level, as scheduled).
  const rowKeys = new Set(
    rows.filter((r) => r.kind === "task" || r.kind === "parent").map((r) => r.key)
  );
  addOvertime(rows, taskOvertime(schedule), isoOf);

  const links: GanttLink[] = [];
  const seen = new Set<string>();
  for (const t of plan.tasks) {
    if (!rowKeys.has(taskKey(t))) continue;
    for (const d of t.deps) {
      const pred = plan.taskById(d.id);
      if (!pred || !rowKeys.has(taskKey(pred))) continue;
      const k = `${taskKey(pred)}→${taskKey(t)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const a = schedule.tasks.get(pred);
      const b = schedule.tasks.get(t);
      links.push({ from: taskKey(pred), to: taskKey(t), critical: !!(a?.critical && b?.critical) });
    }
  }

  // Range: project start/end, extended to cover every bar.
  let start = plan.project.start ? parseDate(plan.project.start)! : schedule.start;
  let end = plan.project.end
    ? parseDate(plan.project.end)!
    : (schedule.finish ?? schedule.start + 90);
  for (const r of rows) {
    for (const d of [r.start, r.finish, r.target, r.baselineStart, r.baselineFinish]) {
      if (d === undefined) continue;
      if (d < start) start = d;
      if (d > end) end = d;
    }
  }
  if (schedule.today < start) start = schedule.today;
  if (schedule.today > end) end = schedule.today;

  const holidays: DayNumber[] = [];
  for (const [a, b] of plan.project.holidays)
    for (let d = a; d <= b; d++) if (d >= start - 7 && d <= end + 60) holidays.push(d);

  return {
    today: schedule.today,
    start,
    end,
    workweek: [...plan.project.workweek].sort(),
    holidays,
    rows,
    links,
    people,
    grouping: options.grouping,
    projectName: plan.project.name,
    baseline: baseline?.name,
  };
}

function inheritedTag(t: Task): string | undefined {
  for (let p = t.parent; p; p = p.parent) if (p.tags.length) return p.tags[0].tag;
  return undefined;
}

export function unscheduledText(reason: string): string {
  switch (reason) {
    case "cycle":
      return "circular dependency";
    case "blocked-by-cycle":
      return "depends on a circular dependency";
    default:
      return "no capacity within the horizon";
  }
}

function isoOf(d: DayNumber): string {
  const date = new Date(d * 86_400_000);
  return date.toISOString().slice(0, 10);
}

/** True when the day is a working day of the model's calendar. */
export function isModelWorkingDay(
  model: Pick<GanttModel, "workweek" | "holidays">,
  day: DayNumber
): boolean {
  return model.workweek.includes(isoWeekday(day)) && !model.holidays.includes(day);
}

/**
 * Overtime on the task rows that use it and, summed, on every row above them (parents, sections,
 * milestones, groups), with a tooltip line each.
 */
function addOvertime(
  rows: GanttRow[],
  overtime: ReturnType<typeof taskOvertime>,
  format: (d: DayNumber) => string
): void {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const sums = new Map<string, { hours: number; days: Set<DayNumber>; tasks: string[] }>();
  const round = (n: number) => Math.round(n * 10) / 10;
  for (const r of rows) {
    if (r.kind !== "task" || !r.task) continue;
    const o = overtime.get(r.task);
    if (!o) continue;
    r.overtime = round(o.hours);
    r.overtimeDays = o.days.map((d) => d.day);
    r.tooltip.push(describeOvertime(o, format));
    for (let p = r.parent; p !== undefined; p = byKey.get(p)?.parent) {
      let sum = sums.get(p);
      if (!sum) sums.set(p, (sum = { hours: 0, days: new Set(), tasks: [] }));
      sum.hours += o.hours;
      for (const d of o.days) sum.days.add(d.day);
      sum.tasks.push(r.id ?? r.title);
    }
  }
  for (const [key, sum] of sums) {
    const row = byKey.get(key);
    if (!row) continue;
    row.overtime = round(sum.hours);
    row.overtimeDays = [...sum.days].sort((a, b) => a - b);
    const names =
      sum.tasks.length <= 4
        ? sum.tasks.join(", ")
        : `${sum.tasks.slice(0, 4).join(", ")} and ${sum.tasks.length - 4} more`;
    row.tooltip.push(`Includes ${row.overtime} h of overtime: ${names}`);
  }
}
