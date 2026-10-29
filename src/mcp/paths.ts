// Paths in tool arguments stay inside the workspace: an agent (or a prompt it read) must not make
// the server read, write or run files elsewhere on the machine.
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ToolError } from "./tools";

/** True when `path` (relative to `folder`, or absolute) is `folder` or inside it. */
export function insideFolder(folder: string, path: string): boolean {
  const rel = relative(resolve(folder), resolve(folder, path));
  return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/** `path` resolved in the workspace, or a ToolError naming the argument when it leads outside. */
export function workspacePath(workspace: string, path: string, what: string): string {
  if (!insideFolder(workspace, path))
    throw new ToolError(`${what} must be inside the workspace (${workspace}): "${path}" is not.`);
  return resolve(workspace, path);
}
