// Checks for plans that read fine but say something the author probably did not mean: status dates
// that contradict the checkbox, dates outside the project or after the milestone target,
// dependencies on cancelled work, and parents whose estimate or status disagrees with their
// subtasks. Each issue carries what its quick fix needs in `data`.
import { parseDate } from "./dates";
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
  openSubtasks,
} from "./rollup";

/** Differences below a minute are rounding. */
const EPS = 0.01;
const h = formatHours;

export function consistencyIssues(plan: Plan): Issue[] {
  const issues: Issue[] = [];
  for (const t of [...plan.tasks, ...plan.punch]) statusDates(t, issues);
  for (const t of plan.tasks) {
    parentStatus(t, issues);
    startedEarly(plan, t, issues);
    if (!isOpen(t.status) || isEffectivelyDone(t) || isEffectivelyCancelled(t)) continue;
    dates(plan, t, issues);
    cancelledDeps(plan, t, issues);
    implied(plan, t, issues);
    parentEstimate(t, issues);
  }
  milestoneTargets(plan, issues);
  milestonesStartedEarly(plan, issues);
  teamDates(plan, issues);
  return issues;
}

/** Dates in team.md (capacity changes, time off, overtime, extra days) after the project end. */
function teamDates(plan: Plan, issues: Issue[]): void {
  const end = plan.project.end;
  if (!end) return;
  const keys = new Set(["capacityfrom", "off", "overtime", "workday"]);
  for (const p of plan.people) {
    for (const e of p.props.entries) {
      if (!keys.has(e.key.toLowerCase())) continue;
      const date = /\d{4}-\d{2}-\d{2}/.exec(e.value)?.[0];
      if (!date || date <= end) continue;
      const suggestion = suggestYear(plan, date);
      issues.push({
        file: p.file,
        range: e.valueRange,
        severity: "warning",
        code: "date-outside-project",
        message: `${e.key}: ${date} is after the project end ${end}, so it changes nothing. Is the year right?`,
        data: { date, ...(suggestion ? { suggestion } : {}) },
      });
    }
  }
}

/** Work under way in a milestone while a milestone it depends on is not finished. */
function startedEarly(plan: Plan, t: Task, issues: Issue[]): void {
  if (t.kind !== "task" || !isLeaf(t) || (t.status !== "doing" && t.status !== "review")) return;
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
function statusDates(t: Task, issues: Issue[]): void {
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
    issues.push({
      file: t.file,
      range: statusRange(t),
      severity: "info",
      code: "missing-done",
      message:
        "Done without @done: the task has no place on the timeline or in the burn-up. Add the date it was finished.",
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
 * the order of the work and stay right if the milestones change.
 */
export function impliedDeps(plan: Plan, t: Task): Array<{ id: string; why: string }> {
  const listed = t.deps.flatMap((d) => {
    const task = plan.taskById(d.id);
    return task ? [{ d, task }] : [];
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

/** True when `y` (or a parent of it) directly depends on `x` or on a parent of `x`. */
function waitsFor(plan: Plan, y: Task, x: Task): boolean {
  for (let a: Task | undefined = y; a; a = a.parent)
    for (const d of a.deps) {
      const target = plan.taskById(d.id);
      if (target && (target === x || isAncestorOf(target, x))) return true;
    }
  return false;
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

/** A parent whose checkbox disagrees with its subtasks. */
function parentStatus(t: Task, issues: Issue[]): void {
  if (isLeaf(t) || isEffectivelyCancelled(t)) return;
  if (t.status === "done") {
    const open = openSubtasks(t);
    if (open.length === 0) return;
    const names = open.map((s) => s.id ?? s.title);
    issues.push({
      file: t.file,
      range: statusRange(t),
      severity: "warning",
      code: "done-parent-open-subtasks",
      message: `Done, but ${open.length === 1 ? "1 subtask is" : `${open.length} subtasks are`} still open (${names.slice(0, 5).join(", ")}${names.length > 5 ? ", …" : ""}); they are no longer scheduled.`,
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
