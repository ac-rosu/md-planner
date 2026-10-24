// Minimal-diff writer. Every operation returns text edits that touch only what changes; nothing is
// re-rendered. The extension turns these into a WorkspaceEdit; the MCP server and CLI apply them to
// the file text with applyEdits().
import {
  type PropertyBlock,
  type PropertyEntry,
  type ParsedFile,
  type Status,
  STATUS_CHAR,
  type Task,
} from "../model";
import { parseFileAs } from "../parser/files";
import { formatAttr } from "../parser/taskLine";
import { type Plan } from "../resolve";
import { hasLoggedWork } from "../rollup";
import { pos, range, type TextEdit, type TextLines } from "../text";
import { minimalLineEdit, TaskLineEditor } from "./lineEditor";

export { TaskLineEditor, minimalLineEdit } from "./lineEditor";

export interface FileEdit {
  path: string;
  edits: TextEdit[];
}

/** Applies `fn` to the task's line and returns the resulting minimal edit (if anything changed). */
export function editTaskLine(
  lines: TextLines,
  task: Task,
  fn: (e: TaskLineEditor) => void
): TextEdit[] {
  const editor = new TaskLineEditor(lines.line(task.line));
  fn(editor);
  const edit = editor.toEdit(task.line);
  return edit ? [edit] : [];
}

export interface StatusOptions {
  /** Reason written as `@blocked:"…"` when the new status is blocked. */
  blockedReason?: string;
}

/**
 * Changes the checkbox and maintains the automatic dates: `@started` is added when work starts
 * (and removed when the task goes back to to do with no time logged), `@done` when the task is
 * completed (and removed again when it is reopened); `@blocked` is removed when a blocked task is
 * unblocked.
 */
export function setStatus(
  lines: TextLines,
  task: Task,
  status: Status,
  today: string,
  options: StatusOptions = {}
): TextEdit[] {
  return editTaskLine(lines, task, (e) => applyStatus(e, task, status, today, options));
}

/** The status change of setStatus() on a line editor, so it can be combined with other edits. */
export function applyStatus(
  e: TaskLineEditor,
  task: Task,
  status: Status,
  today: string,
  options: StatusOptions = {}
): void {
  e.setStatusChar(STATUS_CHAR[status]);
  if (task.kind === "step") return;
  if ((status === "doing" || status === "review") && !e.hasAttr("started"))
    e.setAttr("started", today);
  if (status === "todo" && e.hasAttr("started") && !hasLoggedWork(task))
    e.setAttr("started", undefined);
  if (status === "done" && !e.hasAttr("done")) e.setAttr("done", today);
  if (status !== "done" && e.hasAttr("done") && status !== "cancelled")
    e.setAttr("done", undefined);
  if (status === "blocked" && options.blockedReason !== undefined)
    e.setAttr("blocked", options.blockedReason);
  if (status !== "blocked" && e.hasAttr("blocked")) e.setAttr("blocked", undefined);
}

/** The status dates a new item with this status gets (as applyStatus would write them). */
export function statusDateAttrs(
  status: Status | undefined,
  today: string
): Array<[string, string]> {
  if (status === "doing" || status === "review") return [["started", today]];
  if (status === "done") return [["done", today]];
  return [];
}

/** The status that a click on the checkbox moves to: todo → doing → review → done → todo. */
export function nextStatus(status: Status): Status {
  switch (status) {
    case "todo":
      return "doing";
    case "doing":
      return "review";
    case "review":
      return "done";
    case "blocked":
      return "doing";
    case "done":
    case "cancelled":
      return "todo";
  }
}

export function setAttr(
  lines: TextLines,
  task: Task,
  key: string,
  value: string | undefined
): TextEdit[] {
  return editTaskLine(lines, task, (e) => e.setAttr(key, value));
}

export function setTitle(lines: TextLines, task: Task, title: string): TextEdit[] {
  return editTaskLine(lines, task, (e) => e.setTitle(title.replace(/\s+/g, " ").trim()));
}

export function addTag(lines: TextLines, task: Task, tag: string): TextEdit[] {
  return editTaskLine(lines, task, (e) => e.addTag(tag.replace(/^#/, "")));
}

export function removeTag(lines: TextLines, task: Task, tag: string): TextEdit[] {
  return editTaskLine(lines, task, (e) => e.removeTag(tag.replace(/^#/, "")));
}

export function setId(lines: TextLines, task: Task, id: string): TextEdit[] {
  return editTaskLine(lines, task, (e) => e.setId(id));
}

// ---------------------------------------------------------------------------------------------
// Line insertion / deletion

/** Inserts whole lines before `beforeLine` (or appends when it is past the end). */
export function insertLines(lines: TextLines, beforeLine: number, texts: string[]): TextEdit {
  const eol = lines.eol;
  const last = lines.lineCount - 1;
  // Before an existing line, or before the empty remainder after a final line ending.
  if (beforeLine <= last || lines.line(last) === "") {
    const at = Math.min(beforeLine, last);
    return { range: range(at, 0, 0), newText: texts.join(eol) + eol };
  }
  // The file does not end with a line ending: keep it that way.
  const end = lines.line(last).length;
  return { range: range(last, end, end), newText: eol + texts.join(eol) };
}

/**
 * Replaces lines `from`..`to` (inclusive) with `texts`. Leading and trailing lines that stay the
 * same are left alone, so appending a line only inserts that line.
 */
export function replaceLines(
  lines: TextLines,
  from: number,
  to: number,
  texts: string[]
): TextEdit[] {
  let a = from;
  let b = to;
  let i = 0;
  let j = texts.length - 1;
  for (; a <= b && i <= j && lines.line(a) === texts[i]; a++) i++;
  for (; a <= b && i <= j && lines.line(b) === texts[j]; b--) j--;
  const middle = texts.slice(i, j + 1);
  if (a > b) return middle.length ? [insertLines(lines, a, middle)] : [];
  if (!middle.length) return [deleteLines(lines, a, b)];
  return [{ range: { start: pos(a, 0), end: lines.lineEnd(b) }, newText: middle.join(lines.eol) }];
}

/** Deletes lines `from`..`to` (inclusive), including their line endings. */
export function deleteLines(lines: TextLines, from: number, to: number): TextEdit {
  if (to + 1 < lines.lineCount) {
    return { range: { start: pos(from, 0), end: pos(to + 1, 0) }, newText: "" };
  }
  if (from === 0) {
    return { range: { start: pos(0, 0), end: lines.lineEnd(to) }, newText: "" };
  }
  return { range: { start: lines.lineEnd(from - 1), end: lines.lineEnd(to) }, newText: "" };
}

// ---------------------------------------------------------------------------------------------
// New tasks

export interface NewTask {
  title: string;
  status?: Status;
  /** Attributes in writing order, e.g. [["est", "4h"], ["owner", "mark"]]. */
  attrs?: Array<[string, string]>;
  tags?: string[];
  id?: string;
  notes?: string[];
  children?: NewTask[];
}

export function formatTaskLine(t: NewTask, indent: string, marker = "-"): string {
  const parts = [`${indent}${marker} [${STATUS_CHAR[t.status ?? "todo"]}]`];
  if (t.title) parts.push(t.title.replace(/\s+/g, " ").trim());
  for (const [k, v] of t.attrs ?? []) parts.push(formatAttr(k, v));
  for (const tag of t.tags ?? []) parts.push(`#${tag.replace(/^#/, "")}`);
  if (t.id) parts.push(`^${t.id}`);
  return parts.join(" ");
}

/** Formats a task with its notes and children as Markdown lines. */
export function formatTaskBlock(t: NewTask, indent = "", marker = "-"): string[] {
  const out = [formatTaskLine(t, indent, marker)];
  const contentIndent = indent + " ".repeat(marker.length + 5);
  for (const note of t.notes ?? []) out.push(note === "" ? "" : contentIndent + note);
  for (const c of t.children ?? []) out.push(...formatTaskBlock(c, indent + "  ", marker));
  return out;
}

export type InsertLocation =
  /** After the last top-level item of the file. */
  | { kind: "end" }
  /** At the end of a `##` section (created at the end of the file when missing). */
  | { kind: "section"; title: string }
  /** Top level, outside any `##` section (after the description, before the first section). */
  | { kind: "root" }
  | { kind: "after"; task: Task }
  | { kind: "child"; task: Task };

/** Inserts formatted task blocks into a file at the given location. */
export function insertTasks(
  file: ParsedFile,
  location: InsertLocation,
  tasks: NewTask[]
): TextEdit[] {
  if (tasks.length === 0) return [];
  return [
    insertionEdit(file, location, (indent, marker) =>
      tasks.flatMap((n) => formatTaskBlock(n, indent, marker))
    ),
  ];
}

/** Indentation and list marker that items get at a location. */
function locationIndent(location: InsertLocation): { indent: string; marker: string } {
  if (location.kind === "child") {
    const t = location.task;
    return {
      indent: t.children[0]?.indentText ?? t.indentText + "  ",
      marker: t.children[0]?.marker ?? t.marker,
    };
  }
  if (location.kind === "after")
    return { indent: location.task.indentText, marker: location.task.marker };
  return { indent: "", marker: "-" };
}

function insertionEdit(
  file: ParsedFile,
  location: InsertLocation,
  body: (indent: string, marker: string) => string[]
): TextEdit {
  const lines = file.lines;
  const { indent, marker } = locationIndent(location);
  const text = body(indent, marker);
  switch (location.kind) {
    case "after":
    case "child":
      return insertLines(lines, location.task.endLine + 1, text);
    case "section": {
      const headings = headingLines(lines);
      const h = headings.find(
        (x) => x.level === 2 && x.text.toLowerCase() === location.title.trim().toLowerCase()
      );
      if (!h) return appendBlock(lines, [`## ${location.title.trim()}`, "", ...text]);
      const next = headings.find((x) => x.line > h.line && x.level <= 2);
      return insertIntoRegion(file, h.line, next ? next.line : lines.lineCount, text);
    }
    case "root": {
      const headings = headingLines(lines);
      const firstSection = headings.find((x) => x.level === 2);
      const rootItems = file.roots.filter((t) => t.sectionLine === undefined);
      const last = rootItems[rootItems.length - 1];
      if (last) return insertLines(lines, last.endLine + 1, text);
      if (!firstSection) return appendBlock(lines, text);
      return insertIntoRegion(file, Math.max(file.headingLine, -1), firstSection.line, text, true);
    }
    case "end": {
      const lastItem = file.roots[file.roots.length - 1];
      return lastItem ? insertLines(lines, lastItem.endLine + 1, text) : appendBlock(lines, text);
    }
  }
}

/** Inserts list lines at the end of a region (heading line .. end exclusive). */
function insertIntoRegion(
  file: ParsedFile,
  headingLine: number,
  end: number,
  body: string[],
  beforeHeading = false
): TextEdit {
  const lines = file.lines;
  let last = end - 1;
  while (last > headingLine && lines.line(last).trim() === "") last--;
  if (last === headingLine) {
    // Empty section: keep blank lines between the heading, the list and whatever follows. The
    // empty remainder after a final EOL is not a blank line.
    const contentAt = (n: number) => n < lines.lineCount && lines.line(n).trim() !== "";
    const lineCount =
      lines.line(lines.lineCount - 1) === "" ? lines.lineCount - 1 : lines.lineCount;
    const blankFollows = headingLine + 1 < lineCount && !contentAt(headingLine + 1);
    const at = blankFollows ? headingLine + 2 : headingLine + 1;
    const lead = blankFollows ? [] : [""];
    const trail = contentAt(at) ? [""] : [];
    return insertLines(lines, at, [...lead, ...body, ...trail]);
  }
  const isItemLine = file.items.some((t) => t.line <= last && t.endLine >= last);
  // When inserting just before a heading, keep a blank line between the list and the heading.
  const trail = beforeHeading && last + 1 === end ? [""] : [];
  return insertLines(lines, last + 1, [...(isItemLine ? [] : [""]), ...body, ...trail]);
}

/** Appends lines at the end of the file, separated from existing content by one blank line. */
export function appendBlock(lines: TextLines, body: string[]): TextEdit {
  let last = lines.lineCount - 1;
  while (last >= 0 && lines.line(last).trim() === "") last--;
  if (last < 0) {
    // Empty (or whitespace-only) file.
    return {
      range: { start: pos(0, 0), end: lines.lineEnd(lines.lineCount - 1) },
      newText: body.join(lines.eol) + lines.eol,
    };
  }
  // Blank lines after the last content line; the empty remainder after a final EOL is not one.
  const endsWithEol = lines.line(lines.lineCount - 1) === "";
  const blankLinesAfter = lines.lineCount - 1 - last - (endsWithEol ? 1 : 0);
  const lead = blankLinesAfter > 0 ? [] : [""];
  return insertLines(lines, lines.lineCount, [...lead, ...body]);
}

/** Appends a `##` (or other level) section with body lines at the end of the file. */
export function appendSection(
  lines: TextLines,
  level: number,
  title: string,
  body: string[]
): TextEdit {
  return appendBlock(lines, [
    `${"#".repeat(level)} ${title}`,
    ...(body.length ? ["", ...body] : []),
  ]);
}

interface HeadingLine {
  level: number;
  text: string;
  line: number;
}

function headingLines(lines: TextLines): HeadingLine[] {
  const out: HeadingLine[] = [];
  let fence: string | undefined;
  for (let i = 0; i < lines.lineCount; i++) {
    const text = lines.line(i);
    const f = /^[ \t]*(`{3,}|~{3,})/.exec(text);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    const m = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(text);
    if (m) out.push({ level: m[1].length, text: m[2].trim(), line: i });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Moving and deleting task blocks

/** The raw lines of a task block (task line, notes and nested items). */
export function blockLines(lines: TextLines, task: Task): string[] {
  const out: string[] = [];
  for (let i = task.line; i <= task.endLine; i++) out.push(lines.line(i));
  return out;
}

/** Re-indents a block so that its first line starts with `indent`. */
export function reindent(block: string[], fromIndent: string, indent: string): string[] {
  return block.map((l) => {
    if (l.trim() === "") return "";
    if (l.startsWith(fromIndent)) return indent + l.slice(fromIndent.length);
    return indent + l.replace(/^[ \t]+/, "");
  });
}

export function deleteTask(lines: TextLines, task: Task): TextEdit {
  return deleteLines(lines, task.line, task.endLine);
}

/**
 * Moves a task block (with notes and subtasks) to another location, possibly in another file.
 * `transform` can rewrite the first line (e.g. to assign an id) before it is inserted.
 */
export function moveTask(
  source: ParsedFile,
  task: Task,
  target: ParsedFile,
  location: InsertLocation,
  transform?: (firstLine: string) => string
): FileEdit[] {
  const block = blockLines(source.lines, task);
  const insert = insertionEdit(target, location, (indent) => {
    const moved = reindent(block, task.indentText, indent);
    if (transform) moved[0] = transform(moved[0]);
    return moved;
  });
  const del = deleteTask(source.lines, task);
  if (source.path === target.path) return [{ path: source.path, edits: [del, insert] }];
  return [
    { path: source.path, edits: [del] },
    { path: target.path, edits: [insert] },
  ];
}

// ---------------------------------------------------------------------------------------------
// Ids

const ID_NUMBER = /^([A-Za-z]+)(\d+)$/;

/** All ids in use across tasks, punch items and inbox items. */
export function allIds(plan: Plan): Set<string> {
  const ids = new Set<string>();
  for (const t of [...plan.tasks, ...plan.punch, ...plan.inbox]) if (t.id) ids.add(t.id);
  return ids;
}

/** Generates `count` fresh ids with a prefix (`T` for tasks, `P` for punch items). */
export function nextIds(
  plan: Plan,
  prefix: string,
  count: number,
  reserved: Set<string> = new Set()
): string[] {
  let max = 0;
  let width = prefix === "P" ? 3 : 1;
  for (const id of [...allIds(plan), ...reserved]) {
    const m = ID_NUMBER.exec(id);
    if (m && m[1].toUpperCase() === prefix.toUpperCase()) {
      max = Math.max(max, Number(m[2]));
      width = Math.max(width, m[2].length);
    }
  }
  const out: string[] = [];
  for (let i = 1; i <= count; i++) out.push(prefix + String(max + i).padStart(width, "0"));
  return out;
}

export function nextId(plan: Plan, prefix = "T"): string {
  return nextIds(plan, prefix, 1)[0];
}

/**
 * Assigns ids to every item in the file that has none. Tasks get `T…`, punch items `P…`. Ids in
 * `reserved` are avoided and the new ones are added to it (for multi-file assignment).
 */
export function assignMissingIds(
  plan: Plan,
  file: ParsedFile,
  reserved: Set<string> = new Set()
): TextEdit[] {
  if (file.kind !== "milestone" && file.kind !== "punch") return [];
  const prefix = file.kind === "punch" ? "P" : "T";
  const missing = file.items.filter((t) => !t.id);
  const ids = nextIds(plan, prefix, missing.length, reserved);
  for (const id of ids) reserved.add(id);
  return missing.flatMap((t, i) => setId(file.lines, t, ids[i]));
}

/**
 * Gives fresh ids to tasks that were copied with their id and then made into another task: a
 * duplicated or pasted line keeps its `^T12`, and once its title differs from every other task
 * with that id it is clearly a new task. Only occurrences beyond those in the file's saved text
 * count as copies (saved ones keep their id: unchanged titles first, then in file order). A copy
 * with the same title is left alone: it may be a task being moved (pasted here, to be deleted
 * there), and the duplicate-id quick fix handles it. Ids in `reserved` are avoided and the new ones
 * are added to it.
 */
export function renumberCopiedIds(
  plan: Plan,
  file: ParsedFile,
  savedText: string | undefined,
  reserved: Set<string> = new Set()
): TextEdit[] {
  if (file.kind !== "milestone" && file.kind !== "punch") return [];
  const users = new Map<string, Task[]>();
  for (const t of [...plan.tasks, ...plan.punch, ...plan.inbox])
    if (t.id) users.set(t.id, [...(users.get(t.id) ?? []), t]);
  const saved = savedText === undefined ? undefined : parseFileAs(file.path, savedText, file.kind);
  const savedTitles = new Map<string, string[]>();
  for (const t of saved?.items ?? [])
    if (t.id) savedTitles.set(t.id, [...(savedTitles.get(t.id) ?? []), t.title]);
  const byId = new Map<string, Task[]>();
  for (const t of file.items)
    if (t.id && (users.get(t.id)?.length ?? 0) > 1) byId.set(t.id, [...(byId.get(t.id) ?? []), t]);

  const copies: Task[] = [];
  for (const [id, items] of byId) {
    const titles = [...(savedTitles.get(id) ?? [])];
    const unmatched: Task[] = [];
    for (const t of items) {
      const i = titles.indexOf(t.title);
      if (i >= 0) titles.splice(i, 1);
      else unmatched.push(t);
    }
    // Saved occurrences whose title was edited since keep their id in file order.
    for (const t of unmatched.slice(titles.length)) {
      const others = users.get(id)!.filter((u) => u !== t);
      if (others.every((u) => u.title !== t.title)) copies.push(t);
    }
  }
  copies.sort((a, b) => a.line - b.line);
  const ids = nextIds(plan, file.kind === "punch" ? "P" : "T", copies.length, reserved);
  for (const id of ids) reserved.add(id);
  return copies.flatMap((t, i) => setId(file.lines, t, ids[i]));
}

/** Renames a task id and every `@dep` reference to it, across all files. */
export function renameTaskId(plan: Plan, oldId: string, newId: string): FileEdit[] {
  const byFile = new Map<string, TextEdit[]>();
  const add = (path: string, edits: TextEdit[]) => {
    if (edits.length === 0) return;
    byFile.set(path, [...(byFile.get(path) ?? []), ...edits]);
  };
  for (const t of [...plan.tasks, ...plan.inbox, ...plan.punch]) {
    const file = plan.file(t.file);
    if (!file) continue;
    const renameSelf = t.id === oldId;
    const depAttr = t.attrs.find((a) => a.key === "dep");
    const depValue = depAttr ? renameInDepList(depAttr.value, oldId, newId) : undefined;
    const depChanged = depAttr !== undefined && depValue !== depAttr.value;
    if (!renameSelf && !depChanged) continue;
    add(
      t.file,
      editTaskLine(file.lines, t, (e) => {
        if (renameSelf) e.setId(newId);
        if (depChanged) e.setAttr("dep", depValue);
      })
    );
  }
  return [...byFile].map(([path, edits]) => ({ path, edits }));
}

export function renameInDepList(value: string, oldId: string, newId: string): string {
  return value
    .split(",")
    .map((part) => {
      const m = /^(\s*)([A-Za-z][\w-]*?)(\+.*)?(\s*)$/.exec(part);
      if (!m || m[2] !== oldId) return part;
      return `${m[1]}${newId}${m[3] ?? ""}${m[4]}`;
    })
    .join(",");
}

/**
 * A task's notes as written, without their common indentation: nested lists and code keep their
 * relative indentation, and blank lines between paragraphs are kept as "".
 */
export function readNotes(lines: TextLines, task: Task): string[] {
  const texts: string[] = [];
  for (const r of noteRuns(lines, task))
    for (let i = r.from; i <= r.to; i++) texts.push(lines.line(i));
  return dedent(texts).lines;
}

/**
 * Replaces a task's notes (its description lines) with `notes`; an empty list removes them. Lines
 * keep their indentation relative to each other (as `readNotes` gives them), under the notes'
 * current indentation; lines that stay the same are left alone.
 */
export function setNotes(lines: TextLines, task: Task, notes: string[]): TextEdit[] {
  const runs = noteRuns(lines, task);
  const current: string[] = [];
  for (const r of runs) for (let i = r.from; i <= r.to; i++) current.push(lines.line(i));
  const indent = runs.length
    ? dedent(current).indent
    : task.indentText + " ".repeat(task.marker.length + 5);
  const body = noteLines(notes).map((n) => (n ? indent + n : ""));
  // The run under the task line is replaced; runs after subtasks are removed. One edit per run, so
  // edits never overlap (also at the end of a file without a final line ending).
  const lead = runs[0] && runs[0].from < (task.children[0]?.line ?? Infinity) ? runs[0] : undefined;
  const edits = runs.filter((r) => r !== lead).map((r) => deleteLines(lines, r.from, r.to));
  if (lead) edits.push(...replaceLines(lines, lead.from, lead.to, body));
  else if (body.length) edits.push(insertLines(lines, task.line + 1, body));
  return edits;
}

/**
 * Note text as lines to write under a task: split at line endings, blank lines around it dropped,
 * the indentation all lines share removed (the rest is kept: nested lists, code).
 */
export function noteLines(notes: string[]): string[] {
  const given = notes.flatMap((n) => n.split(/\r\n|\n|\r/));
  while (given.length && !given[0].trim()) given.shift();
  while (given.length && !given[given.length - 1].trim()) given.pop();
  return dedent(given).lines;
}

/** A task's note lines in runs: consecutive notes with only blank lines between them. */
function noteRuns(lines: TextLines, task: Task): Array<{ from: number; to: number }> {
  const runs: Array<{ from: number; to: number }> = [];
  for (const n of task.notes) {
    const last = runs[runs.length - 1];
    let joined = last !== undefined;
    for (let i = (last?.to ?? n.line) + 1; joined && i < n.line; i++)
      if (lines.line(i).trim() !== "") joined = false;
    if (joined) last!.to = n.line;
    else runs.push({ from: n.line, to: n.line });
  }
  return runs;
}

/** Removes the leading whitespace all non-blank lines share; blank lines become "". */
function dedent(texts: string[]): { indent: string; lines: string[] } {
  let indent: string | undefined;
  for (const t of texts) {
    if (!t.trim()) continue;
    const own = /^[ \t]*/.exec(t)![0];
    let i = 0;
    while (indent !== undefined && i < indent.length && indent[i] === own[i]) i++;
    indent = indent === undefined ? own : indent.slice(0, i);
  }
  const common = indent ?? "";
  return { indent: common, lines: texts.map((t) => (t.trim() ? t.slice(common.length) : "")) };
}

/** Removes one id from a task's `@dep` list (drops the attribute when it becomes empty). */
export function removeDependency(lines: TextLines, task: Task, depId: string): TextEdit[] {
  const attr = task.attrs.find((a) => a.key === "dep");
  if (!attr) return [];
  const kept = attr.value
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "" && p.replace(/\+.*$/, "") !== depId);
  return setAttr(lines, task, "dep", kept.length ? kept.join(",") : undefined);
}

/** Adds a dependency (no-op when already present). */
export function addDependency(lines: TextLines, task: Task, depId: string): TextEdit[] {
  const attr = task.attrs.find((a) => a.key === "dep");
  const parts = attr
    ? attr.value
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
    : [];
  if (parts.some((p) => p.replace(/\+.*$/, "") === depId)) return [];
  return setAttr(lines, task, "dep", [...parts, depId].join(","));
}

// ---------------------------------------------------------------------------------------------
// Property blocks

/** Sets the first `key:` entry of a block, or adds it. Comments after the value are kept. */
export function setProperty(
  lines: TextLines,
  block: PropertyBlock,
  key: string,
  value: string
): TextEdit[] {
  const entry = block.entries.find((e) => e.key.toLowerCase() === key.toLowerCase());
  if (!entry) return [addProperty(lines, block, key, value)];
  if (entry.value === value) return [];
  const text = lines.line(entry.line);
  const r = entry.valueRange;
  // `key:` with nothing after the colon needs a separating space.
  const needsSpace =
    r.start.character === entry.keyRange.end.character + 1 && text[r.start.character - 1] === ":";
  const edit = minimalLineEdit(
    entry.line,
    text,
    text.slice(0, r.start.character) + (needsSpace ? " " : "") + value + text.slice(r.end.character)
  );
  return edit ? [edit] : [];
}

/** Adds a `key: value` line at the end of the block (creating the block under its heading). */
export function addProperty(
  lines: TextLines,
  block: PropertyBlock,
  key: string,
  value: string
): TextEdit {
  const line = `${key}: ${value}`;
  if (block.entries.length > 0) return insertLines(lines, block.insertLine, [line]);
  const h = block.headingLine;
  if (h < 0) return insertLines(lines, 0, [line, ""]);
  const next = h + 1;
  if (next >= lines.lineCount || (next === lines.lineCount - 1 && lines.line(next) === "")) {
    return insertLines(lines, lines.lineCount, ["", line]);
  }
  if (lines.line(next).trim() === "") {
    // Heading, blank line, content → heading, blank, property, blank, content.
    const after = next + 1 < lines.lineCount && lines.line(next + 1).trim() !== "";
    return insertLines(lines, next + 1, after ? [line, ""] : [line]);
  }
  return insertLines(lines, next, ["", line, ""]);
}

export function removeProperty(lines: TextLines, entry: PropertyEntry): TextEdit {
  return deleteLines(lines, entry.line, entry.line);
}
