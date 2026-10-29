// "Promote to task": a TODO comment becomes a task with @src:path#Lline, and the comment gets the
// task id (`TODO(T142): …`) so the link works both ways. One undoable WorkspaceEdit.
import * as vscode from "vscode";
import { linkedTask, promoteTodo, scanTodos, type TodoItem } from "../../core/todos";
import { type InsertLocation } from "../../core/writer";
import { type PlanService } from "../planService";
import { type TodoScanner } from "../todoScanner";
import { config, toRange, uriKey } from "../util";
import { pickMilestoneLocation, type PlanIntoTarget } from "./inbox";

export interface TodoArg {
  kind?: string;
  file?: { uri: vscode.Uri; path: string };
  item?: TodoItem;
  uri?: vscode.Uri;
  line?: number;
}

export async function promoteTodoCommand(
  service: PlanService,
  scanner: TodoScanner,
  arg: TodoArg | undefined,
  target?: PlanIntoTarget & { title?: string; owner?: string }
): Promise<string | undefined> {
  let uri = arg?.file?.uri ?? arg?.uri;
  let item = arg?.item;
  if (!item) {
    // From the editor: the TODO on the cursor line.
    const editor = vscode.window.activeTextEditor;
    uri = uri ?? editor?.document.uri;
    const line = arg?.line ?? editor?.selection.active.line;
    if (uri && line !== undefined) {
      await scanner.scanFile(uri, true);
      item = scanner.all
        .find((f) => uriKey(f.uri) === uriKey(uri!))
        ?.items.find((i) => i.line === line);
    }
  }
  if (!uri || !item) {
    void vscode.window.showWarningMessage("Planner: put the cursor on a TODO or FIXME comment.");
    return undefined;
  }
  // A link to a task that is gone (deleted, or never there) does not stop it: the new id goes
  // first in the comment's parentheses, before what they hold.
  const linked = linkedTask(service.plan, item);
  if (linked) {
    void vscode.window.showInformationMessage(
      `Planner: this comment is already linked to ${linked.id}.`
    );
    return linked.id;
  }
  const chosen =
    target ?? (await pickMilestoneLocation(service, "Promote to a task in milestone…"));
  if (!chosen) return undefined;
  const plan = service.plan;
  const milestone = plan.milestoneById(chosen.milestone);
  if (!milestone) {
    void vscode.window.showErrorMessage(`Planner: unknown milestone ${chosen.milestone}.`);
    return undefined;
  }
  const milestoneFile = plan.file(milestone.file)!;
  const location: InsertLocation = chosen.section
    ? { kind: "section", title: chosen.section }
    : { kind: "root" };
  const sourcePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
  // Positions in the source come from the current document text.
  const doc = await vscode.workspace.openTextDocument(uri);
  const fresh = scanTodos(doc.getText(), [item.keyword]).find((i) => i.line === item!.line);
  if (!fresh || fresh.text !== item.text || linkedTask(plan, fresh)) {
    void vscode.window.showWarningMessage(
      "Planner: the comment changed; refresh the TODO list and try again."
    );
    return undefined;
  }
  const p = promoteTodo(plan, {
    todo: fresh,
    sourcePath,
    milestoneFile,
    location,
    title: target?.title,
    owner: target?.owner,
  });
  if (!(await service.mayChange([milestoneFile.path]))) return undefined;
  const edit = new vscode.WorkspaceEdit();
  for (const e of p.planEdits)
    edit.replace(service.uri(milestoneFile.path), toRange(e.range), e.newText);
  edit.replace(uri, toRange(p.sourceEdit.range), p.sourceEdit.newText);
  if (!(await vscode.workspace.applyEdit(edit))) return undefined;
  if (config().get<boolean>("autoSave", true)) {
    await service.save([milestoneFile.path]);
    if (doc.isDirty) await doc.save();
  }
  await scanner.scanFile(uri, true);
  void vscode.window.setStatusBarMessage(`Planner: ${p.id} created in ${milestone.id}`, 4000);
  return p.id;
}
