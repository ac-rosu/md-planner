// Checks for plans that read fine but say something the author probably did not mean: status dates
// that contradict the checkbox, dates outside the project or after the milestone target,
// dependencies on cancelled work, and parents whose estimate or status disagrees with their
// subtasks. Each issue carries what its quick fix needs in `data`.
import { formatDate, parseDate, parseDateRange } from "./dates";
import { formatHours } from "./duration";
import { isSchedulableTask } from "./graph";
import { attrIssue, depIdRange, statusRange } from "./issueRanges";
import { type Issue, isOpen, type Task } from "./model";
import { describeUnfinished, unfinishedMilestoneDeps } from "./queries";
import { type Plan } from "./resolve";
import {
  activeChildren,
  budgetSplit,
  hasLoggedWork,
  isEffectivelyCancelled,
  isEffectivelyDone,
  isLeaf,
  leavesOf,
  openSubtasks,
  startedOn,
} from "./rollup";
import { range } from "./text";

/** Differences below a minute are rounding. */
const EPS = 0.01;
const h = formatHours;

export function consistencyIssues(plan: Plan): Issue[] {
  const issues: Issue[] = [];
  for (const t of [...plan.tasks, ...plan.punch]) {
    statusDates(plan, t, issues);
    farStatusDates(plan, t, issues);
  }
  for (const t of plan.tasks) {
    parentStatus(t, issues);
    startedEarly(plan, t, issues);
    // Work in a cancelled milestone is not scheduled: its dates and dependencies change nothing.
    if (!isOpen(t.status) || isEffectivelyDone(t) || !isSchedulableTask(plan, t)) continue;
    dates(plan, t, issues);
    cancelledDeps(plan, t, issues);
    implied(plan, t, issues);
    parentEstimate(t, issues);
  }
  milestoneTargets(plan, issues);
  milestonesStartedEarly(plan, issues);
  teamDates(plan, issues);
  projectHolidays(plan, issues);
  return issues;
}

/** Project holidays longer than this close the project for what is rarely meant: a year typo. */
const LONG_HOLIDAY_DAYS = 31;

/**
 * Project holidays that stop all work for over a month (`2026-12-24..2027-12-02` for a Christmas
 * break, a year typo), and ones after the project end with a year that fits (as for team.md).
 * Nobody works on a holiday, so a wrong one quietly pushes the whole plan out.
 */
function projectHolidays(plan: Plan, issues: Issue[]): void {
  const project = plan.project;
  for (const e of project.props.entries) {
    const key = e.key.toLowerCase();
    if (key !== "holidays" && key !== "holiday") continue;
    for (const m of e.value.matchAll(PERIOD)) {
      const [text, from, to = from] = m;
      const period = parseDateRange(text);
      if (!period) continue;
      const at = e.valueRange.start.character + m.index;
      const days = period[1] - period[0] + 1;
      const suggestion =
        project.end && to > project.end ? suggestPeriodYear(plan, text) : undefined;
      if (days > LONG_HOLIDAY_DAYS || suggestion)
        issues.push({
          file: project.file,
          range: range(e.line, at, at + text.length),
          severity: "warning",
          code: days > LONG_HOLIDAY_DAYS ? "long-holiday" : "date-outside-project",
          message:
            days > LONG_HOLIDAY_DAYS
              ? `${e.key}: ${text} closes the project for ${Math.round(days / 7)} weeks: nobody works then. Is the year right?`
              : `${e.key}: ${text} is after the project end ${project.end}. Is the year right?`,
          data: { date: text, ...(suggestion ? { suggestion } : {}) },
        });
    }
  }
}

/** A date or a period (`2026-12-21..2026-12-31`) in a team.md value. */
const PERIOD = /(\d{4}-\d{2}-\d{2})(?:[ \t]*\.\.[ \t]*(\d{4}-\d{2}-\d{2}))?/g;

/**
 * Dates in team.md (capacity changes, time off, overtime, extra days) after the project end, each
 * date or period of a value on its own. A period that only runs a few days past the end is fine;
 * one that runs past it and lasts over a year (`2026-12-21..2027-12-31`) has a wrong year too.
 */
function teamDates(plan: Plan, issues: Issue[]): void {
  const end = plan.project.end;
  if (!end) return;
  const keys = new Set(["capacityfrom", "off", "overtime", "workday"]);
  for (const p of plan.people) {
    for (const e of p.props.entries) {
      if (!keys.has(e.key.toLowerCase())) continue;
      for (const m of e.value.matchAll(PERIOD)) {
        const [text, from, to = from] = m;
        // Invalid periods are reported by the resolver.
        if (to <= end || !parseDateRange(text)) continue;
        const suggestion = suggestPeriodYear(plan, text);
        if (from <= end && !suggestion) continue;
        const at = e.valueRange.start.character + m.index;
        issues.push({
          file: p.file,
          range: range(e.line, at, at + text.length),
          severity: "warning",
          code: "date-outside-project",
          message:
            from > end
              ? `${e.key}: ${text} is after the project end ${end}, so it only matters if the work runs that late. Is the year right?`
              : `${e.key}: ${text} runs past the project end ${end} and lasts over a year. Is the year right?`,
          data: { date: text, ...(suggestion ? { suggestion } : {}) },
        });
      }
    }
  }
}

/** Work under way in a milestone while a milestone it depends on is not finished. */
function startedEarly(plan: Plan, t: Task, issues: Issue[]): void {
  if (t.kind !== "task" || !isLeaf(t) || (t.status !== "doing" && t.status !== "review")) return;
  if (!isSchedulableTask(plan, t)) return;
  const waiting = unfinishedMilestoneDeps(plan, t.milestoneId);
  if (waiting.length === 0) return;
  issues.push({
    file: t.file,
    range: statusRange(t),
    severity: "info",
    code: "started-early",
    message: `Started while ${describeUnfinished(waiting)} ${waiting.length === 1 ? "is" : "are"} not finished. ${t.milestoneId} depends on ${waiting.length === 1 ? "it" : "them"}, so the rest of this work is scheduled after ${waiting.length === 1 ? "it" : "them"}.`,
  });
}

/** A milestone marked active while a milestone it depends on is not finished. */
function milestonesStartedEarly(plan: Plan, issues: Issue[]): void {
  for (const m of plan.milestones) {
    if (m.status !== "active") continue;
    const waiting = unfinishedMilestoneDeps(plan, m.id);
    const entry = m.props.entries.find((e) => e.key.toLowerCase() === "status");
    if (waiting.length === 0 || !entry) continue;
    issues.push({
      file: m.file,
      range: entry.valueRange,
      severity: "info",
      code: "milestone-started-early",
      message: `Active, but it depends on ${describeUnfinished(waiting)}, which ${waiting.length === 1 ? "is" : "are"} not finished.`,
    });
  }
}

/** `@started` / `@done` that disagree with the checkbox. */
function statusDates(plan: Plan, t: Task, issues: Issue[]): void {
  if (t.status === "todo" && t.started && !hasLoggedWork(t)) {
    issues.push(
      attrIssue(
        t,
        "started",
        "info",
        "stale-started",
        `To do, but @started:${t.started} is left from an earlier status; it is ignored until work starts.`
      )
    );
  }
  if (t.status === "done" && !t.done && isLeaf(t)) {
    // The burn-up counts it at the project start (else today, where the schedule starts).
    const start = plan.project.start;
    issues.push({
      file: t.file,
      range: statusRange(t),
      severity: "info",
      code: "missing-done",
      message:
        t.kind === "task"
          ? `Done without @done: the task has no place on the timeline, and the burn-up counts it as done ${start ? `from the project start ${start}` : "from today"}. Add the date it was finished.`
          : "Done without @done: add the date it was finished.",
    });
  }
  if (t.started && t.done && t.done < t.started) {
    issues.push(
      attrIssue(
        t,
        "done",
        "warning",
        "done-before-started",
        `@done ${t.done} is before @started ${t.started}.`
      )
    );
  }
}

/** More than this many days outside the project period, a status date is taken for a typo. */
const FAR_DAYS = 365;

/**
 * `@started` and `@done` more than a year before the project start or after its end: a mistyped
 * year (`@started:1026-07-01`) that stretches the burn-up and the timeline over centuries. Not a
 * to-do task's `@started`: it is ignored (see stale-started).
 */
function farStatusDates(plan: Plan, t: Task, issues: Issue[]): void {
  const { start, end } = plan.project;
  const startDay = start ? parseDate(start) : undefined;
  const endDay = end ? parseDate(end) : undefined;
  const started = startedOn(t);
  for (const key of ["started", "done"] as const) {
    const value = key === "started" ? started : t.done;
    const day = value ? parseDate(value) : undefined;
    if (day === undefined) continue;
    const before = startDay !== undefined && day < startDay - FAR_DAYS;
    const after = endDay !== undefined && day > endDay + FAR_DAYS;
    if (!before && !after) continue;
    // A suggestion that keeps @started on or before @done.
    const suggestion = suggestYearTypo(plan, value!, (d) =>
      key === "started" ? !t.done || d <= t.done : !started || d >= started
    );
    issues.push(
      attrIssue(
        t,
        key,
        "warning",
        "date-outside-project",
        `@${key} ${value} is more than a year ${before ? `before the project start ${start}` : `after the project end ${end}`}. Is the year right?`,
        suggestion ? { suggestion } : undefined
      )
    );
  }
}

/** Fixed starts and due dates that cannot be meant as written. */
function dates(plan: Plan, t: Task, issues: Issue[]): void {
  const { start, end } = plan.project;
  const m = plan.milestoneById(t.milestoneId);
  const underWay = t.status === "doing" || t.status === "review" || t.status === "blocked";
  const outside = new Set<string>();

  for (const key of ["start", "due"] as const) {
    const v = t[key];
    if (!v) continue;
    const after = end !== undefined && v > end;
    const before = key === "due" && start !== undefined && v < start;
    if (!after && !before) continue;
    outside.add(key);
    const suggestion = suggestYear(plan, v);
    issues.push(
      attrIssue(
        t,
        key,
        "warning",
        "date-outside-project",
        `@${key} ${v} is ${after ? `after the project end ${end}` : `before the project start ${start}`}. Is the year right?`,
        suggestion ? { suggestion } : undefined
      )
    );
  }

  if (underWay && t.start && t.started && t.start > t.started && !outside.has("start")) {
    issues.push(
      attrIssue(
        t,
        "start",
        "warning",
        "start-after-started",
        `Started on ${t.started}, but @start says not before ${t.start}, so the rest of the work waits until then.`
      )
    );
  }

  // A subtask's own @due wins over its parent's: a later one quietly lets it finish after the
  // parent is due.
  const parentDue = t.due && !outside.has("due") ? inheritedDue(t) : undefined;
  if (parentDue && t.due! > parentDue.due)
    issues.push(
      attrIssue(
        t,
        "due",
        "warning",
        "due-after-parent-due",
        `@due ${t.due} is after the @due ${parentDue.due} of ${parentDue.from.id ?? parentDue.from.title}, so the task is not reported late until ${t.due}, although ${parentDue.from.id ?? "its parent"} is late by then.`
      )
    );

  if (!m?.target) return;
  if (t.start && t.start > m.target && !outside.has("start")) {
    issues.push(
      attrIssue(
        t,
        "start",
        "warning",
        "start-after-target",
        `Fixed start ${t.start} is after the ${m.id} target ${m.target}, so the task cannot finish on time.`
      )
    );
  }
  if (t.due && t.due > m.target && !outside.has("due")) {
    issues.push(
      attrIssue(
        t,
        "due",
        "warning",
        "due-after-target",
        `@due ${t.due} is after the ${m.id} target ${m.target}, so the task is not reported late until its due date, although ${m.id} is late by then.`,
        { target: m.target }
      )
    );
  }
}

/** The nearest @due above a task and whose it is. */
function inheritedDue(t: Task): { due: string; from: Task } | undefined {
  for (let p = t.parent; p; p = p.parent) if (p.due) return { due: p.due, from: p };
  return undefined;
}

/** Dependencies on cancelled tasks (or tasks of a cancelled parent or milestone) never hold. */
function cancelledDeps(plan: Plan, t: Task, issues: Issue[]): void {
  for (const d of t.deps) {
    const target = plan.taskById(d.id);
    if (!target || target === t || isSchedulableTask(plan, target)) continue;
    const m = plan.milestoneById(target.milestoneId);
    const why =
      target.status === "cancelled"
        ? `${d.id} is cancelled`
        : m?.status === "cancelled" && !isEffectivelyCancelled(target)
          ? `${d.id} is in the cancelled milestone ${m.id}`
          : `${d.id} is part of a cancelled task`;
    issues.push({
      file: t.file,
      range: depIdRange(t, d.id),
      severity: "info",
      code: "cancelled-dep",
      message: `${why}, so this dependency is ignored.`,
      data: { depId: d.id },
    });
  }
}

/**
 * Dependencies another dependency in the same list already implies: a subtask of a listed task, or
 * a task another listed task waits for. Dependencies with a lag are kept (the lag says something
 * the other one does not), and so are dependencies a milestone's `depends:` covers: they document
 * the order of the work and stay right if the milestones change. Dependencies on cancelled work
 * count for nothing (see cancelledDeps), so they neither imply nor are implied.
 */
export function impliedDeps(plan: Plan, t: Task): Array<{ id: string; why: string }> {
  const listed = t.deps.flatMap((d) => {
    const task = plan.taskById(d.id);
    return task && isSchedulableTask(plan, task) ? [{ d, task }] : [];
  });
  const out: Array<{ id: string; why: string }> = [];
  for (const { d, task: x } of listed) {
    if (d.lagHours > 0 || x === t) continue;
    const parent = listed.find((o) => o.task !== x && isAncestorOf(o.task, x));
    if (parent) {
      out.push({ id: d.id, why: `${parent.d.id} includes it` });
      continue;
    }
    const via = listed.find(
      (o) => o.task !== x && waitsFor(plan, o.task, x) && !waitsFor(plan, x, o.task)
    );
    if (via) out.push({ id: d.id, why: `${via.d.id} waits for it` });
  }
  return out;
}

function implied(plan: Plan, t: Task, issues: Issue[]): void {
  const list = impliedDeps(plan, t);
  if (list.length === 0) return;
  const shown = list.slice(0, 6).map((x) => `${x.id} (${x.why})`);
  issues.push(
    attrIssue(
      t,
      "dep",
      "hint",
      "implied-dep",
      `Already implied by the other dependencies: ${shown.join(", ")}${list.length > 6 ? ", …" : ""}.`,
      { implied: list.map((x) => x.id).join(",") }
    )
  );
}

function isAncestorOf(a: Task, b: Task): boolean {
  for (let p = b.parent; p; p = p.parent) if (p === a) return true;
  return false;
}

/**
 * True when `y` still waits for `x` in the schedule: an open leaf of `y` depends on `x` or on a
 * parent of `x`, itself or through a parent. Done and cancelled work waits for nothing, so a
 * dependency it has does not hold anything else back.
 */
function waitsFor(plan: Plan, y: Task, x: Task): boolean {
  if (!isSchedulableTask(plan, y)) return false;
  return leavesOf(y).some((leaf) => {
    if (!isOpen(leaf.status) || isEffectivelyDone(leaf)) return false;
    for (let a: Task | undefined = leaf; a; a = a.parent)
      for (const d of a.deps) {
        const target = plan.taskById(d.id);
        if (target && (target === x || isAncestorOf(target, x))) return true;
      }
    return false;
  });
}

/**
 * A parent's `@est` is the budget of its subtasks. When every subtask has its own estimate, a
 * difference cannot be shared out: part of the estimate is not scheduled, or the subtasks need more.
 */
function parentEstimate(t: Task, issues: Issue[]): void {
  if (t.est === undefined || isLeaf(t)) return;
  const { estimated, logged, unestimated } = budgetSplit(t);
  const used = estimated + logged;
  const plus = logged > 0 ? ` (plus ${h(logged)} logged on the task itself)` : "";
  if (unestimated.length === 0 && t.est - used > EPS) {
    issues.push(
      attrIssue(
        t,
        "est",
        "warning",
        "parent-estimate-unscheduled",
        `This task's @est is ${h(t.est)}, but its subtasks add up to ${h(estimated)}${plus}: ${h(t.est - used)} is not scheduled. Add a subtask for the rest, or set @est to the subtasks' total.`,
        { remaining: h(t.est - used), total: h(used) }
      )
    );
  } else if (used - t.est > EPS) {
    issues.push(
      attrIssue(
        t,
        "est",
        "info",
        "parent-estimate-exceeded",
        `The subtasks add up to ${h(estimated)}${plus}, more than this task's @est ${h(t.est)}; their estimates are used${unestimated.length ? ", and the subtasks without an estimate get 0 hours" : ""}.`,
        { total: h(used) }
      )
    );
  }
}

/**
 * A parent whose checkbox disagrees with its subtasks. Open subtasks of a cancelled task are
 * cancelled with it, and cancelling a parent from the planner leaves them open on purpose, so the
 * nearest cancelled task gets an info rather than a warning: it says they are not scheduled, which
 * matters most for a task typed or moved under a cancelled one.
 */
function parentStatus(t: Task, issues: Issue[]): void {
  if (isLeaf(t)) return;
  if (t.status === "cancelled") {
    const open = openSubtasks(t);
    if (open.length === 0) return;
    const one = open.length === 1;
    issues.push({
      file: t.file,
      range: statusRange(t),
      severity: "info",
      code: "cancelled-parent-open-subtasks",
      message: `Cancelled, so its ${one ? "open subtask" : `${open.length} open subtasks`} (${names(open)}) ${one ? "is" : "are"} not scheduled either.`,
    });
    return;
  }
  if (isEffectivelyCancelled(t)) return;
  if (t.status === "done") {
    const open = openSubtasks(t);
    if (open.length === 0) return;
    issues.push({
      file: t.file,
      range: statusRange(t),
      severity: "warning",
      code: "done-parent-open-subtasks",
      message: `Done, but ${open.length === 1 ? "1 subtask is" : `${open.length} subtasks are`} still open (${names(open)}); they are no longer scheduled.`,
    });
    return;
  }
  if (t.status === "blocked" || isEffectivelyDone(t)) return;
  const kids = activeChildren(t);
  if (kids.length > 0 && kids.every((c) => c.status === "done")) {
    issues.push({
      file: t.file,
      range: statusRange(t),
      severity: "info",
      code: "open-parent-all-done",
      message: "All subtasks are done, but this task is still open.",
    });
  }
}

/** "T2, T3, T4, T5, T6, …" for messages: the first five ids (or titles). */
function names(tasks: Task[]): string {
  const list = tasks.map((s) => s.id ?? s.title);
  return `${list.slice(0, 5).join(", ")}${list.length > 5 ? ", …" : ""}`;
}

function milestoneTargets(plan: Plan, issues: Issue[]): void {
  const end = plan.project.end;
  if (!end) return;
  for (const m of plan.milestones) {
    if (!m.target || m.target <= end || m.status === "done" || m.status === "cancelled") continue;
    const entry = m.props.entries.find((e) => e.key.toLowerCase() === "target");
    if (!entry) continue;
    issues.push({
      file: m.file,
      range: entry.valueRange,
      severity: "warning",
      code: "date-outside-project",
      message: `Target ${m.target} is after the project end ${end}. Is the year right?`,
    });
  }
}

/** For a date outside the project period: the same day a year earlier or later, if that fits. */
export function suggestYear(plan: Plan, iso: string): string | undefined {
  const { start, end } = plan.project;
  const years = end !== undefined && iso > end ? -1 : start !== undefined && iso < start ? 1 : 0;
  if (years === 0) return undefined;
  const shifted = `${Number(iso.slice(0, 4)) + years}${iso.slice(4)}`;
  if (parseDate(shifted) === undefined) return undefined;
  if (start !== undefined && shifted < start) return undefined;
  if (end !== undefined && shifted > end) return undefined;
  return shifted;
}

/**
 * For a date far outside the project period: the same day in the one year that puts it in the
 * period (and that `fits` takes) and is a typo away from its year: one digit different, or two
 * neighbouring digits swapped (`1026` → `2026`, `2062` → `2026`). Without a project end the period
 * is taken to run a year from its start.
 */
export function suggestYearTypo(
  plan: Plan,
  iso: string,
  fits: (date: string) => boolean = () => true
): string | undefined {
  const { start, end } = plan.project;
  if (start === undefined) return undefined;
  const last = end !== undefined ? Number(end.slice(0, 4)) : Number(start.slice(0, 4)) + 1;
  const year = iso.slice(0, 4);
  const found: string[] = [];
  for (let y = Number(start.slice(0, 4)); y <= last && found.length < 2; y++) {
    const text = String(y).padStart(4, "0");
    if (!isYearTypo(year, text)) continue;
    const date = `${text}${iso.slice(4)}`;
    if (parseDate(date) === undefined || date < start || (end !== undefined && date > end))
      continue;
    if (fits(date)) found.push(date);
  }
  return found.length === 1 ? found[0] : undefined;
}

/** One digit different, or two neighbouring digits swapped. */
function isYearTypo(a: string, b: string): boolean {
  if (a.length !== b.length || a === b) return false;
  const diff: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
  if (diff.length === 1) return true;
  const [i, j] = diff;
  return diff.length === 2 && j === i + 1 && a[i] === b[j] && a[j] === b[i];
}

/**
 * For a team.md date or period (`2027-12-21..2027-12-31`) after the project end: the same text with
 * every date after the end a year earlier, when that is a period in the project (at least partly).
 * So a period stays a period, and one typed a year too long (`2026-12-21..2027-12-31`) gets its
 * end back in the right year.
 */
export function suggestPeriodYear(plan: Plan, text: string): string | undefined {
  const { start, end } = plan.project;
  if (end === undefined) return undefined;
  const shifted = text.replace(/\d{4}-\d{2}-\d{2}/g, (d) =>
    d > end ? `${Number(d.slice(0, 4)) - 1}${d.slice(4)}` : d
  );
  const period = shifted === text ? undefined : parseDateRange(shifted);
  if (!period) return undefined;
  if (start !== undefined && formatDate(period[1]) < start) return undefined;
  if (formatDate(period[0]) > end) return undefined;
  return shifted;
}
