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
import { TextLines } from "../text";
import { getProp } from "./properties";
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
