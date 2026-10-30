// Writers for creating and editing plan entities from the user interface: task changes from a
// form, deleting a task (and the dependencies on it), new milestone files, people in team.md,
// project properties and inbox items. Like the rest of the writer, every function returns minimal
// text edits (or the text of a file to create).
import {
  type Milestone,
  type MilestoneStatus,
  type ParsedFile,
  type Person,
  type Project,
  type PropertyBlock,
  type Status,
  type Task,
} from "../model";
import { type Plan, personIdFromName } from "../resolve";
import { oneLine, type TextEdit, type TextLines } from "../text";
import {
  addProperty,
  appendSection,
  applyStatus,
  deleteTask,
  deleteLines,
  editTaskLine,
  type FileEdit,
  formatTaskBlock,
  guardNotes,
  insertLines,
  insertTasks,
  type InsertLocation,
  minimalLineEdit,
  type NewTask,
  removeProperty,
  replaceLines,
  setProperty,
} from "./index";

/** A file the caller must create (plan-relative path and full text). */
export interface FileCreation {
  path: string;
  text: string;
}

/** Either edits of existing files or a new file. */
export interface Creation {
  edits?: FileEdit[];
  create?: FileCreation;
}

// ---------------------------------------------------------------------------------------------
// Headings

/** Replaces the text of a Markdown heading, keeping its `#` level (minimal edit). */
export function setHeadingText(lines: TextLines, headingLine: number, text: string): TextEdit[] {
  if (headingLine < 0) return [];
  const current = lines.line(headingLine);
  const m = /^( {0,3}#{1,6}[ \t]+)(.*?)([ \t]*)$/.exec(current);
  if (!m) return [];
  const edit = minimalLineEdit(
    headingLine,
    current,
    m[1] + text.replace(/\s+/g, " ").trim() + m[3]
  );
  return edit ? [edit] : [];
}

// ---------------------------------------------------------------------------------------------
// Tasks

/** Changes to one task, as collected by an edit form. `undefined` attribute values remove them. */
export interface TaskChange {
  title?: string;
  status?: Status;
  /** Reason for the blocked status (written as `@blocked`). */
  blockedReason?: string;
  attrs?: Record<string, string | undefined>;
  addTags?: string[];
  removeTags?: string[];
  /**
   * The day the status was reached, given by the user: `@done` for done, `@started` for in
   * progress or review (work entered afterwards). Replaces the date that is there.
   */
  statusDate?: string;
}

/** Applies a form's changes to a task line as one minimal edit. */
export function changeTask(
  lines: TextLines,
  task: Task,
  change: TaskChange,
  today: string
): TextEdit[] {
  return editTaskLine(lines, task, (e) => {
    if (change.title !== undefined) e.setTitle(change.title.replace(/\s+/g, " ").trim());
    const date = change.statusDate || undefined;
    if (change.status !== undefined && change.status !== task.status)
      applyStatus(e, task, change.status, today, { blockedReason: change.blockedReason, date });
    else if (change.blockedReason !== undefined && task.status === "blocked")
      e.setAttr("blocked", change.blockedReason || undefined);
    // Only the date changes (a done task's day corrected).
    if (date && (change.status === undefined || change.status === task.status)) {
      if (task.status === "done") e.setAttr("done", date);
      if (task.status === "doing" || task.status === "review") e.setAttr("started", date);
    }
    for (const [key, value] of Object.entries(change.attrs ?? {}))
      e.setAttr(key, value === "" ? undefined : value);
    for (const tag of change.removeTags ?? []) e.removeTag(tag.replace(/^#/, ""));
    for (const tag of change.addTags ?? []) e.addTag(tag.replace(/^#/, ""));
  });
}

/** Attributes of a new task in their usual writing order. */
const NEW_TASK_ORDER = ["est", "owner", "dep", "start", "due", "prio", "eq", "test"];

export interface NewTaskFields {
  title: string;
  status?: Status;
  /** Attribute values by key (`est`, `owner`, `dep`, `start`, `due`, `prio` …). */
  attrs?: Record<string, string | undefined>;
  tags?: string[];
  notes?: string[];
}

/** The NewTask for insertTasks(): attributes in the canonical order, `med` priority omitted. */
export function newTaskFrom(fields: NewTaskFields, id?: string): NewTask {
  const attrs = Object.entries(fields.attrs ?? {}).filter(
    (e): e is [string, string] =>
      e[1] !== undefined && e[1] !== "" && !(e[0] === "prio" && e[1] === "med")
  );
  const rank = (k: string) => {
    const i = NEW_TASK_ORDER.indexOf(k);
    return i < 0 ? NEW_TASK_ORDER.length : i;
  };
  attrs.sort((a, b) => rank(a[0]) - rank(b[0]));
  return {
    title: fields.title,
    status: fields.status,
    attrs,
    tags: fields.tags?.map((t) => t.replace(/^#/, "")).filter(Boolean),
    notes: fields.notes?.length ? fields.notes : undefined,
    id,
  };
}

/** Inserts one new task into a milestone file. */
export function addTask(
  file: ParsedFile,
  location: InsertLocation,
  fields: NewTaskFields,
  id: string
): FileEdit {
  return { path: file.path, edits: insertTasks(file, location, [newTaskFrom(fields, id)]) };
}

/** A task and all its subtasks. */
export function taskAndDescendants(task: Task): Task[] {
  return [task, ...task.children.flatMap(taskAndDescendants)];
}

/**
 * The ids (lower case) of the tasks in `going` that no other task keeps: a line copied with its id
 * is a task of its own, so deleting the original leaves the dependencies on that id to the copy.
 */
function goneIds(plan: Plan, going: Set<Task>): Set<string> {
  const kept = new Set(
    plan.tasks.filter((t) => t.id && !going.has(t)).map((t) => t.id!.toLowerCase())
  );
  return new Set(
    [...going].map((t) => t.id?.toLowerCase()).filter((id): id is string => !!id && !kept.has(id))
  );
}

/** Tasks outside `task`'s block that depend on it or one of its subtasks. */
export function dependentsOf(plan: Plan, task: Task): Task[] {
  const block = new Set(taskAndDescendants(task));
  const ids = goneIds(plan, block);
  if (ids.size === 0) return [];
  return plan.tasks.filter((t) => !block.has(t) && t.deps.some((d) => ids.has(d.id.toLowerCase())));
}

/**
 * Deletes a task block (with notes and subtasks) and removes every `@dep` that pointed to it or
 * to one of its subtasks, so no broken dependency is left behind.
 */
export function deleteTaskWithLinks(plan: Plan, task: Task): FileEdit[] {
  const file = plan.file(task.file);
  if (!file) return [];
  const ids = goneIds(plan, new Set(taskAndDescendants(task)));
  const byFile = new Map<string, TextEdit[]>([[task.file, [deleteTask(file.lines, task)]]]);
  for (const t of dependentsOf(plan, task)) {
    const f = plan.file(t.file);
    const attr = t.attrs.find((a) => a.key === "dep");
    if (!f || !attr) continue;
    const kept = attr.value
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p !== "" && !ids.has(p.replace(/\+.*$/, "").toLowerCase()));
    const edits = editTaskLine(f.lines, t, (e) =>
      e.setAttr("dep", kept.length ? kept.join(",") : undefined)
    );
    byFile.set(t.file, [...(byFile.get(t.file) ?? []), ...edits]);
  }
  return [...byFile].map(([path, edits]) => ({ path, edits }));
}

/** What depends on a milestone: tasks of other milestones on its tasks, and other milestones. */
export function milestoneDependents(
  plan: Plan,
  m: Milestone
): { tasks: Task[]; milestones: Milestone[] } {
  const gone = goneIds(plan, new Set(plan.tasks.filter((t) => t.milestoneId === m.id)));
  return {
    tasks: plan.tasks.filter(
      (t) => t.milestoneId !== m.id && t.deps.some((d) => gone.has(d.id.toLowerCase()))
    ),
    milestones: plan.milestones.filter(
      (o) => o.id !== m.id && o.depends.some((d) => d.toLowerCase() === m.id.toLowerCase())
    ),
  };
}

/**
 * Deleting a milestone: removes the dependencies on its tasks (`@dep` elsewhere), and in other
 * milestones' `depends` puts what it waited for in its place (M3 → M2 → M1 without M2: M3 waits
 * for M1, instead of starting with it), so nothing is left pointing at it and the order stays.
 * The caller deletes its file.
 */
export function deleteMilestoneLinks(plan: Plan, m: Milestone): FileEdit[] {
  const gone = goneIds(plan, new Set(plan.tasks.filter((t) => t.milestoneId === m.id)));
  const dependents = milestoneDependents(plan, m);
  const edits: FileEdit[] = [];
  for (const t of dependents.tasks) {
    const keep = t.deps.filter((d) => !gone.has(d.id.toLowerCase())).map((d) => d.raw);
    const f = plan.file(t.file);
    if (!f) continue;
    edits.push({
      path: f.path,
      edits: editTaskLine(f.lines, t, (e) =>
        e.setAttr("dep", keep.length ? keep.join(",") : undefined)
      ),
    });
  }
  for (const other of dependents.milestones) {
    const f = plan.file(other.file);
    if (!f) continue;
    edits.push({
      path: f.path,
      edits: changeMilestone(f.lines, other, { depends: dependsWithout(other, m) }),
    });
  }
  return edits;
}

/** `other`'s `depends` with `m` replaced by what `m` depends on (no duplicates, not itself). */
export function dependsWithout(other: Milestone, m: Milestone): string[] {
  const out: string[] = [];
  const add = (id: string) => {
    const key = id.toLowerCase();
    if (key !== other.id.toLowerCase() && key !== m.id.toLowerCase())
      if (!out.some((x) => x.toLowerCase() === key)) out.push(id);
  };
  for (const d of other.depends)
    if (d.toLowerCase() === m.id.toLowerCase()) m.depends.forEach(add);
    else add(d);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Sections

/** Adds an empty `##` section at the end of a milestone file. */
export function appendSectionTo(file: ParsedFile, title: string): FileEdit {
  return {
    path: file.path,
    edits: [appendSection(file.lines, 2, title.replace(/\s+/g, " ").trim(), [])],
  };
}

/**
 * True when a `##` section has neither tasks nor text (a section that was just added). Sections
 * with free text, such as "## Notes", are not empty.
 */
export function isEmptySection(
  file: ParsedFile,
  sectionLine: number,
  nextHeadingLine: number | undefined
): boolean {
  const end = nextHeadingLine ?? file.lines.lineCount;
  for (let i = sectionLine + 1; i < end; i++) if (file.lines.line(i).trim() !== "") return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Milestones

export interface NewMilestone {
  id: string;
  /** Name without the id, e.g. "Documentation". */
  name: string;
  target?: string;
  status?: MilestoneStatus;
  depends?: string[];
  description?: string;
}

/** The next free milestone id: `M` plus one more than the highest `M<n>` in use. */
export function nextMilestoneId(plan: Plan): string {
  let max = 0;
  for (const m of plan.milestones) {
    const n = /^M(\d+)$/i.exec(m.id);
    if (n) max = Math.max(max, Number(n[1]));
  }
  return `M${max + 1}`;
}

/**
 * The dependency a new milestone starts with: the last milestone of the plan that is not cancelled,
 * so milestones run one after the other unless someone says otherwise.
 */
export function defaultMilestoneDepends(plan: Plan): string[] {
  const last = [...plan.milestones].reverse().find((m) => m.status !== "cancelled");
  return last ? [last.id] : [];
}

/** File name of a new milestone: `milestones/M6-documentation.md`. */
export function milestoneFileName(id: string, name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `milestones/${id}${slug ? `-${slug}` : ""}.md`;
}

/** Splits a milestone heading into the id prefix and the name: "M2 – Backend". */
export function splitMilestoneTitle(id: string, title: string): { prefix: string; name: string } {
  const m = new RegExp(`^(${escapeRegExp(id)}\\s*[–—:-]\\s*)(.*)$`, "i").exec(title.trim());
  return m ? { prefix: m[1], name: m[2] } : { prefix: "", name: title.trim() };
}

/** The heading text for a milestone name, in the plan's `M2 – Name` convention. */
export function milestoneHeading(id: string, name: string, prefix = `${id} – `): string {
  return `${prefix}${name.replace(/\s+/g, " ").trim()}`;
}

export function formatMilestoneFile(m: NewMilestone): string {
  const lines = [`# ${milestoneHeading(m.id, m.name)}`, "", `id: ${m.id}`];
  if (m.target) lines.push(`target: ${oneLine(m.target)}`);
  lines.push(`status: ${m.status ?? "planned"}`);
  if (m.depends?.length) lines.push(`depends: ${oneLine(m.depends.join(", "))}`);
  if (m.description?.trim())
    lines.push("", ...guardNotes(m.description.trim().split(/\r\n|\n|\r/), { headings: true }));
  return lines.join("\n") + "\n";
}

/** The milestone file to create; refuses ids or file names that are already in use. */
export function createMilestone(plan: Plan, m: NewMilestone): FileCreation {
  if (plan.milestoneById(m.id)) throw new Error(`The milestone id ${m.id} is already in use.`);
  const path = milestoneFileName(m.id, m.name);
  if (plan.file(path)) throw new Error(`${path} already exists.`);
  return { path, text: formatMilestoneFile(m) };
}

// ---------------------------------------------------------------------------------------------
// Property blocks (milestones, people, the project)

/**
 * Sets (value) or removes (undefined / "") the first `key:` of a block. Comments after the value
 * are kept when it is set.
 */
export function setOrRemoveProperty(
  lines: TextLines,
  block: PropertyBlock,
  key: string,
  value: string | undefined
): TextEdit[] {
  if (value !== undefined && value.trim() !== "")
    return setProperty(lines, block, key, value.trim());
  const entry = block.entries.find((e) => e.key.toLowerCase() === key.toLowerCase());
  return entry ? [removeProperty(lines, entry)] : [];
}

/** Adds one more `key: value` line to a block (for repeatable keys such as `off:`). */
export function addRepeatedProperty(
  lines: TextLines,
  block: PropertyBlock,
  key: string,
  value: string
): TextEdit {
  return addProperty(lines, block, key, value);
}

/** Removes the `key:` line whose value is `value` (repeatable keys). */
export function removeRepeatedProperty(
  lines: TextLines,
  block: PropertyBlock,
  key: string,
  value: string
): TextEdit[] {
  const entry = block.entries.find(
    (e) => e.key.toLowerCase() === key.toLowerCase() && e.value.trim() === value.trim()
  );
  return entry ? [removeProperty(lines, entry)] : [];
}

/** The items of a comma-separated property value. */
export function listItems(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Changes to a property block, as collected by a form. Single keys: a value sets it, "" removes
 * it, undefined leaves it alone. Repeatable keys (`off`, `capacityFrom`, `overtime`, `workday`) get the full new list.
 */
export interface PropertyChange {
  set?: Record<string, string | undefined>;
  lists?: Record<string, string[] | undefined>;
}

/**
 * Applies a property change as non-overlapping edits: existing lines are edited or removed in
 * place, and every new line is added in one insertion at the end of the block.
 */
export function changeProperties(
  lines: TextLines,
  block: PropertyBlock,
  change: PropertyChange,
  extraLines: string[] = []
): TextEdit[] {
  const edits: TextEdit[] = [];
  const added: string[] = [...extraLines];
  const find = (key: string) =>
    block.entries.filter((e) => e.key.toLowerCase() === key.toLowerCase());
  for (const [key, value] of Object.entries(change.set ?? {})) {
    if (value === undefined) continue;
    const [entry] = find(key);
    if (!entry) {
      if (value.trim()) added.push(`${key}: ${oneLine(value).trim()}`);
    } else if (!value.trim()) edits.push(removeProperty(lines, entry));
    else edits.push(...setProperty(lines, block, key, value.trim()));
  }
  for (const [key, values] of Object.entries(change.lists ?? {})) {
    if (values === undefined) continue;
    const wanted = values.map((v) => oneLine(v).trim()).filter(Boolean);
    const existing = find(key);
    for (const e of existing)
      if (!wanted.includes(e.value.trim())) edits.push(removeProperty(lines, e));
    const have = new Set(existing.map((e) => e.value.trim()));
    for (const v of wanted) if (!have.has(v)) added.push(`${key}: ${v}`);
  }
  if (added.length) edits.push(addProperties(lines, block, added));
  return edits;
}

/** Adds several `key: value` lines at the end of a block in one insertion (see addProperty). */
export function addProperties(lines: TextLines, block: PropertyBlock, entries: string[]): TextEdit {
  if (block.entries.length > 0) return insertLines(lines, block.insertLine, entries);
  const h = block.headingLine;
  if (h < 0) return insertLines(lines, 0, [...entries, ""]);
  const next = h + 1;
  if (next >= lines.lineCount || (next === lines.lineCount - 1 && lines.line(next) === "")) {
    return insertLines(lines, lines.lineCount, ["", ...entries]);
  }
  if (lines.line(next).trim() === "") {
    const after = next + 1 < lines.lineCount && lines.line(next + 1).trim() !== "";
    return insertLines(lines, next + 1, after ? [...entries, ""] : entries);
  }
  return insertLines(lines, next, ["", ...entries, ""]);
}

export interface MilestoneChange {
  /** New name (without the id prefix). */
  name?: string;
  target?: string;
  status?: string;
  depends?: string[];
}

/** Last line of a heading's section: up to the next heading of the same or a higher level. */
function sectionEnd(lines: TextLines, headingLine: number): number {
  const heading = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
  const level = heading.exec(lines.line(headingLine))?.[1].length ?? 1;
  let fence: string | undefined;
  for (let i = headingLine + 1; i < lines.lineCount; i++) {
    const text = lines.line(i);
    const marker = /^[ \t]*(`{3,}|~{3,})/.exec(text)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (marker) fence = marker;
    else {
      const h = heading.exec(text);
      if (h && h[1].length <= level) return i - 1;
    }
  }
  return lines.lineCount - 1;
}

/**
 * Replaces a milestone's description: the free text under its heading and properties, up to its
 * first task or heading ("" removes it). Text further down the file is left alone.
 */
export function setMilestoneDescription(lines: TextLines, m: Milestone, text: string): TextEdit[] {
  const start = m.props.insertLine;
  const stop = Math.min(m.tasks[0]?.line ?? lines.lineCount, lines.lineCount);
  let end = start;
  while (end < stop && !/^ {0,3}#{1,6}(?:[ \t]|$)/.test(lines.line(end))) end++;
  const current: number[] = [];
  for (let i = start; i < end; i++) if (lines.line(i).trim() !== "") current.push(i);
  const lines0 = text.split(/\r\n|\n|\r/).map((l) => l.trimEnd());
  while (lines0.length && !lines0[0]) lines0.shift();
  while (lines0.length && !lines0[lines0.length - 1]) lines0.pop();
  // Text, not structure: a `- [ ]` line, a heading or an open code fence would change the plan.
  const body = guardNotes(lines0, { headings: true });
  const blank = (line: number) => line >= lines.lineCount || lines.line(line).trim() === "";
  if (!current.length) {
    if (!body.length) return [];
    return [insertLines(lines, start, ["", ...body, ...(blank(start) ? [] : [""])])];
  }
  const from = current[0];
  const to = current[current.length - 1];
  if (body.length) return replaceLines(lines, from, to, body);
  // Removed: also one of the blank lines around it.
  const extra = blank(from - 1) && to + 1 < lines.lineCount && blank(to + 1) ? 1 : 0;
  return [deleteLines(lines, from, to + extra)];
}

/** Edits a milestone's heading and properties. */
export function changeMilestone(
  lines: TextLines,
  m: Milestone,
  change: MilestoneChange
): TextEdit[] {
  const edits: TextEdit[] = [];
  if (change.name !== undefined && change.name.trim()) {
    const { prefix, name } = splitMilestoneTitle(m.id, m.title);
    if (change.name.trim() !== name)
      edits.push(
        ...setHeadingText(lines, m.headingLine, milestoneHeading(m.id, change.name, prefix))
      );
  }
  edits.push(
    ...changeProperties(lines, m.props, {
      set: {
        target: change.target,
        status: change.status,
        depends: change.depends === undefined ? undefined : change.depends.join(", "),
      },
    })
  );
  return edits;
}

export interface ProjectChange {
  name?: string;
  code?: string;
  start?: string;
  end?: string;
  workweek?: string;
  hoursPerDay?: string;
  /** Hours budget, e.g. `1200h` ("" removes it). */
  budget?: string;
  holidays?: string[];
}

/** Edits project.md: the heading and the property block (holidays as one comma list). */
export function changeProject(
  lines: TextLines,
  project: Project,
  change: ProjectChange
): TextEdit[] {
  const edits: TextEdit[] = [];
  const heading = project.props.headingLine;
  if (change.name !== undefined && change.name.trim() && change.name.trim() !== project.name)
    edits.push(...setHeadingText(lines, heading, change.name));
  edits.push(
    ...changeProperties(lines, project.props, {
      set: {
        code: change.code,
        start: change.start,
        end: change.end,
        workweek: change.workweek,
        hoursPerDay: change.hoursPerDay,
        budget: change.budget,
        holidays: change.holidays === undefined ? undefined : change.holidays.join(", "),
      },
    })
  );
  return edits;
}

// ---------------------------------------------------------------------------------------------
// People (team.md)

export const PERSON_COLORS = ["blue", "green", "purple", "orange", "yellow", "red"] as const;

export interface PersonFields {
  name: string;
  /** Person id; defaults to the name in lower case with dashes. */
  id?: string;
  role?: string;
  capacity?: string;
  workweek?: string;
  skills?: string[];
  color?: string;
  off?: string[];
  capacityFrom?: string[];
  /** `overtime:` values such as `2026-11-02..2026-11-27 +8h/week`. */
  overtime?: string[];
  /** `workday:` values such as `2026-11-07 6h`. */
  workday?: string[];
}

/** The `##` section of a new person, with an explicit `id:` so renaming them later is safe. */
export function formatPersonSection(p: PersonFields): string[] {
  const prop = (key: string, value: string) => `${key}: ${oneLine(value).trim()}`;
  const body = [prop("id", p.id || personIdFromName(p.name))];
  if (p.role) body.push(prop("role", p.role));
  if (p.capacity) body.push(prop("capacity", p.capacity));
  for (const c of p.capacityFrom ?? []) body.push(prop("capacityFrom", c));
  if (p.workweek) body.push(prop("workweek", p.workweek));
  if (p.skills?.length) body.push(prop("skills", p.skills.join(", ")));
  if (p.color) body.push(prop("color", p.color));
  for (const o of p.off ?? []) body.push(prop("off", o));
  for (const o of p.overtime ?? []) body.push(prop("overtime", o));
  for (const w of p.workday ?? []) body.push(prop("workday", w));
  return [`## ${oneLine(p.name).trim()}`, "", ...body];
}

/** Adds a person to team.md (creating the file when needed). */
export function addPerson(plan: Plan, p: PersonFields): Creation {
  const id = (p.id || personIdFromName(p.name)).toLowerCase();
  if (plan.personById(id)) throw new Error(`The person id "${id}" is already in use.`);
  const section = formatPersonSection({ ...p, id });
  const team = plan.file("team.md");
  if (!team)
    return { create: { path: "team.md", text: ["# Team", "", ...section, ""].join("\n") } };
  return {
    edits: [
      {
        path: team.path,
        edits: [appendSection(team.lines, 2, section[0].slice(3), section.slice(2))],
      },
    ],
  };
}

export interface PersonChange {
  name?: string;
  role?: string;
  capacity?: string;
  workweek?: string;
  skills?: string[];
  color?: string;
  off?: string[];
  capacityFrom?: string[];
  overtime?: string[];
  workday?: string[];
}

/** Edits a person: heading (keeping their id) and properties, as non-overlapping edits. */
export function changePerson(lines: TextLines, person: Person, change: PersonChange): TextEdit[] {
  const edits: TextEdit[] = [];
  const extra: string[] = [];
  if (change.name !== undefined && change.name.trim() && change.name.trim() !== person.name) {
    edits.push(...setHeadingText(lines, person.headingLine, change.name));
    if (needsIdLine(person, change.name)) {
      // First in the block (as new people are written); with no block, as the first added line.
      const first = person.props.entries[0];
      if (first) edits.push(insertLines(lines, first.line, [`id: ${person.id}`]));
      else extra.push(`id: ${person.id}`);
    }
  }
  edits.push(
    ...changeProperties(
      lines,
      person.props,
      {
        set: {
          role: change.role,
          capacity: change.capacity,
          workweek: change.workweek,
          skills: change.skills === undefined ? undefined : change.skills.join(", "),
          color: change.color,
        },
        lists: {
          off: change.off,
          capacityFrom: change.capacityFrom,
          overtime: change.overtime,
          workday: change.workday,
        },
      },
      extra
    )
  );
  return edits;
}

/**
 * Removes a person's `##` section from team.md. Their tasks, punch and inbox items get `@owner` of
 * `reassignTo`, or lose `@owner` (they then run in the Unassigned pool, or inherit their parent's
 * owner) when it is undefined.
 */
export function removePerson(plan: Plan, person: Person, reassignTo?: string): FileEdit[] {
  const file = plan.file(person.file);
  if (!file) return [];
  const to = sectionEnd(file.lines, person.headingLine);
  const out: FileEdit[] = [
    { path: file.path, edits: [deleteLines(file.lines, person.headingLine, to)] },
  ];
  const owned = [...plan.tasks, ...plan.punch, ...plan.inbox].filter(
    (t) => t.owner?.toLowerCase() === person.id.toLowerCase()
  );
  const byFile = new Map<string, TextEdit[]>();
  for (const t of owned) {
    const f = plan.file(t.file);
    if (!f) continue;
    byFile.set(t.file, [
      ...(byFile.get(t.file) ?? []),
      ...editTaskLine(f.lines, t, (e) => e.setAttr("owner", reassignTo)),
    ]);
  }
  for (const [path, edits] of byFile) {
    const existing = out.find((x) => x.path === path);
    if (existing) existing.edits.push(...edits);
    else out.push({ path, edits });
  }
  return out;
}

/**
 * Renames a person. When the id came from the name (no `id:` line), an `id:` with the old id is
 * added, so that `@owner` references keep working.
 */
export function renamePerson(lines: TextLines, person: Person, name: string): TextEdit[] {
  const edits = setHeadingText(lines, person.headingLine, name);
  if (edits.length === 0) return [];
  if (needsIdLine(person, name)) {
    const first = person.props.entries[0];
    edits.push(
      first
        ? insertLines(lines, first.line, [`id: ${person.id}`])
        : addProperty(lines, person.props, "id", person.id)
    );
  }
  return edits;
}

/** True when renaming would change a person's id because it came from the name. */
function needsIdLine(person: Person, name: string): boolean {
  const hasId = person.props.entries.some((e) => e.key.toLowerCase() === "id");
  return !hasId && personIdFromName(name) !== person.id.toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// Inbox

/** Adds a line to inbox.md (creating the file when needed). The text may contain #tags. */
export function captureInbox(plan: Plan, text: string): Creation {
  const task: NewTask = { title: text };
  const inbox = plan.file("inbox.md");
  if (!inbox)
    return {
      create: { path: "inbox.md", text: ["# Inbox", "", ...formatTaskBlock(task), ""].join("\n") },
    };
  return { edits: [{ path: inbox.path, edits: insertTasks(inbox, { kind: "end" }, [task]) }] };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
