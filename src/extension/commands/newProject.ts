// "Planner: New project": asks for name, dates and template and creates the plan folder as one
// undoable WorkspaceEdit.
import { userInfo } from "node:os";
import * as vscode from "vscode";
import { addAgentSkillCommand } from "../agentSkill";
import { configureMcpCommand, workspaceFolderFor } from "../mcp";
import { isValidDate } from "../../core/dates";
import { PlanIndex } from "../../core/index";
import { isAbsolutePath } from "../../core/settingValues";
import { defaultEndDate, instantiateTemplate } from "../../core/templates";
import { type PlanService } from "../planService";
import { config, decode, encode, isInside, planFolderSetting, planFolderUri } from "../util";

export interface NewProjectOptions {
  name?: string;
  code?: string;
  start?: string;
  end?: string;
  template?: string;
  lead?: string;
  /**
   * Workspace folder to create the plan in. Defaults to the one with the plan folder; with several
   * folders and no plan folder in any, the user picks one.
   */
  folder?: vscode.Uri;
  /**
   * The answer to "add the template's files to the plan files that are already there?", given
   * beforehand (tests).
   */
  addToExisting?: boolean;
}

interface TemplateSource {
  name: string;
  description: string;
  uri: vscode.Uri;
}

export function registerNewProjectCommand(
  context: vscode.ExtensionContext,
  service: PlanService
): vscode.Disposable {
  return vscode.commands.registerCommand("planner.newProject", (options?: NewProjectOptions) =>
    newProject(context, service, options ?? {})
  );
}

export async function listTemplates(context: vscode.ExtensionContext): Promise<TemplateSource[]> {
  const out: TemplateSource[] = [];
  const builtIn = vscode.Uri.joinPath(context.extensionUri, "templates");
  const descriptions: Record<string, string> = {
    software:
      "Discovery & design → backend and frontend → acceptance test → launch, with task skeletons",
    blank: "One milestone, no tasks",
  };
  for (const [name, type] of await vscode.workspace.fs.readDirectory(builtIn)) {
    if (type & vscode.FileType.Directory)
      out.push({
        name,
        description: descriptions[name] ?? "built-in",
        uri: vscode.Uri.joinPath(builtIn, name),
      });
  }
  const setting = config().get<unknown>("templatesFolder", "");
  const custom = typeof setting === "string" ? setting.trim() : "";
  if (custom) {
    const base = vscode.workspace.workspaceFolders?.[0]?.uri;
    const root =
      isAbsolutePath(custom) || !base ? vscode.Uri.file(custom) : planFolderUri(base, custom);
    // Only a folder holds templates (one sub-folder each); hidden ones (.git) are not templates.
    let entries: Array<[string, vscode.FileType]> | undefined;
    try {
      if ((await vscode.workspace.fs.stat(root)).type & vscode.FileType.Directory)
        entries = await vscode.workspace.fs.readDirectory(root);
    } catch {
      entries = undefined;
    }
    if (!entries)
      void vscode.window.showWarningMessage(
        `Planner: planner.templatesFolder (${custom}) is not a folder; only the built-in templates are offered.`
      );
    for (const [name, type] of entries ?? []) {
      if (type & vscode.FileType.Directory && !name.startsWith("."))
        out.push({
          name,
          description: `custom (${custom})`,
          uri: vscode.Uri.joinPath(root, name),
        });
    }
  }
  // Built-ins first in a fixed order, then custom templates alphabetically.
  const order = ["software", "blank"];
  return out.sort((a, b) => {
    const ia = order.indexOf(a.name);
    const ib = order.indexOf(b.name);
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    return a.name.localeCompare(b.name);
  });
}

/**
 * The files of a template: its Markdown files and its .gitignore. Nothing else goes into the plan
 * (an editor's .DS_Store, a .git folder, a logo, which would not survive as text), as with the MCP
 * server's templates.
 */
async function readTemplate(uri: vscode.Uri, prefix = ""): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const [name, type] of await vscode.workspace.fs.readDirectory(uri)) {
    const child = vscode.Uri.joinPath(uri, name);
    if (type & vscode.FileType.Directory) {
      if (!name.startsWith("."))
        Object.assign(files, await readTemplate(child, `${prefix}${name}/`));
    } else if (/\.md$/i.test(name) || name === ".gitignore")
      files[`${prefix}${name}`] = decode(await vscode.workspace.fs.readFile(child));
  }
  return files;
}

/** The files below a folder, as paths relative to it, hidden folders left out. */
async function filesBelow(uri: vscode.Uri, prefix = ""): Promise<string[]> {
  let entries: Array<[string, vscode.FileType]>;
  try {
    entries = await vscode.workspace.fs.readDirectory(uri);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const [name, type] of entries) {
    if (!(type & vscode.FileType.Directory)) out.push(`${prefix}${name}`);
    else if (!name.startsWith("."))
      out.push(...(await filesBelow(vscode.Uri.joinPath(uri, name), `${prefix}${name}/`)));
  }
  return out;
}

/** A few names of a list, and how many more there are. */
function someOf(names: string[], max = 6): string {
  return names.length > max
    ? `${names.slice(0, max).join(", ")} and ${names.length - max} more`
    : names.join(", ");
}

/**
 * Where the new plan goes: the workspace folder (for .mcp.json and the skill) and the plan folder
 * in it (`planner.planFolder`, which may be absolute). By default the workspace folder that has
 * the plan folder; with several and none has one, the user picks. Undefined when cancelled, or
 * (after saying so) without a workspace folder.
 */
async function planTarget(
  service: PlanService,
  folder: vscode.Uri | undefined
): Promise<{ folder: vscode.Uri; root: vscode.Uri } | undefined> {
  if (folder) return { folder, root: planFolderUri(folder) };
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showErrorMessage("Planner: open a folder first.");
    return undefined;
  }
  if (service.root) {
    const own = workspaceFolderFor(service.root);
    return own && { folder: own, root: service.root };
  }
  const setting = planFolderSetting();
  if (folders.length === 1 || isAbsolutePath(setting)) {
    const root = planFolderUri(folders[0].uri, setting);
    return { folder: workspaceFolderFor(root) ?? folders[0].uri, root };
  }
  const pick = await vscode.window.showWorkspaceFolderPick({
    placeHolder: `Workspace folder for the new plan (${setting}/)`,
  });
  return pick && { folder: pick.uri, root: planFolderUri(pick.uri, setting) };
}

export async function newProject(
  context: vscode.ExtensionContext,
  service: PlanService,
  options: NewProjectOptions
): Promise<vscode.Uri | undefined> {
  const target = await planTarget(service, options.folder);
  if (!target) return undefined;
  const { folder, root } = target;
  // How the plan folder is named in messages: from its workspace folder, else in full.
  const planFolder = isInside(root, folder)
    ? root.path.slice(folder.path.replace(/\/+$/, "").length + 1) || "."
    : root.fsPath;
  // Also Project.md: the plan is read whatever the case of its file names.
  const existing = await vscode.workspace.fs.readDirectory(root).then(
    (entries) => entries.find(([n]) => n.toLowerCase() === "project.md")?.[0],
    () => undefined
  );
  if (existing) {
    void vscode.window.showErrorMessage(`Planner: ${planFolder}/${existing} already exists.`);
    return undefined;
  }
  const today = service.today();
  const name =
    options.name ??
    (await vscode.window.showInputBox({
      prompt: "Project name",
      placeHolder: "Customer Portal 2.0",
    }));
  if (!name) return undefined;
  const code =
    options.code ??
    (await vscode.window.showInputBox({
      prompt: "Project code (optional)",
      placeHolder: "P-2026-014",
    }));
  if (code === undefined) return undefined;
  const dateInput = (prompt: string, value: string) =>
    vscode.window.showInputBox({
      prompt,
      value,
      validateInput: (v) => (isValidDate(v) ? undefined : "Use YYYY-MM-DD"),
    });
  const start = options.start ?? (await dateInput("Start date", today));
  if (!start) return undefined;
  const end = options.end ?? (await dateInput("End date", defaultEndDate(start)));
  if (!end) return undefined;
  if (end < start) {
    void vscode.window.showErrorMessage("Planner: the end date is before the start date.");
    return undefined;
  }
  const templates = await listTemplates(context);
  let template = templates.find((t) => t.name === options.template);
  if (!template) {
    if (options.template) {
      void vscode.window.showErrorMessage(`Planner: unknown template "${options.template}".`);
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      templates.map((t) => ({ label: t.name, description: t.description, t })),
      { placeHolder: "Template" }
    );
    if (!pick) return undefined;
    template = pick.t;
  }
  const lead =
    options.lead ??
    (await vscode.window.showInputBox({
      prompt: "Your name (first team member)",
      value: defaultUserName(),
    }));
  if (lead === undefined) return undefined;

  const files = instantiateTemplate(await readTemplate(template.uri), {
    name,
    code: code || undefined,
    start,
    end,
    today,
    lead: lead || undefined,
  });
  // Plan files already there (a plan whose project.md is missing): the template's files would go
  // in next to them, with milestones and ids of their own. Only when the user says so.
  const there = await filesBelow(root);
  const planFiles = there.filter((p) => PlanIndex.isPlanPath(p)).sort();
  if (planFiles.length > 0) {
    const taken = new Set(there.map((p) => p.toLowerCase()));
    const added = Object.keys(files)
      .filter((p) => !taken.has(p.toLowerCase()))
      .sort();
    const add = "Add Files";
    const go =
      options.addToExisting ??
      (await vscode.window.showWarningMessage(
        `${planFolder}/ already has plan files (${someOf(planFiles)}). Add the files of the "${template.name}" template to them?`,
        {
          modal: true,
          detail: `Added: ${someOf(added, 12)}. Files that are there stay as they are. The template's milestones and task ids may repeat yours; to start afresh, use an empty folder (planner.planFolder) instead.`,
        },
        add
      )) === add;
    if (!go) return undefined;
  }
  const edit = new vscode.WorkspaceEdit();
  for (const [path, text] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    edit.createFile(vscode.Uri.joinPath(root, ...path.split("/")), {
      contents: encode(text),
      ignoreIfExists: true,
    });
  }
  if (!(await vscode.workspace.applyEdit(edit))) {
    void vscode.window.showErrorMessage("Planner: could not create the plan folder.");
    return undefined;
  }
  await service.locate();
  const project = vscode.Uri.joinPath(root, "project.md");
  await vscode.window.showTextDocument(project, { preview: false });
  void vscode.commands.executeCommand("planner.milestones.focus");
  // Agents (Claude Code …) can work on the new plan right away through the MCP server.
  if (config().get<boolean>("mcp.configureOnNewProject", true)) {
    const mcp = await configureMcpCommand(context, service, { quiet: true, root, folder });
    const skill = mcp && (await addAgentSkillCommand(context, service, { quiet: true, folder }));
    if (mcp)
      void vscode.window.showInformationMessage(
        `Planner: created ${planFolder}/ and .mcp.json${skill ? " with the agent skill" : ""} – Claude Code and other agents can now build and update this plan with the md-planner MCP server.`
      );
  }
  return root;
}

function defaultUserName(): string {
  try {
    const name = userInfo().username;
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return "";
  }
}
