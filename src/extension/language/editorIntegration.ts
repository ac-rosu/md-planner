// Editor behaviour for plan files: clicking a checkbox cycles its status, ids are assigned on save,
// and the `planner.isPlanFile` context key drives keybindings and menus.
import * as vscode from "vscode";
import { matchCheckbox } from "../../core/parser/taskLine";
import { assignMissingIds, nextStatus, renumberCopiedIds, setStatus } from "../../core/writer";
import { itemAtLine } from "../commands/args";
import { type PlanService } from "../planService";
import { config, toRange } from "../util";

export function registerEditorIntegration(service: PlanService): vscode.Disposable[] {
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
      e.waitUntil(idEdits(service, e.document));
    }),
  ];
}

/**
 * On save: fresh ids for task lines that were copied with their id (compared with the saved file),
 * then ids for tasks that have none.
 */
async function idEdits(service: PlanService, doc: vscode.TextDocument): Promise<vscode.TextEdit[]> {
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
  const file = service.fileFor(doc);
  const task = itemAtLine(service.plan, rel, pos.line);
  if (!file || !task || task.line !== pos.line) return;
  const edits = setStatus(file.lines, task, nextStatus(task.status), service.today());
  await service.apply([{ path: rel, edits }], { source: "editor" });
}
