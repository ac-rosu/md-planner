// The agent skill: `Planner: Add the md-planner skill for AI agents` copies skills/md-planner/SKILL.md
// (shipped with the extension) to .claude/skills/md-planner/SKILL.md in the workspace folder, where
// Claude Code and Copilot agent mode look for project skills. It tells agents how to work with the
// plan: use the MCP tools, never write computed dates, keep ids, validate after editing by hand. A
// copy the user did not change is kept current when the extension brings a new version.
import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { planRootFor, readText, workspaceFolderFor } from "./mcp";
import { type PlanService } from "./planService";
import { decode, encode, openDocument } from "./util";

/** Where the skill goes, relative to the workspace folder. */
export const SKILL_PATH = ".claude/skills/md-planner/SKILL.md";

/** workspaceState: the hash of each skill text written by the planner, per workspace folder. */
const WRITTEN_KEY = "planner.agentSkill.written";

export interface AgentSkillOptions {
  /** No messages and no question: an existing copy that the user changed is left alone. */
  quiet?: boolean;
  folder?: vscode.Uri;
  /** The answer to "replace your changed copy?", given beforehand (tests). */
  replace?: boolean;
}

export async function addAgentSkillCommand(
  context: vscode.ExtensionContext,
  service: PlanService,
  options: AgentSkillOptions = {}
): Promise<vscode.Uri | undefined> {
  const root = planRootFor(service);
  const folder =
    options.folder ??
    (root ? workspaceFolderFor(root) : undefined) ??
    vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!folder) {
    void vscode.window.showErrorMessage("Planner: open a folder first.");
    return undefined;
  }
  const text = await shippedSkill(context);
  const file = skillUri(folder);
  const existing = await readText(file);
  if (existing === text) {
    if (!options.quiet)
      void vscode.window.showInformationMessage(
        `Planner: the md-planner skill in ${SKILL_PATH} is up to date.`
      );
    return file;
  }
  if (existing !== undefined && !writtenByPlanner(context, folder, existing)) {
    // The user changed their copy: replace it only when they say so.
    if (options.quiet) return undefined;
    const replace = "Replace";
    const go =
      options.replace ??
      (await vscode.window.showWarningMessage(
        `Replace ${SKILL_PATH} with the extension's version?`,
        {
          modal: true,
          detail: "It was changed since the planner wrote it; those changes are lost.",
        },
        replace
      )) === replace;
    if (!go) return undefined;
  }
  const blocked = await fileInTheWay(folder);
  if (blocked) {
    // `.claude` (or a folder below it) is a file: the skill cannot go there.
    const why = `Planner: cannot add ${SKILL_PATH}: ${blocked} is a file, not a folder. Rename or remove it, then add the skill again.`;
    if (options.quiet) service.log.warn(why);
    else void vscode.window.showErrorMessage(why);
    return undefined;
  }
  if (!(await write(context, folder, file, text, existing))) {
    const why = `Planner: could not write ${SKILL_PATH}.`;
    if (options.quiet) service.log.warn(why);
    else void vscode.window.showErrorMessage(why);
    return undefined;
  }
  if (!options.quiet)
    void vscode.window.showInformationMessage(
      `Planner: ${existing === undefined ? "added" : "updated"} ${SKILL_PATH}. Claude Code and Copilot agent mode use it when you ask them about the plan; with the MCP server (Configure MCP) they can also change it.`
    );
  return file;
}

/**
 * After an extension update, brings the skill in each workspace folder up to date, when it is still
 * the text the planner wrote there (a copy the user changed is theirs).
 */
export async function refreshAgentSkill(
  context: vscode.ExtensionContext,
  /** The skill's text: the shipped one, or another in tests. */
  skill?: string
): Promise<void> {
  const text = skill ?? (await shippedSkill(context));
  for (const { uri: folder } of vscode.workspace.workspaceFolders ?? []) {
    const file = skillUri(folder);
    const existing = await readText(file);
    if (existing === undefined || existing === text) continue;
    if (!writtenByPlanner(context, folder, existing)) continue;
    if (await write(context, folder, file, text, existing))
      void vscode.window.setStatusBarMessage(`Planner: updated ${SKILL_PATH}`, 5000);
  }
}

function skillUri(folder: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(folder, ...SKILL_PATH.split("/"));
}

async function shippedSkill(context: vscode.ExtensionContext): Promise<string> {
  const source = vscode.Uri.joinPath(context.extensionUri, "skills", "md-planner", "SKILL.md");
  return decode(await vscode.workspace.fs.readFile(source));
}

/** The first of the skill's folders (`.claude`, `.claude/skills` …) that is a file, if one is. */
async function fileInTheWay(folder: vscode.Uri): Promise<string | undefined> {
  const parts = SKILL_PATH.split("/").slice(0, -1);
  for (let i = 1; i <= parts.length; i++) {
    try {
      const stat = await vscode.workspace.fs.stat(
        vscode.Uri.joinPath(folder, ...parts.slice(0, i))
      );
      if (!(stat.type & vscode.FileType.Directory)) return parts.slice(0, i).join("/");
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function writtenByPlanner(
  context: vscode.ExtensionContext,
  folder: vscode.Uri,
  text: string
): boolean {
  const written = context.workspaceState.get<Record<string, string>>(WRITTEN_KEY) ?? {};
  return written[folder.toString()] === hash(text);
}

/** Writes the skill with a WorkspaceEdit (undoable), saves it and remembers what was written. */
async function write(
  context: vscode.ExtensionContext,
  folder: vscode.Uri,
  file: vscode.Uri,
  text: string,
  existing: string | undefined
): Promise<boolean> {
  const edit = new vscode.WorkspaceEdit();
  if (existing === undefined) edit.createFile(file, { contents: encode(text) });
  else {
    const doc = await vscode.workspace.openTextDocument(file);
    edit.replace(file, new vscode.Range(0, 0, doc.lineCount, 0), text);
  }
  if (!(await vscode.workspace.applyEdit(edit))) return false;
  const doc = openDocument(file);
  if (doc?.isDirty) await doc.save();
  const written = context.workspaceState.get<Record<string, string>>(WRITTEN_KEY) ?? {};
  await context.workspaceState.update(WRITTEN_KEY, {
    ...written,
    [folder.toString()]: hash(text),
  });
  return true;
}
