// "Planner: New project": asks for name, dates and template and creates the plan folder as one
// undoable WorkspaceEdit.
import { userInfo } from "node:os";
import * as vscode from "vscode";
import { addAgentSkillCommand } from "../agentSkill";
import { configureMcpCommand } from "../mcp";
import { isValidDate } from "../../core/dates";
import { defaultEndDate, instantiateTemplate } from "../../core/templates";
import { type PlanService } from "../planService";
import { config, decode, encode, exists } from "../util";

export interface NewProjectOptions {
  name?: string;
  code?: string;
  start?: string;
  end?: string;
  template?: string;
  lead?: string;
  /** Workspace folder to create the plan in (defaults to the first one). */
  folder?: vscode.Uri;
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
  const custom = config().get<string>("templatesFolder", "");
  if (custom) {
    const base = vscode.workspace.workspaceFolders?.[0]?.uri;
    const root =
      custom.startsWith("/") || /^[A-Za-z]:[\\/]/.test(custom) || !base
        ? vscode.Uri.file(custom)
        : vscode.Uri.joinPath(base, ...custom.split(/[\\/]/));
    if (await exists(root)) {
      for (const [name, type] of await vscode.workspace.fs.readDirectory(root)) {
        if (type & vscode.FileType.Directory)
          out.push({
            name,
            description: `custom (${custom})`,
            uri: vscode.Uri.joinPath(root, name),
          });
      }
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

async function readTemplate(uri: vscode.Uri, prefix = ""): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const [name, type] of await vscode.workspace.fs.readDirectory(uri)) {
    const child = vscode.Uri.joinPath(uri, name);
    if (type & vscode.FileType.Directory)
      Object.assign(files, await readTemplate(child, `${prefix}${name}/`));
    else files[`${prefix}${name}`] = decode(await vscode.workspace.fs.readFile(child));
  }
  return files;
}

export async function newProject(
  context: vscode.ExtensionContext,
  service: PlanService,
  options: NewProjectOptions
): Promise<vscode.Uri | undefined> {
  const folder = options.folder ?? vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!folder) {
    void vscode.window.showErrorMessage("Planner: open a folder first.");
    return undefined;
  }
  const planFolder = config().get<string>("planFolder", "plan") || "plan";
  const root = vscode.Uri.joinPath(folder, ...planFolder.split(/[\\/]/));
  if (await exists(vscode.Uri.joinPath(root, "project.md"))) {
    void vscode.window.showErrorMessage(`Planner: ${planFolder}/project.md already exists.`);
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
