// Editor behaviour for plan files: clicking a checkbox cycles its status, ids are assigned on save,
// and the `planner.isPlanFile` context key drives keybindings and menus.
import * as vscode from "vscode";
import { matchCheckbox } from "../../core/parser/taskLine";
import { applyEdits } from "../../core/text";
import { assignMissingIds, nextStatus, renumberCopiedIds, setStatus } from "../../core/writer";
import { findAgain, itemAtLine } from "../commands/args";
import { statusEffects } from "../commands/status";
import { type FormatGuard } from "../formatGuard";
import { type PlanService } from "../planService";
import { config, toRange } from "../util";

export function registerEditorIntegration(
  service: PlanService,
  guard: FormatGuard
): vscode.Disposable[] {
  const updateContext = (editor: vscode.TextEditor | undefined) =>
    vscode.commands.executeCommand(
      "setContext",
      "planner.isPlanFile",
      !!editor && service.isPlanDocument(editor.document)
    );
  void updateContext(vscode.window.activeTextEditor);

  return [
    vscode.window.onDidChangeActiveTextEditor((e) => void updateContext(e)),
    service.onDidChangeRoot(() => void updateContext(vscode.window.activeTextEditor)),
    vscode.window.onDidChangeTextEditorSelection((e) => void onSelection(service, e)),
    vscode.workspace.onWillSaveTextDocument((e) => {
      if (
        e.reason === vscode.TextDocumentSaveReason.AfterDelay &&
        !config().get<boolean>("autoAssignIdsOnAutoSave", false)
      )
        return;
      if (!config().get<boolean>("autoAssignIds", true)) return;
      const file = service.fileFor(e.document);
      if (!file || (file.kind !== "milestone" && file.kind !== "punch")) return;
      e.waitUntil(idEdits(service, guard, e.document));
    }),
  ];
}

/**
 * On save: fresh ids for task lines that were copied with their id (compared with the saved file),
 * then ids for tasks that have none.
 */
async function idEdits(
  service: PlanService,
  guard: FormatGuard,
  doc: vscode.TextDocument
): Promise<vscode.TextEdit[]> {
  const saved = await vscode.workspace.fs.readFile(doc.uri).then(
    (bytes) => new TextDecoder().decode(bytes),
    () => undefined
  );
  const file = service.fileFor(doc);
  // The index mirrors the document, so positions are current.
  if (!file || file.lines.text !== doc.getText()) return [];
  const reserved = new Set<string>();
  const edits = [
    ...renumberCopiedIds(service.plan, file, saved, reserved),
    ...assignMissingIds(service.plan, file, reserved),
  ];
  // What the saved file should be; anything more is a formatter's doing (see FormatGuard).
  guard.expect(doc, applyEdits(doc.getText(), edits));
  return edits.map((x) => vscode.TextEdit.replace(toRange(x.range), x.newText));
}

async function onSelection(
  service: PlanService,
  e: vscode.TextEditorSelectionChangeEvent
): Promise<void> {
  if (e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) return;
  if (e.selections.length !== 1 || !e.selections[0].isEmpty) return;
  if (!config().get<boolean>("editor.toggleOnClick", false)) return;
  const doc = e.textEditor.document;
  const rel = service.relPath(doc.uri);
  if (rel === undefined || !service.isPlanDocument(doc)) return;
  const pos = e.selections[0].active;
  const cb = matchCheckbox(doc.lineAt(pos.line).text);
  // A click inside the brackets places the cursor right after `[` or right before `]`.
  if (!cb || pos.character < cb.statusCol || pos.character > cb.statusCol + 1) return;
  const task = itemAtLine(service.plan, rel, pos.line);
  if (!task || task.line !== pos.line) return;
  const next = nextStatus(task.status);
  const effects = await statusEffects(service.plan, task, next);
  if (!effects) return;
  const current = findAgain(service.plan, task);
  const file = current && service.plan.file(current.file);
  if (!current || !file) return;
  const edits = setStatus(file.lines, current, next, service.today(), effects);
  await service.apply([{ path: current.file, edits }], { source: "editor" });
}
