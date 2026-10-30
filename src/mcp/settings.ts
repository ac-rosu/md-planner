// The workspace's planner.* settings from .vscode/settings.json (JSON with comments), so that the
// MCP server uses the same defaults as the extension (export branding, author, TODO globs …).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isAbsolutePath, pathSegments, planFolderSetting } from "../core/settingValues";

/**
 * The workspace folder of a plan folder, when the server was not told: the nearest folder above it
 * whose `planner.planFolder` (default `plan`) points at it, else its parent (`<workspace>/plan`).
 */
export function findWorkspace(planDir: string): string {
  const plan = resolve(planDir);
  for (let dir = dirname(plan); ; dir = dirname(dir)) {
    if (existsSync(settingsFile(dir)) && planFolderPath(dir) === plan) return dir;
    if (dirname(dir) === dir) return dirname(plan);
  }
}

/**
 * The plan folder of a workspace folder, as the extension resolves `planner.planFolder`: an
 * absolute one as it is, a relative one below the folder (`./plan` and `plan/` are `plan`).
 */
export function planFolderPath(workspace: string): string {
  const folder = planFolderSetting(workspaceSettings(workspace).planFolder);
  return isAbsolutePath(folder) ? resolve(folder) : resolve(workspace, ...pathSegments(folder));
}

function settingsFile(workspace: string): string {
  return join(workspace, ".vscode", "settings.json");
}

/** Strips comments and trailing commas from JSONC. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** `planner.<key>` settings of a workspace (empty when there are none or they do not parse). */
export function workspaceSettings(workspace: string): Record<string, unknown> {
  const file = settingsFile(workspace);
  if (!existsSync(file)) return {};
  try {
    const data = parseJsonc(readFileSync(file, "utf8")) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data ?? {}))
      if (k.startsWith("planner.")) out[k.slice("planner.".length)] = v;
    return out;
  } catch {
    return {};
  }
}
