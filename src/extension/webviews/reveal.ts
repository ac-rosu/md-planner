// Reveals a task line in a text editor next to a webview panel (focus stays in the panel).
import * as vscode from "vscode";
import { type Task } from "../../core/model";
import { type PlanService } from "../planService";
import { toRange } from "../util";

export async function revealTaskInEditor(
  service: PlanService,
  t: Task,
  column: vscode.ViewColumn
): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(service.uri(t.file));
  const range = t.titleRanges.length
    ? new vscode.Range(
        toRange(t.titleRanges[0]).start,
        toRange(t.titleRanges[t.titleRanges.length - 1]).end
      )
    : new vscode.Range(t.line, 0, t.line, 0);
  await vscode.window.showTextDocument(doc, {
    viewColumn: column,
    selection: range,
    preserveFocus: true,
    preview: true,
  });
}
