// Conversions between core types and the VS Code API.
import * as vscode from "vscode";
import { type Severity } from "../core/model";
import {
  isAbsolutePath,
  pathSegments,
  planFolderSetting as planFolderValue,
} from "../core/settingValues";
import { type Position, type Range } from "../core/text";

export function toRange(r: Range): vscode.Range {
  return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
}

export function toPosition(p: Position): vscode.Position {
  return new vscode.Position(p.line, p.character);
}

export function toSeverity(s: Severity): vscode.DiagnosticSeverity {
  switch (s) {
    case "error":
      return vscode.DiagnosticSeverity.Error;
    case "warning":
      return vscode.DiagnosticSeverity.Warning;
    case "info":
      return vscode.DiagnosticSeverity.Information;
    case "hint":
      return vscode.DiagnosticSeverity.Hint;
  }
}

export function config(scope?: vscode.ConfigurationScope): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("planner", scope);
}

/** `planner.planFolder` as written ("plan" when empty). */
export function planFolderSetting(): string {
  return planFolderValue(config().get<unknown>("planFolder", "plan"));
}

/**
 * The plan folder for a workspace folder: an absolute `planner.planFolder` as it is, a relative one
 * below the folder (`./plan`, `plan/` and `plan` are the same folder). The one place that resolves
 * the setting: locating the plan, New project and Configure MCP all use it.
 */
export function planFolderUri(folder: vscode.Uri, setting = planFolderSetting()): vscode.Uri {
  return isAbsolutePath(setting)
    ? vscode.Uri.file(setting)
    : vscode.Uri.joinPath(folder, ...pathSegments(setting));
}

/** The workspace folder a URI is in (whatever casing either uses); undefined outside all of them. */
export function workspaceFolderOf(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
  return (
    vscode.workspace.getWorkspaceFolder(uri) ??
    vscode.workspace.workspaceFolders?.find((f) => isInside(uri, f.uri))
  );
}

/** True when `uri` is `folder` or inside it (whatever casing either uses where that is ignored). */
export function isInside(uri: vscode.Uri, folder: vscode.Uri): boolean {
  if (uri.scheme !== folder.scheme) return false;
  const fold = (p: string) => (ignoresPathCase(uri) ? p.toLowerCase() : p);
  const base = fold(folder.path).replace(/\/+$/, "");
  const path = fold(uri.path);
  return path === base || path.startsWith(`${base}/`);
}

/**
 * Decodes UTF-8 without a BOM, like VS Code's documents. Lenient: bytes that are not UTF-8 become
 * U+FFFD, so the text is only good for display. Use decodeChecked for text that may be written back.
 */
export function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

const STRICT = new TextDecoder("utf-8", { fatal: true });

/**
 * Decodes like `decode`, and says whether the bytes are valid UTF-8. When they are not (a file in
 * Latin-1 or Windows-1252), the text is the lenient decoding: writing it back would replace every
 * accented letter of the file with U+FFFD.
 */
export function decodeChecked(bytes: Uint8Array): { text: string; utf8: boolean } {
  try {
    return { text: STRICT.decode(bytes), utf8: true };
  } catch {
    return { text: decode(bytes), utf8: false };
  }
}

export function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * True when VS Code treats the URI's path as case-insensitive: `file:` URIs on Windows and macOS.
 * There `/c:/plan/x.md` and `/C:/Plan/x.md` are one file, and which casing a URI carries depends on
 * where it came from (the workspace folder, a file watcher event, an `fsPath`, ...).
 */
export function ignoresPathCase(uri: vscode.Uri): boolean {
  return uri.scheme === "file" && process.platform !== "linux";
}

/** A string that is equal for two URIs of the same resource. */
export function uriKey(uri: vscode.Uri): string {
  return ignoresPathCase(uri) ? uri.toString().toLowerCase() : uri.toString();
}

/** The open text document of a URI, whatever casing either of them uses. */
export function openDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  const key = uriKey(uri);
  return vscode.workspace.textDocuments.find((d) => uriKey(d.uri) === key);
}

export async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** Escapes text for use inside a MarkdownString. */
export function md(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}
