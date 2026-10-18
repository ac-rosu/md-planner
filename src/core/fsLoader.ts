// Loads and writes a plan folder with Node's file system. Used by the MCP server, the CLI and tests;
// the extension reads through VS Code instead so that unsaved editor buffers are respected.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { PlanIndex } from "./index";
import { applyEdits, type TextEdit } from "./text";

/** All plan files below `planDir`, as plan-relative POSIX paths. */
export function listPlanFiles(planDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      const rel = relative(planDir, full).split(sep).join("/");
      if (statSync(full).isDirectory()) {
        if (rel === "reports" || rel === "baselines") continue;
        walk(full);
      } else if (PlanIndex.isPlanPath(rel)) {
        out.push(rel);
      }
    }
  };
  if (existsSync(planDir)) walk(planDir);
  return out;
}

export function loadPlanIndex(planDir: string): PlanIndex {
  const index = new PlanIndex();
  for (const rel of listPlanFiles(planDir))
    index.update(rel, readFileSync(join(planDir, rel), "utf8"));
  return index;
}

/** Applies text edits to a plan file on disk and refreshes the index. Returns the new text. */
export function applyFileEdits(
  planDir: string,
  index: PlanIndex,
  relPath: string,
  edits: TextEdit[]
): string {
  const full = join(planDir, relPath);
  const before = existsSync(full) ? readFileSync(full, "utf8") : "";
  const after = applyEdits(before, edits);
  if (after !== before) writeFileSync(full, after, "utf8");
  index.update(relPath, after);
  return after;
}
