// Generic line-based structure scan of a plan Markdown file: headings, property blocks, checkbox
// items (nested by indentation) with their notes, and free text. Code fences are respected.
import { type Issue, type ItemKind, type PropertyBlock, type Task, statusFromChar } from "../model";
import { indentWidth, leadingWhitespace, range, type Range, type TextLines } from "../text";
import { readPropertyBlock } from "./properties";
import { type CheckboxLine, matchCheckbox, nearMissCheckbox, tokenRange } from "./taskLine";

export interface Heading {
  level: number;
  text: string;
  line: number;
  textRange: Range;
}

export interface ScanResult {
  lines: TextLines;
  headings: Heading[];
  /** Property block per heading line. */
  props: Map<number, PropertyBlock>;
  items: Task[];
  roots: Task[];
  /** Non-blank lines that are not headings, properties, items or notes. */
  freeText: Array<{ line: number; text: string }>;
  issues: Issue[];
}

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE = /^[ \t]*(`{3,}|~{3,})/;

export function scanLines(file: string, lines: TextLines, kind: ItemKind): ScanResult {
  const headings: Heading[] = [];
  const props = new Map<number, PropertyBlock>();
  const items: Task[] = [];
  const roots: Task[] = [];
  const freeText: Array<{ line: number; text: string }> = [];
  const issues: Issue[] = [];
  const propLines = new Set<number>();

  let stack: Task[] = [];
  let fence: { marker: string; owner?: Task } | undefined;
  let level2: Heading | undefined;

  for (let i = 0; i < lines.lineCount; i++) {
    const text = lines.line(i);

    if (fence) {
      if (fence.owner) addNote(fence.owner, i, text);
      else freeText.push({ line: i, text });
      const close = FENCE.exec(text);
      if (
        close &&
        close[1][0] === fence.marker[0] &&
        close[1].length >= fence.marker.length &&
        text.trim() === close[1]
      ) {
        fence = undefined;
      }
      continue;
    }

    const heading = HEADING.exec(text);
    if (heading) {
      stack = [];
      const raw = (heading[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").replace(/^#+$/, "");
      const start = text.indexOf(raw, heading[1].length);
      const h: Heading = {
        level: heading[1].length,
        text: raw.trim(),
        line: i,
        textRange: range(i, Math.max(start, 0), Math.max(start, 0) + raw.length),
      };
      headings.push(h);
      if (h.level === 2) level2 = h;
      if (h.level === 1) level2 = undefined;
      const block = readPropertyBlock(lines, i);
      props.set(i, block);
      for (const e of block.entries) propLines.add(e.line);
      continue;
    }

    if (propLines.has(i)) continue;

    const cb = matchCheckbox(text);
    if (cb) {
      const indent = indentWidth(cb.indentText);
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
      const parent = stack[stack.length - 1];
      const task = makeTask(file, i, cb, kind, issues);
      task.section = level2?.text;
      task.sectionLine = level2?.line;
      if (parent) {
        task.parent = parent;
        parent.children.push(task);
      } else {
        roots.push(task);
      }
      items.push(task);
      stack.push(task);
      extendEnd(task, i);
      continue;
    }

    if (text.trim() === "") continue;

    const near = nearMissCheckbox(text);
    if (near) {
      issues.push({
        file,
        range: range(i, leadingWhitespace(text).length, text.length),
        severity: "warning",
        code: "not-a-task",
        message: `Not read as a task: ${near.problem}.`,
        data: { fixed: near.fixed },
      });
    }

    const width = indentWidth(text);
    while (stack.length > 0 && stack[stack.length - 1].indent >= width) stack.pop();
    const owner = stack[stack.length - 1];
    const fenceOpen = FENCE.exec(text);
    if (owner) {
      addNote(owner, i, text);
    } else {
      freeText.push({ line: i, text });
    }
    if (fenceOpen) fence = { marker: fenceOpen[1], owner };
  }

  return { lines, headings, props, items, roots, freeText, issues };
}

function addNote(task: Task, line: number, text: string): void {
  task.notes.push({ line, text: text.trim() });
  extendEnd(task, line);
}

function extendEnd(task: Task, line: number): void {
  for (let t: Task | undefined = task; t; t = t.parent) {
    if (t.endLine < line) t.endLine = line;
  }
}

function makeTask(
  file: string,
  line: number,
  cb: CheckboxLine,
  kind: ItemKind,
  issues: Issue[]
): Task {
  let status = statusFromChar(cb.statusChar);
  if (!status) {
    issues.push({
      file,
      range: range(line, cb.statusCol, cb.statusCol + 1),
      severity: "warning",
      code: "unknown-status",
      message: `Unknown status "[${cb.statusChar}]"; use [ ], [/], [?], [!], [x] or [-]. Treated as to do.`,
    });
    status = "todo";
  }
  const task: Task = {
    kind,
    file,
    line,
    indent: indentWidth(cb.indentText),
    indentText: cb.indentText,
    marker: cb.marker,
    statusChar: cb.statusChar,
    statusCol: cb.statusCol,
    status,
    title: "",
    titleRanges: [],
    attrs: [],
    tags: [],
    notes: [],
    children: [],
    endLine: line,
    order: 0,
    deps: [],
    prio: "med",
    custom: {},
  };
  const titleParts: string[] = [];
  for (const t of cb.tokens) {
    switch (t.kind) {
      case "text":
        titleParts.push(t.text);
        task.titleRanges.push(tokenRange(line, t));
        break;
      case "attr":
        task.attrs.push({
          key: t.key,
          value: t.value,
          quoted: t.quoted,
          range: tokenRange(line, t),
          valueRange: range(line, t.valueStart, t.valueEnd),
        });
        break;
      case "tag":
        task.tags.push({ tag: t.tag, range: tokenRange(line, t) });
        break;
      case "id":
        task.id = t.id;
        task.idRange = tokenRange(line, t);
        break;
      case "space":
        break;
    }
  }
  task.title = titleParts.join(" ");
  return task;
}
