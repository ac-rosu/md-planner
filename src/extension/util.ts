// Conversions between core types and the VS Code API.
import * as vscode from "vscode";
import { type Severity } from "../core/model";
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

export function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
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
