// MCP integration: `Planner: Configure MCP for Claude Code` writes/updates .mcp.json (also done by
// New project), and the server is registered with VS Code's MCP API (Copilot agent mode) when that
// API exists. Configure MCP works before a plan exists: an agent can then create it with
// create_project or build_plan. Copilot gets the server for a workspace with a plan, or one where
// .mcp.json names it (so unrelated projects do not get the planner's tools).
import * as vscode from "vscode";
import { type PlanService } from "./planService";
import { config, decode, encode, exists } from "./util";
import { hasServerEntry, MCP_SERVER_NAME, mergeMcpJson, serverEntry } from "../mcp/config";

/**
 * Copies dist/mcp-server.js to the extension's global storage, a path that stays the same across
 * extension updates, so .mcp.json does not go stale when the extension is updated.
 */
export async function stableServerPath(context: vscode.ExtensionContext): Promise<vscode.Uri> {
  const source = vscode.Uri.joinPath(context.extensionUri, "dist", "mcp-server.js");
  const target = vscode.Uri.joinPath(context.globalStorageUri, "mcp-server.js");
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);
  const bytes = await vscode.workspace.fs.readFile(source);
  let current: Uint8Array | undefined;
  try {
    current = await vscode.workspace.fs.readFile(target);
  } catch {
    current = undefined;
  }
  if (!current || Buffer.compare(Buffer.from(current), Buffer.from(bytes)) !== 0)
    await vscode.workspace.fs.writeFile(target, bytes);
  return target;
}

/** The plan folder: the located one, else `planner.planFolder` in the first workspace folder. */
export function planRootFor(service: PlanService): vscode.Uri | undefined {
  if (service.root) return service.root;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  const planFolder = config().get<string>("planFolder", "plan") || "plan";
  return vscode.Uri.joinPath(folder.uri, ...planFolder.split(/[\\/]/));
}

/**
 * Keeps the copy in global storage current after an extension update (when one exists: it is
 * created by Configure MCP or New project), so existing .mcp.json entries get the new server.
 */
export async function refreshStableServer(context: vscode.ExtensionContext): Promise<void> {
  if (await exists(vscode.Uri.joinPath(context.globalStorageUri, "mcp-server.js")))
    await stableServerPath(context);
}

export async function configureMcpCommand(
  context: vscode.ExtensionContext,
  service: PlanService,
  /** quiet: no message; root and folder: a plan created outside the located one (New project). */
  options: { quiet?: boolean; root?: vscode.Uri; folder?: vscode.Uri } = {}
): Promise<vscode.Uri | undefined> {
  const root = options.root ?? planRootFor(service);
  const folder =
    options.folder ?? (root ? vscode.workspace.getWorkspaceFolder(root)?.uri : undefined);
  if (!root || !folder) {
    void vscode.window.showErrorMessage("Planner: open a folder first.");
    return undefined;
  }
  const server = await stableServerPath(context);
  const file = vscode.Uri.joinPath(folder, ".mcp.json");
  const existing = (await exists(file))
    ? decode(await vscode.workspace.fs.readFile(file))
    : undefined;
  let text: string;
  try {
    text = mergeMcpJson(
      existing,
      serverEntry(process.execPath, server.fsPath, root.fsPath, folder.fsPath)
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Planner: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
  const edit = new vscode.WorkspaceEdit();
  if (existing === undefined) edit.createFile(file, { contents: encode(text) });
  else {
    const doc = await vscode.workspace.openTextDocument(file);
    edit.replace(file, new vscode.Range(0, 0, doc.lineCount, 0), text);
  }
  if (!(await vscode.workspace.applyEdit(edit))) return undefined;
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === file.toString());
  if (doc?.isDirty) await doc.save();
  if (!options.quiet)
    void vscode.window.showInformationMessage(
      `Planner: ${existing === undefined ? "created" : "updated"} .mcp.json with the "${MCP_SERVER_NAME}" server. Claude Code picks it up in this folder (approve it on first use).${service.root ? "" : " There is no plan yet: ask the agent to create one."}`
    );
  return file;
}

/** Minimal shape of VS Code's MCP API (1.101+), declared here because @types/vscode is 1.95. */
interface McpApi {
  registerMcpServerDefinitionProvider(
    id: string,
    provider: {
      onDidChangeMcpServerDefinitions?: vscode.Event<void>;
      provideMcpServerDefinitions(): unknown[] | Thenable<unknown[]>;
    }
  ): vscode.Disposable;
}
type McpStdioCtor = new (
  label: string,
  command: string,
  args: string[],
  env?: Record<string, string>,
  version?: string
) => unknown;

/** Registers the plan's MCP server with VS Code when the MCP API is available. */
export function registerMcpProvider(
  context: vscode.ExtensionContext,
  service: PlanService
): vscode.Disposable | undefined {
  const lm = vscode.lm as unknown as Partial<McpApi>;
  const Stdio = (vscode as unknown as { McpStdioServerDefinition?: McpStdioCtor })
    .McpStdioServerDefinition;
  if (typeof lm.registerMcpServerDefinitionProvider !== "function" || !Stdio) return undefined;
  const changed = new vscode.EventEmitter<void>();
  const version = String(context.extension.packageJSON.version ?? "");
  const provider = lm.registerMcpServerDefinitionProvider("md-planner.mcp", {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions: async () => {
      const root = planRootFor(service);
      const folder = root ? vscode.workspace.getWorkspaceFolder(root)?.uri : undefined;
      if (!root || !(service.root || (folder && (await configuredIn(folder))))) return [];
      const server = vscode.Uri.joinPath(context.extensionUri, "dist", "mcp-server.js").fsPath;
      const e = serverEntry(process.execPath, server, root.fsPath, folder?.fsPath);
      return [new Stdio("Markdown Project Planner", e.command, e.args, e.env, version)];
    },
  });
  const sub = service.onDidChangeRoot(() => changed.fire());
  const watcher = vscode.workspace.createFileSystemWatcher("**/.mcp.json");
  const subs = [watcher.onDidCreate, watcher.onDidChange, watcher.onDidDelete].map((e) =>
    e(() => changed.fire())
  );
  return vscode.Disposable.from(provider, sub, watcher, ...subs, changed);
}

/** True when the folder's .mcp.json names the md-planner server (Configure MCP was run). */
async function configuredIn(folder: vscode.Uri): Promise<boolean> {
  const file = vscode.Uri.joinPath(folder, ".mcp.json");
  return (await exists(file)) && hasServerEntry(decode(await vscode.workspace.fs.readFile(file)));
}
