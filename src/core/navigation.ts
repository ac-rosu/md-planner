// Finds what a cursor position refers to (task ids, owners, test plans …) and where those things
// are defined and referenced. Used by hover, go to definition, find references and rename.
import { type Task } from "./model";
import { matchProperty } from "./parser/properties";
import { matchCheckbox } from "./parser/taskLine";
import { type Plan } from "./resolve";
import { range, type Range } from "./text";

export type Reference =
  | { kind: "task"; id: string; range: Range; isDefinition: boolean }
  | { kind: "punch"; id: string; range: Range; isDefinition: boolean }
  | { kind: "person"; id: string; range: Range }
  | { kind: "test"; id: string; range: Range }
  | { kind: "testCase"; testId: string; caseId: string; range: Range }
  | { kind: "milestone"; id: string; range: Range }
  | { kind: "tag"; tag: string; range: Range }
  /** `@src:path#L42`: a workspace-relative source location (resolved by the host). */
  | { kind: "source"; path: string; line?: number; range: Range };

export interface Location {
  file: string;
  range: Range;
}

/** What the text at (line, character) refers to, if anything. */
export function referenceAt(text: string, line: number, character: number): Reference | undefined {
  const cb = matchCheckbox(text);
  if (cb) {
    for (const t of cb.tokens) {
      if (character < t.start || character > t.end) continue;
      if (t.kind === "id") {
        const kind = /^P\d+$/.test(t.id) ? "punch" : "task";
        return { kind, id: t.id, range: range(line, t.start + 1, t.end), isDefinition: true };
      }
      if (t.kind === "tag") return { kind: "tag", tag: t.tag, range: range(line, t.start, t.end) };
      if (t.kind !== "attr") continue;
      const value = { start: t.valueStart, end: t.valueEnd };
      switch (t.key) {
        case "owner":
          return { kind: "person", id: t.value, range: range(line, value.start, value.end) };
        case "dep": {
          const item = listItemAt(t.value, value.start, character);
          if (!item) return undefined;
          const id = item.text.replace(/\+.*$/, "");
          return {
            kind: "task",
            id,
            range: range(line, item.start, item.start + id.length),
            isDefinition: false,
          };
        }
        case "test":
          return { kind: "test", id: t.value, range: range(line, value.start, value.end) };
        case "src": {
          const m = /^(.*?)(?:#L(\d+))?$/.exec(t.value)!;
          return {
            kind: "source",
            path: m[1],
            line: m[2] ? Number(m[2]) - 1 : undefined,
            range: range(line, value.start, value.end),
          };
        }
        case "punch":
          return {
            kind: "punch",
            id: t.value,
            range: range(line, value.start, value.end),
            isDefinition: false,
          };
        case "from": {
          const [testId, caseId] = t.value.split("/");
          if (caseId && character > value.start + testId.length) {
            const start = value.start + testId.length + 1;
            return { kind: "testCase", testId, caseId, range: range(line, start, value.end) };
          }
          return {
            kind: "test",
            id: testId,
            range: range(line, value.start, value.start + testId.length),
          };
        }
      }
    }
    return undefined;
  }
  const prop = matchProperty(text, line);
  if (prop && character >= prop.valueRange.start.character) {
    const key = prop.key.toLowerCase();
    if (key === "depends" || key === "milestone") {
      const item = listItemAt(prop.value, prop.valueRange.start.character, character);
      if (item)
        return { kind: "milestone", id: item.text, range: range(line, item.start, item.end) };
    }
  }
  return undefined;
}

/** The comma-separated list item under the cursor (with absolute columns). */
function listItemAt(
  value: string,
  valueStart: number,
  character: number
): { text: string; start: number; end: number } | undefined {
  let offset = 0;
  for (const part of value.split(",")) {
    const lead = part.length - part.trimStart().length;
    const text = part.trim();
    const start = valueStart + offset + lead;
    const end = start + text.length;
    if (text && character >= start && character <= end) return { text, start, end };
    offset += part.length + 1;
  }
  return undefined;
}

/** Location of the task (or punch item) line, range covering the `^id`. */
export function taskLocation(t: Task): Location {
  return { file: t.file, range: t.idRange ?? range(t.line, 0, 0) };
}

export function definitionOf(plan: Plan, ref: Reference): Location | undefined {
  switch (ref.kind) {
    case "task": {
      const t = plan.taskById(ref.id);
      return t ? taskLocation(t) : undefined;
    }
    case "punch": {
      const t = plan.punchById(ref.id);
      return t ? taskLocation(t) : undefined;
    }
    case "person": {
      const p = plan.personById(ref.id);
      return p ? { file: p.file, range: range(p.headingLine, 0, 0) } : undefined;
    }
    case "test": {
      const tp = plan.testById(ref.id);
      return tp ? { file: tp.file, range: range(Math.max(0, tp.headingLine), 0, 0) } : undefined;
    }
    case "testCase": {
      const tp = plan.testById(ref.testId);
      const c = tp?.cases.find((x) => x.id.toLowerCase() === ref.caseId.toLowerCase());
      return tp && c ? { file: tp.file, range: range(c.line, 0, 0) } : undefined;
    }
    case "milestone": {
      const m = plan.milestoneById(ref.id);
      return m ? { file: m.file, range: range(Math.max(0, m.headingLine), 0, 0) } : undefined;
    }
    case "tag":
    case "source":
      return undefined;
  }
}

/** Every place a task id occurs: its `^id` and all `@dep` references. */
export function taskIdOccurrences(
  plan: Plan,
  id: string
): Array<Location & { isDefinition: boolean }> {
  const out: Array<Location & { isDefinition: boolean }> = [];
  for (const t of [...plan.tasks, ...plan.inbox, ...plan.punch]) {
    if (t.id === id && t.idRange) {
      const r = t.idRange;
      out.push({
        file: t.file,
        range: range(r.start.line, r.start.character + 1, r.end.character),
        isDefinition: true,
      });
    }
    const dep = t.attrs.find((a) => a.key === "dep");
    if (!dep || dep.quoted) continue;
    let offset = 0;
    for (const part of dep.value.split(",")) {
      const lead = part.length - part.trimStart().length;
      const ref = part.trim().replace(/\+.*$/, "");
      if (ref === id) {
        const start = dep.valueRange.start.character + offset + lead;
        out.push({
          file: t.file,
          range: range(t.line, start, start + id.length),
          isDefinition: false,
        });
      }
      offset += part.length + 1;
    }
  }
  return out;
}

/** References for find-all-references, for any reference kind. */
export function referencesOf(plan: Plan, ref: Reference): Location[] {
  switch (ref.kind) {
    case "task":
      return taskIdOccurrences(plan, ref.id);
    case "punch": {
      const out: Location[] = [];
      const p = plan.punchById(ref.id);
      if (p) out.push(taskLocation(p));
      for (const tp of plan.tests)
        for (const c of tp.cases)
          for (const s of c.steps) if (s.punch === ref.id) out.push(attrLocation(s, "punch"));
      return out;
    }
    case "person": {
      const out: Location[] = [];
      const def = definitionOf(plan, ref);
      if (def) out.push(def);
      for (const t of [...plan.tasks, ...plan.punch, ...plan.inbox])
        if (t.owner?.toLowerCase() === ref.id.toLowerCase()) out.push(attrLocation(t, "owner"));
      return out;
    }
    case "test": {
      const out: Location[] = [];
      const def = definitionOf(plan, ref);
      if (def) out.push(def);
      for (const t of plan.tasks) if (t.test === ref.id) out.push(attrLocation(t, "test"));
      for (const p of plan.punch)
        if (p.from?.split("/")[0] === ref.id) out.push(attrLocation(p, "from"));
      return out;
    }
    case "testCase": {
      const out: Location[] = [];
      const def = definitionOf(plan, ref);
      if (def) out.push(def);
      for (const p of plan.punch)
        if (p.from?.toLowerCase() === `${ref.testId}/${ref.caseId}`.toLowerCase())
          out.push(attrLocation(p, "from"));
      return out;
    }
    case "milestone": {
      const out: Location[] = [];
      const def = definitionOf(plan, ref);
      if (def) out.push(def);
      for (const m of plan.milestones) {
        const e = m.props.entries.find((x) => x.key.toLowerCase() === "depends");
        if (e && m.depends.some((d) => d.toLowerCase() === ref.id.toLowerCase()))
          out.push({ file: m.file, range: e.valueRange });
      }
      for (const tp of plan.tests) {
        const e = tp.props.entries.find((x) => x.key.toLowerCase() === "milestone");
        if (e && tp.milestone?.toLowerCase() === ref.id.toLowerCase())
          out.push({ file: tp.file, range: e.valueRange });
      }
      return out;
    }
    case "tag": {
      const out: Location[] = [];
      for (const t of [...plan.tasks, ...plan.punch, ...plan.inbox])
        for (const tag of t.tags)
          if (tag.tag === ref.tag) out.push({ file: t.file, range: tag.range });
      return out;
    }
    case "source":
      return [];
  }
}

function attrLocation(t: Task, key: string): Location {
  const a = t.attrs.find((x) => x.key === key);
  return { file: t.file, range: a?.valueRange ?? range(t.line, 0, 0) };
}

/** Valid task id syntax for renames: a letter prefix followed by digits/letters. */
export function isValidTaskId(id: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(id);
}
