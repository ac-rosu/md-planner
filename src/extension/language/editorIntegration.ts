// Editor behaviour for plan files: clicking a checkbox cycles its status, ids are assigned on save,
// and the `planner.isPlanFile` context key drives keybindings and menus.
import * as vscode from "vscode";
import { type Task } from "../../core/model";
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
      // Not into a merge conflict (a copy on each side would get an id) or a file in another
      // encoding.
      if (service.untouchable(file.path)) return;
      e.waitUntil(idEdits(service, guard, e.document));
    }),
  ];
}

/**
 * Ids handed out by saves whose edits may not be in their documents yet. Save All runs the save
 * handlers of several files at once, each against the same plan: without this, a new task in each
 * file would get the same id.
 */
const pendingIds = new Set<string>();

/** How long ids stay reserved when their save never finishes (it was cancelled or failed). */
const PENDING_ID_TIMEOUT_MS = 30_000;

/** Keeps ids reserved until the document is saved (by then the plan has them). */
function holdIds(doc: vscode.TextDocument, ids: string[]): void {
  if (ids.length === 0) return;
  for (const id of ids) pendingIds.add(id);
  const release = () => {
    for (const id of ids) pendingIds.delete(id);
    saved.dispose();
    clearTimeout(timer);
  };
  const saved = vscode.workspace.onDidSaveTextDocument((d) => {
    if (d === doc) release();
  });
  const timer = setTimeout(release, PENDING_ID_TIMEOUT_MS);
}

/**
 * On save: fresh ids for task lines that were copied with their id (compared with the saved file),
 * then ids for tasks that have none. Not for a task line with a cursor where the id would go (at
 * its end): the id would land before what is typed next (`@est:` + save + `4h` → `@est: ^T12 4h`).
 * It gets its id at a later save.
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
  const cursors = vscode.window.visibleTextEditors
    .filter((e) => e.document === doc)
    .flatMap((e) => e.selections.flatMap((s) => [s.active, s.anchor]));
  const typing = (t: Task) => {
    const end = file.lines.line(t.line).trimEnd().length;
    return cursors.some((c) => c.line === t.line && c.character >= end);
  };
  const reserved = new Set(pendingIds);
  const edits = [
    ...renumberCopiedIds(service.plan, file, saved, reserved),
    ...assignMissingIds(service.plan, file, reserved, typing),
  ];
  holdIds(
    doc,
    [...reserved].filter((id) => !pendingIds.has(id))
  );
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
