// File-level parsers. They turn the generic scan into typed structures per plan file kind.
// Values are kept as text here; resolve.ts interprets them with the project settings.
import {
  type InboxFile,
  type ItemKind,
  type MilestoneFile,
  type ParsedFile,
  type PhaseRef,
  type PlanFileKind,
  type PropertyBlock,
  type PunchFile,
  type Section,
  type TestCase,
  type TestFile,
  type TestRun,
} from "../model";
import { parseDate, parseWorkweek } from "../dates";
import { range, TextLines } from "../text";
import { getProp, matchProperty } from "./properties";
import { type Heading, scanLines, type ScanResult } from "./scan";

/** Classifies a plan-folder-relative POSIX path. Generated folders are never plan files. */
export function classifyPlanPath(relPath: string): PlanFileKind | undefined {
  const p = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p.toLowerCase().endsWith(".md")) return undefined;
  if (/^(\.planner|reports|baselines)\//.test(p)) return undefined;
  switch (p) {
    case "project.md":
      return "project";
    case "team.md":
      return "team";
    case "inbox.md":
      return "inbox";
    case "punchlist.md":
      return "punch";
  }
  if (p.startsWith("milestones/")) return "milestone";
  if (p.startsWith("tests/")) return "test";
  return undefined;
}

const ITEM_KIND: Record<PlanFileKind, ItemKind> = {
  project: "task",
  team: "task",
  milestone: "task",
  test: "step",
  punch: "punch",
  inbox: "inbox",
};

export function parsePlanFile(relPath: string, source: string): ParsedFile | undefined {
  const kind = classifyPlanPath(relPath);
  if (!kind) return undefined;
  return parseFileAs(relPath, source, kind);
}

export function parseFileAs(path: string, source: string, kind: PlanFileKind): ParsedFile {
  const lines = TextLines.parse(source);
  const scan = scanLines(path, lines, ITEM_KIND[kind]);
  propertyIssues(path, kind, scan);
  if (kind === "project" || kind === "team")
    for (const t of scan.roots)
      scan.issues.push({
        file: path,
        range: range(t.line, t.indent, lines.line(t.line).length),
        severity: "warning",
        code: "task-outside-milestone",
        message: `Not scheduled: tasks belong in a milestone file (milestones/…), not in ${path}. Move it there.`,
      });
  const h1 = scan.headings.find((h) => h.level === 1);
  const headingLine = h1?.line ?? -1;
  const props: PropertyBlock = h1
    ? scan.props.get(h1.line)!
    : { headingLine: -1, entries: [], insertLine: 0 };
  const base = {
    path,
    lines,
    issues: scan.issues,
    title: h1?.text ?? fileStem(path),
    headingLine,
    props,
    items: scan.items,
    roots: scan.roots,
  };
  switch (kind) {
    case "project":
      return { ...base, kind, phases: readPhases(scan) };
    case "team":
      return {
        ...base,
        kind,
        people: scan.headings
          .filter((h) => h.level === 2)
          .map((h) => ({ name: h.text, headingLine: h.line, props: scan.props.get(h.line)! })),
      };
    case "milestone":
      return milestoneFile(base, scan);
    case "test":
      return testFile(base, scan);
    case "punch":
      return { ...base, kind } satisfies PunchFile;
    case "inbox":
      return { ...base, kind } satisfies InboxFile;
  }
}

/** A property's value as it could be meant there: a date for `target:`, a status for `status:` … */
type Plausible = (value: string) => boolean;
const anyText: Plausible = (v) => v !== "";
const aDate: Plausible = (v) => parseDate(v) !== undefined;
const dates: Plausible = (v) => /^\d{4}-\d{2}-\d{2}/.test(v);
const number: Plausible = (v) => /^\d/.test(v);
const anId: Plausible = (v) => /^[A-Za-z][\w-]*$/.test(v);
const workweek: Plausible = (v) => parseWorkweek(v) !== undefined;

/**
 * The properties of each file kind as the format writes them, what their values look like, and
 * whether a block holds several (`off:`) or one (`target:`).
 */
const PROPERTIES: Partial<Record<PlanFileKind, Record<string, [Plausible, "one" | "many"]>>> = {
  project: {
    start: [aDate, "one"],
    end: [aDate, "one"],
    hoursPerDay: [number, "one"],
    workweek: [workweek, "one"],
    holidays: [dates, "many"],
    holiday: [dates, "many"],
    budget: [number, "one"],
    code: [anyText, "one"],
  },
  team: {
    id: [anId, "one"],
    role: [anyText, "one"],
    capacity: [number, "one"],
    capacityFrom: [dates, "many"],
    skills: [anyText, "one"],
    color: [anyText, "one"],
    off: [dates, "many"],
    overtime: [dates, "many"],
    workday: [dates, "many"],
    workweek: [workweek, "one"],
  },
  milestone: {
    id: [anId, "one"],
    target: [aDate, "one"],
    status: [(v) => /^(planned|active|done|cancelled)$/i.test(v), "one"],
    depends: [(v) => /^[A-Za-z][\w-]*(\s*,\s*[A-Za-z][\w-]*)*$/.test(v), "one"],
  },
};

/** The headings whose property block a file kind reads: the title, or each person in team.md. */
function propertyHeadings(kind: PlanFileKind, scan: ScanResult): Heading[] {
  const level = kind === "team" ? 2 : 1;
  return scan.headings.filter((h) => h.level === level);
}

/**
 * Property lines that are not read: after a blank line or text below the block (`off:` added to a
 * person after a blank line, `target:` under the description), and a second one of a property
 * that holds one value. Only lines with a key written as the format writes it and a value that
 * fits it count, so prose such as "Status: waiting for the client" is left alone.
 */
function propertyIssues(path: string, kind: PlanFileKind, scan: ScanResult): void {
  const known = PROPERTIES[kind];
  if (!known) return;
  for (const h of propertyHeadings(kind, scan)) {
    const block = scan.props.get(h.line);
    const seen = new Set<string>();
    for (const e of block?.entries ?? []) {
      const spec = Object.entries(known).find(([k]) => k.toLowerCase() === e.key.toLowerCase());
      if (!spec || spec[1][1] === "many") continue;
      if (seen.has(spec[0]))
        scan.issues.push({
          file: path,
          range: range(e.line, 0, e.valueRange.end.character),
          severity: "warning",
          code: "duplicate-property",
          message: `A second ${e.key}: only the first one is used.`,
        });
      seen.add(spec[0]);
    }
    const next = scan.headings.find((x) => x.line > h.line);
    const end = next ? next.line : scan.lines.lineCount;
    let fence = false;
    for (const ft of scan.freeText) {
      if (ft.line <= h.line || ft.line >= end) continue;
      if (/^[ \t]*(`{3,}|~{3,})/.test(ft.text)) fence = !fence;
      if (fence) continue;
      const e = matchProperty(ft.text, ft.line);
      const spec = e && known[e.key];
      if (!e || !spec || !spec[0](e.value)) continue;
      scan.issues.push({
        file: path,
        range: range(ft.line, 0, e.valueRange.end.character),
        severity: "warning",
        code: "property-not-read",
        message: `${e.key}: is not read: property lines go right under the heading, one after the other, with no blank line or text in between.`,
      });
    }
  }
}

/** Where a property line that is not read belongs: the end of the block of the heading above it. */
export function propertyBlockFor(file: ParsedFile, line: number): number | undefined {
  const heads =
    file.kind === "team"
      ? file.people.map((p) => ({ line: p.headingLine, props: p.props }))
      : [{ line: file.headingLine, props: file.props }];
  const head = heads.filter((x) => x.line >= 0 && x.line < line).pop();
  return head?.props.insertLine;
}

function fileStem(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.md$/i, "");
}

function readPhases(scan: ScanResult): PhaseRef[] {
  const heading = scan.headings.find((h) => h.level === 2 && /^phases$/i.test(h.text));
  if (!heading) return [];
  const next = scan.headings.find((h) => h.line > heading.line && h.level <= 2);
  const end = next ? next.line : scan.lines.lineCount;
  const phases: PhaseRef[] = [];
  for (const ft of scan.freeText) {
    if (ft.line <= heading.line || ft.line >= end) continue;
    const m = /^[ \t]*[-*+][ \t]+(.+?)[ \t]*(?:(?:→|->)[ \t]*([A-Za-z][\w-]*))?[ \t]*$/.exec(
      ft.text
    );
    if (m) phases.push({ name: m[1].trim(), milestone: m[2], line: ft.line });
  }
  return phases;
}

type Base = Omit<MilestoneFile, "kind" | "sections" | "rootTasks" | "description">;

function milestoneFile(base: Base, scan: ScanResult): MilestoneFile {
  const sections: Section[] = scan.headings
    .filter((h) => h.level === 2)
    .map((h) => ({
      title: h.text,
      line: h.line,
      tasks: scan.roots.filter((t) => t.sectionLine === h.line),
    }));
  const rootTasks = scan.roots.filter((t) => t.sectionLine === undefined);
  const firstHeadingAfter = scan.headings.find((h) => h.line > base.headingLine);
  const descEnd = firstHeadingAfter ? firstHeadingAfter.line : scan.lines.lineCount;
  const description = scan.freeText
    .filter((f) => f.line > base.headingLine && f.line < descEnd)
    .map((f) => f.text.trim());
  return { ...base, kind: "milestone", sections, rootTasks, description };
}

const RUN_HEADING = /^Run\b[ \t]*(\d{4}-\d{2}-\d{2})?/i;
const CASE_ID = /^([A-Za-z]+[-_]?\d+[A-Za-z0-9._-]*)\b[ \t:–-]*(.*)$/;

function testFile(base: Omit<TestFile, "kind" | "cases" | "runs">, scan: ScanResult): TestFile {
  const cases: TestCase[] = [];
  const runs: TestRun[] = [];
  const level2 = scan.headings.filter((h) => h.level === 2);
  for (const h of level2) {
    const props = scan.props.get(h.line)!;
    const run = RUN_HEADING.exec(h.text);
    if (run) {
      runs.push({ date: run[1] ?? "", title: h.text, line: h.line, props });
      continue;
    }
    const { id, title } = caseIdentity(h);
    cases.push({
      id,
      title,
      line: h.line,
      props,
      pre: getProp(props, "pre")?.value,
      steps: scan.roots.filter((t) => t.sectionLine === h.line),
    });
  }
  return { ...base, kind: "test", cases, runs };
}

function caseIdentity(h: Heading): { id: string; title: string } {
  const m = CASE_ID.exec(h.text);
  if (m) return { id: m[1], title: m[2].trim() || m[1] };
  const slug = h.text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return { id: slug || `case-${h.line + 1}`, title: h.text };
}
