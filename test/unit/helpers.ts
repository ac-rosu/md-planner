import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { loadPlanIndex } from "../../src/core/fsLoader";
import { PlanIndex } from "../../src/core/index";
import { type ParsedFile, type Task } from "../../src/core/model";
import { parseFileAs } from "../../src/core/parser/files";
import { type Plan } from "../../src/core/resolve";
import { applyEdits, type TextEdit } from "../../src/core/text";

export const ROOT = join(__dirname, "..", "..");
export const SAMPLE_PLAN = join(ROOT, "examples/customer-portal/plan");
export const FIXTURES = join(ROOT, "test/fixtures");
/** The fixed "today" used for every schedule-dependent test. */
export const TODAY = "2026-10-14";

export function loadSample(): PlanIndex {
  return loadPlanIndex(SAMPLE_PLAN);
}

/** Builds an in-memory plan from { relPath: text } pairs. */
export function planFrom(files: Record<string, string>): Plan {
  const index = new PlanIndex();
  for (const [path, text] of Object.entries(files)) index.update(path, text);
  return index.plan;
}

export function indexFrom(files: Record<string, string>): PlanIndex {
  const index = new PlanIndex();
  for (const [path, text] of Object.entries(files)) index.update(path, text);
  return index;
}

export function milestone(text: string, path = "milestones/M1-test.md"): ParsedFile {
  return parseFileAs(path, text, "milestone");
}

export function task(plan: Plan, id: string): Task {
  const t = plan.taskById(id) ?? plan.punchById(id);
  if (!t) throw new Error(`no task ${id}`);
  return t;
}

export function apply(file: ParsedFile, edits: TextEdit[]): string {
  return applyEdits(file.lines.serialize(), edits);
}

export function walkFiles(dir: string, filter: (rel: string) => boolean = () => true): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const rel = relative(dir, full).split(sep).join("/");
        if (filter(rel)) out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

export function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Lines are a plan's milestone text helper: joins with LF and adds a final newline. */
export function md(...lines: string[]): string {
  return lines.join("\n") + "\n";
}
