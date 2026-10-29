// Milestone tools: create milestone files (with sections), change them, add sections, delete a
// milestone together with every dependency on it.
import { formatDate, isValidDate } from "../core/dates";
import { describeScheduleChange } from "../core/drag";
import { type Milestone, type MilestoneStatus } from "../core/model";
import { milestoneStats } from "../core/queries";
import { type Plan } from "../core/resolve";
import {
  appendSectionTo,
  changeMilestone,
  createMilestone,
  deleteMilestoneLinks,
  nextMilestoneId,
  setMilestoneDescription,
  splitMilestoneTitle,
} from "../core/writer/entities";
import { type Staging } from "./staging";
import { type PlannerTools, ToolError } from "./tools";

const STATUSES: MilestoneStatus[] = ["planned", "active", "done", "cancelled"];

export interface MilestoneInput {
  /** M6 …; default: the next free id. */
  id?: string;
  /** Name without the id, e.g. "Documentation". */
  name: string;
  target?: string;
  status?: MilestoneStatus;
  /** Milestone ids or names that must be finished first. */
  depends?: string[];
  description?: string;
  /** `##` sections to create, e.g. units or areas. */
  sections?: string[];
}

export interface MilestoneUpdate {
  /** Milestone id or name. */
  id: string;
  name?: string;
  target?: string;
  status?: MilestoneStatus;
  depends?: string[];
  /** Replaces the free text under the heading; "" removes it. */
  description?: string;
}

/** A milestone from an id or a name (case-insensitive). */
export function milestoneOf(plan: Plan, ref: string): Milestone | undefined {
  const r = ref.trim().toLowerCase();
  return (
    plan.milestoneById(ref.trim()) ??
    plan.milestones.find(
      (m) =>
        m.title.toLowerCase() === r || splitMilestoneTitle(m.id, m.title).name.toLowerCase() === r
    )
  );
}

function checkMilestone(
  m: { target?: string; status?: string; id?: string },
  label: string,
  errors: string[]
): void {
  if (m.target && !isValidDate(m.target))
    errors.push(`${label}: invalid target date "${m.target}" (YYYY-MM-DD).`);
  if (m.status && !STATUSES.includes(m.status as MilestoneStatus))
    errors.push(`${label}: invalid status "${m.status}" (${STATUSES.join(", ")}).`);
  if (m.id !== undefined && !/^[A-Za-z][\w-]*$/.test(m.id))
    errors.push(`${label}: invalid id "${m.id}" (letters, digits and dashes, e.g. M6).`);
}

/**
 * Stages new milestones (files, sections), then their dependencies, which may name milestones of
 * the same call. Returns the ids in order.
 */
export function stageMilestones(st: Staging, inputs: MilestoneInput[]): string[] {
  const errors: string[] = [];
  inputs.forEach((m, i) => {
    if (!m.name?.trim()) errors.push(`Milestone ${i + 1}: a name is needed.`);
    checkMilestone(m, `Milestone ${i + 1} "${m.name ?? ""}"`, errors);
  });
  if (errors.length) throw new ToolError(errors.join("\n"));
  const ids: string[] = [];
  for (const m of inputs) {
    const id = m.id?.trim() || nextMilestoneId(st.plan);
    let file;
    try {
      file = createMilestone(st.plan, {
        id,
        name: m.name.trim(),
        target: m.target,
        status: m.status,
        description: m.description,
      });
    } catch (err) {
      throw new ToolError(err instanceof Error ? err.message : String(err));
    }
    st.create(file.path, file.text);
    for (const title of m.sections ?? []) {
      const f = st.plan.file(file.path)!;
      st.apply(appendSectionTo(f, title));
    }
    ids.push(id);
  }
  inputs.forEach((m, i) => {
    if (!m.depends?.length) return;
    stageMilestoneUpdate(st, { id: ids[i], depends: m.depends });
  });
  return ids;
}

export function stageMilestoneUpdate(st: Staging, u: MilestoneUpdate): string {
  const plan = st.plan;
  const m = milestoneOf(plan, u.id);
  if (!m)
    throw new ToolError(
      `Unknown milestone "${u.id}" (${plan.milestones.map((x) => x.id).join(", ") || "none yet"}).`
    );
  const errors: string[] = [];
  checkMilestone(u, m.id, errors);
  let depends: string[] | undefined;
  if (u.depends) {
    depends = [];
    for (const d of u.depends) {
      const dep = milestoneOf(plan, d);
      if (!dep) errors.push(`${m.id}: unknown milestone "${d}" in depends.`);
      else if (dep.id === m.id) errors.push(`${m.id}: a milestone cannot depend on itself.`);
      else depends.push(dep.id);
    }
  }
  if (errors.length) throw new ToolError(errors.join("\n"));
  const file = plan.file(m.file)!;
  st.apply({
    path: file.path,
    edits: [
      ...changeMilestone(file.lines, m, {
        name: u.name,
        target: u.target,
        status: u.status,
        depends,
      }),
      ...(u.description === undefined ? [] : setMilestoneDescription(file.lines, m, u.description)),
    ],
  });
  return m.id;
}

/** Adds `##` sections that are missing (existing ones are left alone). */
export function stageSections(st: Staging, milestone: string, titles: string[]): string[] {
  const m = milestoneOf(st.plan, milestone);
  if (!m) throw new ToolError(`Unknown milestone "${milestone}".`);
  const added: string[] = [];
  for (const raw of titles) {
    const title = raw.replace(/\s+/g, " ").trim();
    if (!title) continue;
    const current = st.plan.milestoneById(m.id)!;
    if (current.sections.some((s) => s.title.toLowerCase() === title.toLowerCase())) continue;
    st.apply(appendSectionTo(st.plan.file(m.file)!, title));
    added.push(title);
  }
  return added;
}

export function listMilestones(tools: PlannerTools) {
  const plan = tools.load();
  const s = tools.schedule;
  const fmt = (d: number | undefined) => (d === undefined ? undefined : formatDate(d));
  return plan.milestones.map((m) => {
    const ms = s.milestones.get(m.id);
    const st = milestoneStats(m);
    return {
      id: m.id,
      title: m.title,
      file: m.file,
      status: m.status,
      target: m.target,
      depends: m.depends,
      description: m.description.join("\n") || undefined,
      start: fmt(ms?.start),
      forecast: fmt(ms?.forecast),
      late: ms?.late ?? false,
      variance: ms?.variance,
      progress: Math.round(st.progress * 100) / 100,
      tasks: { done: st.done, total: st.total, remainingHours: Math.round(st.remaining * 10) / 10 },
      rootTasks: m.rootTasks.map((t) => t.id ?? t.title),
      sections: m.sections.map((x) => ({
        title: x.title,
        tasks: x.tasks.map((t) => t.id ?? t.title),
      })),
    };
  });
}

export function createMilestones(tools: PlannerTools, args: { milestones: MilestoneInput[] }) {
  if (!args.milestones?.length) throw new ToolError("No milestones given.");
  const st = tools.stage();
  const ids = stageMilestones(st, args.milestones);
  return { created: ids, changed: tools.commit(st) };
}

export function updateMilestone(tools: PlannerTools, args: MilestoneUpdate) {
  const st = tools.stage();
  // A target, a dependency or a status can move other work: the result says what moves.
  const before = tools.scheduleOf(st.plan);
  const id = stageMilestoneUpdate(st, args);
  const after = tools.scheduleOf(st.plan);
  const changed = tools.commit(st);
  const schedule = describeScheduleChange(before, after);
  return { id, changed, ...(schedule ? { schedule } : {}) };
}

export function addSections(tools: PlannerTools, args: { milestone: string; sections: string[] }) {
  const st = tools.stage();
  const added = stageSections(st, args.milestone, args.sections);
  return { added, changed: tools.commit(st) };
}

/**
 * Deletes a milestone file. Other milestones lose it from `depends`, and tasks elsewhere lose
 * their dependencies on its tasks. Refuses while it has open tasks, unless `force`.
 */
export function deleteMilestone(tools: PlannerTools, args: { id: string; force?: boolean }) {
  const st = tools.stage();
  const plan = st.plan;
  const m = milestoneOf(plan, args.id);
  if (!m) throw new ToolError(`Unknown milestone "${args.id}".`);
  const open = m.tasks.filter((t) => !["done", "cancelled"].includes(t.status));
  if (open.length && !args.force)
    throw new ToolError(
      `${m.id} has ${open.length} open task(s). Set its status to cancelled to keep it on record, or delete it with force: true.`
    );
  st.apply(deleteMilestoneLinks(plan, m));
  st.delete(m.file);
  return { deleted: m.id, file: m.file, changed: tools.commit(st) };
}
