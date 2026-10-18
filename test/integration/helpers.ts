import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import * as vscode from "vscode";
import { PlanIndex } from "../../src/core/index";
import { type PlannerApi } from "../../src/extension/activate";

export const TODAY = "2026-10-14";

let api: PlannerApi | undefined;

export async function getApi(): Promise<PlannerApi> {
  if (api) return api;
  const ext = vscode.extensions.getExtension<PlannerApi>("acro.md-planner");
  if (!ext) throw new Error("extension not found");
  api = await ext.activate();
  api.setToday(TODAY);
  await waitFor(() => api!.service.index.paths.length > 0, "plan loaded");
  return api;
}

export function workspaceDir(): string {
  return vscode.workspace.workspaceFolders![0].uri.fsPath;
}

export function samplePlanDir(): string {
  const ext = vscode.extensions.getExtension("acro.md-planner")!;
  return join(ext.extensionPath, "examples/customer-portal/plan");
}

export function planUri(rel: string): vscode.Uri {
  return vscode.Uri.file(join(workspaceDir(), "plan", ...rel.split("/")));
}

export async function waitFor<T>(
  cond: () => T | undefined | false | Promise<T | undefined | false>,
  what: string,
  timeout = 10_000
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function openPlanFile(rel: string): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(planUri(rel));
  return vscode.window.showTextDocument(doc, { preview: false });
}

export function readPlanFile(rel: string): string {
  return readFileSync(join(workspaceDir(), "plan", rel), "utf8");
}

export function docText(rel: string): string {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === planUri(rel).fsPath);
  return doc ? doc.getText() : readPlanFile(rel);
}

/** Position of `needle` in a plan document (first occurrence), optionally offset. */
export async function positionOf(
  rel: string,
  needle: string,
  offset = 0
): Promise<vscode.Position> {
  const doc = await vscode.workspace.openTextDocument(planUri(rel));
  const index = doc.getText().indexOf(needle);
  if (index < 0) throw new Error(`"${needle}" not found in ${rel}`);
  return doc.positionAt(index + offset);
}

/**
 * Restores every plan file of the test workspace to the sample's content, through VS Code (so open
 * documents, disk and the plan index agree), then closes all editors.
 */
export async function restorePlan(): Promise<void> {
  const a = await getApi();
  const src = samplePlanDir();
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  const expected = new Map<string, string>();
  for (const file of walk(src)) {
    const rel = relative(src, file).split(sep).join("/");
    const original = readFileSync(file, "utf8");
    expected.set(rel, original);
    const uri = planUri(rel);
    const disk = () => {
      try {
        return readFileSync(uri.fsPath, "utf8");
      } catch {
        return undefined;
      }
    };
    // Always through VS Code (open, edit, save), never by writing the file directly: VS Code
    // keeps models of closed documents for a while, and a file written behind a model's back makes
    // its next save a conflict that never completes.
    if (disk() === undefined) {
      const create = new vscode.WorkspaceEdit();
      create.createFile(uri, { contents: Buffer.from(original, "utf8"), ignoreIfExists: true });
      await vscode.workspace.applyEdit(create);
    }
    for (let attempt = 0; ; attempt++) {
      const doc = await vscode.workspace.openTextDocument(uri);
      if (doc.getText() !== original) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), original);
        await vscode.workspace.applyEdit(edit);
      }
      if (doc.isDirty) await doc.save();
      if (!doc.isDirty && doc.getText() === original && disk() === original) break;
      if (attempt === 100) throw new Error(`could not restore ${rel}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  // Never leave dirty documents behind: closing them would open a "save changes?" dialog.
  for (const d of vscode.workspace.textDocuments) {
    if (d.isDirty && d.uri.scheme === "file") {
      await vscode.window.showTextDocument(d);
      await vscode.commands.executeCommand("workbench.action.files.revert");
    }
  }
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  const stale = () =>
    [...expected]
      .filter(([rel]) => PlanIndex.isPlanPath(rel))
      .filter(([rel, text]) => a.service.index.get(rel)?.lines.serialize() !== text)
      .map(([rel]) => rel);
  try {
    await waitFor(() => stale().length === 0, "plan restored");
  } catch {
    throw new Error(`plan not restored in the index: ${stale().join(", ")}`);
  }
}
