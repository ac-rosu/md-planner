// Task tools: create (with refs, subtasks, dependencies across the call), change every field,
// move, delete (with the dependencies on them), log time and add missing ids.
import { isValidDate } from "../core/dates";
import { parseDuration } from "../core/duration";
import { type Priority, STATUSES, type Status, type Task } from "../core/model";
import { taskKey } from "../core/scheduler";
import { addActual, parseLoggedTime } from "../core/time";
import { isValidTaskId } from "../core/navigation";
import {
  applyStatus,
  assignMissingIds,
  editTaskLine,
  type FileEdit,
  insertTasks,
  type InsertLocation,
  type MovedTask,
  moveTaskTo,
  renameIdProblem,
  renameTaskId as renameTaskIdEdits,
  setNotes,
  startsWork,
  statusSideEdits,
  type SubtaskChoice,
} from "../core/writer";
import { deleteTaskWithLinks } from "../core/writer/entities";
import { describeUnfinished, unfinishedMilestoneDeps } from "../core/queries";
import { openSubtasks } from "../core/rollup";
import { leavesSchedule, placeTask } from "../core/writer/structure";
import { milestoneOf } from "./milestoneTools";
import { workspaceSettings } from "./settings";
import { type Staging } from "./staging";
import { allocateIds, buildTasks, personOf, TaskRefs, type TaskSpec } from "./taskSpecs";
import { findTask, type PlannerTools, ToolError } from "./tools";

export interface TaskLocation {
  /** Milestone id or name (not needed with a parent). */
  milestone?: string;
  /** `##` section; created when missing. */
  section?: string;
  /** Parent task id: the tasks become its subtasks. */
  parent?: string;
}

/** A group of new tasks at one place, with ids allocated (see build_plan for several groups). */
export interface TaskGroup {
  location: TaskLocation;
  specs: TaskSpec[];
  ids: Map<TaskSpec, string>;
  where: string;
}

/** Allocates the ids of a group (call for every group before building any of them). */
export function prepareGroup(
  st: Staging,
  refs: TaskRefs,
  location: TaskLocation,
  specs: TaskSpec[]
): TaskGroup {
  if (!specs?.length) throw new ToolError("No tasks given.");
  const where = location.parent
    ? `Under ${location.parent}:`
    : `${location.milestone ?? "?"}${location.section ? ` › ${location.section}` : ""}:`;
  const milestone = location.parent
    ? undefined
    : location.milestone
      ? milestoneOf(st.plan, location.milestone)?.id
      : undefined;
  return { location, specs, ids: allocateIds(st.plan, specs, refs, milestone), where };
}

/** Builds and inserts a prepared group; problems are collected in `errors` (nothing inserted). */
export function stageGroup(
  st: Staging,
  refs: TaskRefs,
  group: TaskGroup,
  today: string,
  errors: string[]
): void {
  const plan = st.plan;
  const { location } = group;
  let target: { file: string; location: InsertLocation } | undefined;
  if (location.parent) {
    const parent = findTask(plan, location.parent);
    if (!parent || parent.kind !== "task")
      errors.push(`${group.where} unknown parent task "${location.parent}".`);
    else target = { file: parent.file, location: { kind: "child", task: parent } };
  } else {
    const m = location.milestone ? milestoneOf(plan, location.milestone) : undefined;
    if (!m)
      errors.push(
        `${group.where} unknown milestone "${location.milestone ?? ""}" (${plan.milestones.map((x) => x.id).join(", ") || "none yet"}).`
      );
    else
      target = {
        file: m.file,
        location: location.section?.trim()
          ? { kind: "section", title: location.section.replace(/\s+/g, " ").trim() }
          : { kind: "root" },
      };
  }
  const before = errors.length;
  const tasks = buildTasks(plan, group.specs, group.ids, refs, today, errors, group.where);
  if (!target || errors.length > before) return;
  const file = plan.file(target.file)!;
  st.apply({ path: file.path, edits: insertTasks(file, target.location, tasks) });
  const milestone = plan.milestones.find((m) => m.file === target!.file)?.id;
  const ids = new Set(group.ids.values());
  for (const c of refs.created) if (ids.has(c.id)) c.milestone = milestone;
}

export function createTasks(tools: PlannerTools, args: TaskLocation & { tasks: TaskSpec[] }) {
  const st = tools.stage();
  const refs = new TaskRefs();
  const group = prepareGroup(st, refs, args, args.tasks);
  const errors: string[] = [];
  stageGroup(st, refs, group, tools.today, errors);
  if (errors.length) throw new ToolError(errors.join("\n"));
  const changed = tools.commit(st);
  return {
    created: refs.created.map(({ ref, id, title }) => ({ ...(ref ? { ref } : {}), id, title })),
    changed,
    ...(refs.warnings.length ? { warnings: refs.warnings } : {}),
  };
}

export interface TaskUpdate {
  id: string;
  title?: string;
  status?: Status;
  /** Reason (status blocked). */
  blocked?: string;
  /** Finishing a task with open subtasks: finish them too, cancel them, or keep them open. */
  subtasks?: SubtaskChoice;
  /** Start (or finish) it although a milestone its milestone depends on is not finished. */
  startEarly?: boolean;
  estimate?: string;
  actual?: string;
  /** Person id or name; "" removes the owner. */
  owner?: string;
  start?: string;
  due?: string;
  priority?: Priority;
  progress?: string;
  addTags?: string[];
  removeTags?: string[];
  /** Replaces the dependencies (ids, optional lag T101+2d); [] removes them. */
  dependsOn?: string[];
  addDependsOn?: string[];
  removeDependsOn?: string[];
  /** Any attribute; "" removes it. */
  attributes?: Record<string, string>;
  /** Replaces the description lines; "" or [] removes them. */
  notes?: string | string[];
}

/** Stages one task update against the staged plan. */
export function stageTaskUpdate(
  st: Staging,
  u: TaskUpdate,
  today: string,
  options: { rollUp: boolean; confirmEarlyStart: boolean } = {
    rollUp: true,
    confirmEarlyStart: true,
  }
): string {
  const plan = st.plan;
  const t = findTask(plan, u.id);
  if (!t) throw new ToolError(`Unknown task "${u.id}".`);
  const hpd = plan.project.hoursPerDay;
  const errors: string[] = [];
  const check = (cond: boolean, msg: string) => {
    if (!cond) errors.push(`${u.id}: ${msg}`);
  };
  if (u.status !== undefined) check(STATUSES.includes(u.status), `invalid status "${u.status}".`);
  if (u.estimate)
    check(parseDuration(u.estimate, hpd) !== undefined, `invalid estimate "${u.estimate}".`);
  if (u.actual) check(parseDuration(u.actual, hpd) !== undefined, `invalid actual "${u.actual}".`);
  let owner: string | undefined;
  if (u.owner) {
    owner = personOf(plan, u.owner);
    check(
      !!owner,
      `unknown owner "${u.owner}" (team: ${plan.people.map((p) => p.id).join(", ")}).`
    );
  }
  for (const d of [u.start, u.due])
    if (d) check(isValidDate(d), `invalid date "${d}" (YYYY-MM-DD).`);
  if (u.priority)
    check(["high", "med", "low"].includes(u.priority), `invalid priority "${u.priority}".`);
  if (u.progress)
    check(
      /^\d{1,3}%$/.test(u.progress) && Number(u.progress.slice(0, -1)) <= 100,
      `invalid progress "${u.progress}" (e.g. 40%).`
    );
  if (u.title !== undefined) check(u.title.trim() !== "", "the title cannot be empty.");
  const depId = (raw: string) => raw.trim().replace(/\+.*$/, "");
  for (const d of [...(u.dependsOn ?? []), ...(u.addDependsOn ?? [])]) {
    const dep = plan.taskById(depId(d));
    check(!!dep, `unknown dependency "${d}".`);
    if (dep === t) check(false, "a task cannot depend on itself.");
  }
  for (const k of Object.keys(u.attributes ?? {}))
    check(/^[A-Za-z][\w-]*$/.test(k), `invalid attribute name "${k}".`);
  const statusChange = u.status !== undefined && u.status !== t.status ? u.status : undefined;
  const open = statusChange === "done" ? openSubtasks(t) : [];
  if (u.subtasks !== undefined)
    check(["done", "cancelled", "keep"].includes(u.subtasks), `invalid subtasks "${u.subtasks}".`);
  else if (open.length)
    check(
      false,
      `has ${open.length} open subtask${open.length === 1 ? "" : "s"} (${open.map((x) => x.id ?? x.title).join(", ")}): pass subtasks "done" to finish them too, "cancelled" to cancel them, or "keep" to leave them open (they are no longer scheduled).`
    );
  if (statusChange && options.confirmEarlyStart && !u.startEarly && startsWork(t, statusChange)) {
    const waiting = unfinishedMilestoneDeps(plan, t.milestoneId);
    if (waiting.length)
      check(
        false,
        `${t.milestoneId} waits for ${describeUnfinished(waiting)}. If the work really started, pass startEarly: true.`
      );
  }
  if (errors.length) throw new ToolError(errors.join("\n"));

  let deps: string[] | undefined;
  if (u.dependsOn || u.addDependsOn || u.removeDependsOn) {
    const remove = new Set((u.removeDependsOn ?? []).map((d) => depId(d).toLowerCase()));
    const list = [...(u.dependsOn ?? t.deps.map((d) => d.raw)), ...(u.addDependsOn ?? [])].map(
      (d) => {
        const id = plan.taskById(depId(d))?.id ?? depId(d);
        return id + d.trim().slice(depId(d).length);
      }
    );
    deps = list.filter(
      (d, i) =>
        !remove.has(depId(d).toLowerCase()) &&
        list.findIndex((x) => depId(x).toLowerCase() === depId(d).toLowerCase()) === i
    );
  }
  const opt = (v: string | undefined) => (v === "" ? undefined : v);
  const file = plan.file(t.file)!;
  const edits = editTaskLine(file.lines, t, (e) => {
    if (u.title !== undefined) e.setTitle(u.title.replace(/\s+/g, " ").trim());
    if (u.status !== undefined && u.status !== t.status)
      applyStatus(e, t, u.status, today, { blockedReason: u.blocked || undefined });
    else if (u.blocked !== undefined) e.setAttr("blocked", opt(u.blocked));
    if (u.estimate !== undefined) e.setAttr("est", opt(u.estimate));
    if (u.actual !== undefined) e.setAttr("act", opt(u.actual));
    if (u.owner !== undefined) e.setAttr("owner", owner);
    if (u.start !== undefined) e.setAttr("start", opt(u.start));
    if (u.due !== undefined) e.setAttr("due", opt(u.due));
    if (u.priority !== undefined) e.setAttr("prio", u.priority === "med" ? undefined : u.priority);
    if (u.progress !== undefined) e.setAttr("progress", opt(u.progress));
    if (deps) e.setAttr("dep", deps.length ? deps.join(",") : undefined);
    for (const [k, v] of Object.entries(u.attributes ?? {})) e.setAttr(k, opt(v));
    for (const tag of u.addTags ?? []) e.addTag(tag.replace(/^#/, ""));
    for (const tag of u.removeTags ?? []) e.removeTag(tag.replace(/^#/, ""));
  });
  if (statusChange)
    edits.push(
      ...statusSideEdits(file.lines, t, statusChange, today, {
        subtasks: u.subtasks,
        rollUp: options.rollUp,
      })
    );
  if (u.notes !== undefined) edits.push(...setNotes(file.lines, t, [u.notes].flat()));
  st.apply({ path: file.path, edits });
  return t.id ?? taskKey(t);
}

export function updateTasks(tools: PlannerTools, args: { updates: TaskUpdate[] }) {
  if (!args.updates?.length) throw new ToolError("No updates given.");
  const st = tools.stage();
  const settings = workspaceSettings(tools.workspaceDir);
  const options = {
    rollUp: settings.parentStatus !== "off",
    confirmEarlyStart: settings.confirmEarlyStart !== false,
  };
  // A cycle names a task without an id by its title; the task keeps its line.
  const renamed: Array<[string, string]> = [];
  const ids = args.updates.map((u) => {
    const t = findTask(st.plan, u.id);
    const key = stageTaskUpdate(st, u, tools.today, options);
    if (t && !t.id) {
      const now = st.plan.file(t.file)?.items.find((x) => x.line === t.line);
      if (now && now.title !== t.title) renamed.push([t.title, now.title]);
    }
    return key;
  });
  return { updated: ids, changed: tools.commit(st, { renamed }) };
}

export function moveTask(
  tools: PlannerTools,
  args: { id: string; before?: string; after?: string } & TaskLocation
) {
  const st = tools.stage();
  const plan = st.plan;
  const t = findTask(plan, args.id);
  if (!t || t.kind !== "task")
    throw new ToolError(`Unknown task "${args.id}" (inbox items: use plan_inbox_item).`);
  const places = [args.parent, args.before, args.after].filter((x) => x !== undefined);
  if (places.length > 1) throw new ToolError("Give only one of parent, before and after.");
  // Under a cancelled or done task, or in a cancelled milestone, open work leaves the schedule
  // while its checkbox still looks open: the agent's version of the question the editor asks.
  const refuse = (warning: string | undefined) => {
    if (warning)
      throw new ToolError(
        `Nothing was moved: ${warning} Reopen the task or milestone it would be under, or set ${t.id ?? t.title} to done or cancelled first.`
      );
  };
  // A task without an id is known by its place, which the move changes.
  const moved = (m: MovedTask) => ({
    id: t.id ?? `${m.file}#${m.line + 1}`,
    changed: tools.commit(st),
  });
  if (args.before !== undefined || args.after !== undefined) {
    const ref = (args.before ?? args.after)!;
    const target = findTask(plan, ref);
    if (!target || target.kind !== "task") throw new ToolError(`Unknown task "${ref}".`);
    const r = placeTask(plan, t, target, args.before !== undefined ? "before" : "after");
    if ("reason" in r) throw new ToolError(r.reason);
    refuse(r.warning);
    st.apply(r.edits);
    return moved(r.moved[0]);
  }
  let destFile: string;
  let location: InsertLocation;
  let parent: Task | undefined;
  let milestone: string | undefined;
  if (args.parent) {
    parent = findTask(plan, args.parent);
    if (!parent || parent.kind !== "task") throw new ToolError(`Unknown parent "${args.parent}".`);
    for (let p: Task | undefined = parent; p; p = p.parent)
      if (p === t) throw new ToolError("A task cannot move under itself or its subtasks.");
    destFile = parent.file;
    location = { kind: "child", task: parent };
    milestone = parent.milestoneId;
  } else {
    const m = args.milestone
      ? milestoneOf(plan, args.milestone)
      : plan.milestoneById(t.milestoneId);
    if (!m) throw new ToolError(`Unknown milestone "${args.milestone ?? ""}".`);
    destFile = m.file;
    location = args.section?.trim()
      ? { kind: "section", title: args.section.trim() }
      : { kind: "root" };
    milestone = m.id;
  }
  refuse(leavesSchedule(plan, [t], parent, milestone));
  const r = moveTaskTo(plan.file(t.file)!, t, plan.file(destFile)!, location);
  st.apply(r.edits);
  return moved(r.moved);
}

export function deleteTasks(tools: PlannerTools, args: { ids: string[] }) {
  if (!args.ids?.length) throw new ToolError("No tasks given.");
  const st = tools.stage();
  const unknown = args.ids.filter((id) => !findTask(st.plan, id));
  if (unknown.length) throw new ToolError(`Unknown task(s): ${unknown.join(", ")}.`);
  // Resolve every target before anything moves (keys and inbox positions refer to the plan as it
  // is now), then delete bottom-up per file: removing a block only shifts the lines below it, and
  // removing the dependencies on it edits within lines, so the lines of the rest stay valid.
  const targets = [...new Set(args.ids.map((id) => findTask(st.plan, id)!))]
    .map((t, order) => ({ order, id: t.id, file: t.file, line: t.line, title: t.title }))
    .sort((a, b) => (a.file === b.file ? b.line - a.line : a.file < b.file ? -1 : 1));
  const deleted: Array<{ order: number; name: string }> = [];
  for (const target of targets) {
    const t = st.plan
      .file(target.file)
      ?.items.find((x) => x.line === target.line && x.title === target.title);
    if (!t) continue;
    const edits: FileEdit[] = deleteTaskWithLinks(st.plan, t);
    st.apply(edits);
    deleted.push({ order: target.order, name: target.id ?? target.title });
  }
  deleted.sort((a, b) => a.order - b.order);
  return { deleted: deleted.map((d) => d.name), changed: tools.commit(st) };
}

export function logTime(tools: PlannerTools, args: { id: string; time: string | number }) {
  const st = tools.stage();
  const t = findTask(st.plan, args.id);
  if (!t) throw new ToolError(`Unknown task "${args.id}".`);
  const hours = typeof args.time === "number" ? args.time : parseLoggedTime(String(args.time));
  if (hours === undefined || !(hours > 0))
    throw new ToolError(`Invalid time "${args.time}" (e.g. 1.5, 90m, 1h30m, 1:30).`);
  if (hours > 1000)
    throw new ToolError(`${hours} h in one entry is not plausible; log the time per day or week.`);
  // An @act the planner cannot read (typed by hand as 90m) would be replaced, not added to.
  const act = t.attrs.find((a) => a.key === "act");
  if (act && t.act === undefined)
    throw new ToolError(
      `${args.id} has @act:${act.value}, which is not read as hours; write it as hours first (e.g. @act:1.5h).`
    );
  const file = st.plan.file(t.file)!;
  st.apply({
    path: file.path,
    edits: editTaskLine(file.lines, t, (e) => e.setAttr("act", addActual(t.act, hours))),
  });
  return { id: args.id, logged: hours, changed: tools.commit(st) };
}

/** Adds ids to tasks and punch items without one (all files, or one plan file). */
export function assignIds(tools: PlannerTools, args: { file?: string }) {
  const st = tools.stage();
  const plan = st.plan;
  const files = args.file
    ? [plan.file(args.file)].filter((f) => f !== undefined)
    : plan.files.filter((f) => f.kind === "milestone" || f.kind === "punch");
  if (args.file && files.length === 0) throw new ToolError(`Unknown plan file "${args.file}".`);
  const reserved = new Set<string>();
  const edits: FileEdit[] = files.map((f) => ({
    path: f!.path,
    edits: assignMissingIds(plan, f!, reserved),
  }));
  st.apply(edits);
  // A cycle names a task without an id by its title; the task keeps its line.
  const renamed: Array<[string, string]> = [];
  for (const f of files) {
    const ids = new Map(st.plan.file(f!.path)?.items.map((t) => [t.line, t.id]));
    for (const t of f!.items) {
      const id = ids.get(t.line);
      if (!t.id && id) renamed.push([t.title, id]);
    }
  }
  return { assigned: reserved.size, ids: [...reserved], changed: tools.commit(st, { renamed }) };
}

/** Renames a task id and every dependency on it, in all files. */
export function renameTaskId(tools: PlannerTools, args: { id: string; newId: string }) {
  const st = tools.stage();
  const plan = st.plan;
  const t = plan.taskById(args.id) ?? plan.punchById(args.id);
  if (!t?.id) throw new ToolError(`Unknown task id "${args.id}".`);
  const id = args.newId.trim().replace(/^\^/, "");
  if (!isValidTaskId(id)) throw new ToolError(`"${args.newId}" is not a valid id (e.g. T142).`);
  // As F2: not an id that two tasks share (it would rename both), nor a case variant of another.
  const problem = renameIdProblem(plan, t.id, id);
  if (problem) throw new ToolError(problem);
  st.apply(renameTaskIdEdits(plan, t.id, id));
  return { from: t.id, to: id, changed: tools.commit(st, { renamed: [[t.id, id]] }) };
}
