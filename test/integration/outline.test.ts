import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { docText, getApi, openPlanFile, positionOf, restorePlan, TODAY } from "./helpers";

const M2 = "milestones/M2-backend.md";

function line(id: string): string {
  return docText(M2)
    .split("\n")
    .find((l) => l.endsWith(`^${id}`))!;
}

describe("subtasks and reorganizing", () => {
  before(async () => {
    await getApi();
    await restorePlan();
  });
  afterEach(restorePlan);

  it("moves a task up, out and back in, always with its notes and subtasks", async () => {
    await vscode.commands.executeCommand("planner.moveTaskUp", "T102");
    assert.match(
      docText(M2),
      /## Checkout\n\n- \[\/\] Order state machine .*\^T102\n {2}- \[x\] State transitions .*\^T103\n {2}- \[ \] Order events schema @est:6h \^T104\n {8}Notes indented .*\n {8}Use the CloudEvents .*\n- \[x\] Data model & API contract .*\^T101\n/
    );
    await vscode.commands.executeCommand("planner.outdentTask", "T104");
    assert.match(
      docText(M2),
      /\^T103\n- \[ \] Order events schema @est:6h \^T104\n {6}Notes indented .*\n {6}Use the CloudEvents .*\n- \[x\] Data model/
    );
    await vscode.commands.executeCommand("planner.indentTask", "T104");
    assert.match(docText(M2), /\^T103\n {2}- \[ \] Order events schema @est:6h \^T104\n {8}Notes/);
    // The first task of a section cannot move up: nothing changes.
    const before = docText(M2);
    assert.equal(await vscode.commands.executeCommand("planner.moveTaskUp", "T102"), false);
    assert.equal(docText(M2), before);
  });

  it("moves the task under the cursor with Alt+Up, and other lines as usual", async () => {
    const editor = await openPlanFile(M2);
    const pos = await positionOf(M2, "Payment provider integration");
    editor.selection = new vscode.Selection(pos, pos);
    await vscode.commands.executeCommand("planner.moveTaskUp", "editor");
    const lines = editor.document.getText().split("\n");
    assert.match(lines[19], /^- \[ \] Payment provider integration .*\^T105$/);
    assert.match(lines[20], /^- \[\/\] Order state machine .*\^T102$/);
    assert.equal(editor.selection.active.line, 19, "the cursor follows the task");
    // On a note line, Alt+Up is VS Code's Move Line Up.
    const note = await positionOf(M2, "Use the CloudEvents format");
    editor.selection = new vscode.Selection(note, note);
    await vscode.commands.executeCommand("planner.moveTaskUp", "editor");
    assert.match(editor.document.lineAt(note.line - 1).text, /Use the CloudEvents format/);
  });

  it("drops a task from the Milestones view into a section", async () => {
    const api = await getApi();
    const m = api.state.plan.milestoneById("M2")!;
    const accounts = m.sections.find((s) => s.title === "Accounts")!;
    const data = new vscode.DataTransfer();
    data.set("application/vnd.code.tree.planner.milestones", new vscode.DataTransferItem(["T105"]));
    await api.milestonesDnd.handleDrop({ kind: "section", milestone: m, section: accounts }, data);
    assert.match(
      docText(M2),
      /\^T112\n- \[ \] Payment provider integration @est:2d .*\^T105\n\n## Billing/
    );
  });

  it("moves a parent along with its subtasks and asks before leaving subtasks open", async () => {
    await vscode.commands.executeCommand("planner.setStatus", "T104", "done");
    assert.equal(
      line("T102"),
      `- [x] Order state machine @est:12h @owner:sam @dep:T101 @done:${TODAY} #checkout ^T102`
    );
    await vscode.commands.executeCommand("planner.setStatus", "T104", "todo");
    assert.equal(
      line("T102"),
      `- [/] Order state machine @est:12h @owner:sam @dep:T101 @started:${TODAY} #checkout ^T102`
    );
    assert.equal(line("T104"), "  - [ ] Order events schema @est:6h ^T104");
    // Finishing the parent with an open subtask: the choice comes as an argument here.
    await vscode.commands.executeCommand(
      "planner.setStatus",
      "T102",
      "done",
      undefined,
      "cancelled"
    );
    assert.equal(line("T104"), "  - [-] Order events schema @est:6h ^T104");
    assert.match(line("T102"), /^- \[x\] /);
  });

  it("can leave parents alone with planner.parentStatus off", async () => {
    const config = vscode.workspace.getConfiguration("planner");
    await config.update("parentStatus", "off", vscode.ConfigurationTarget.Workspace);
    try {
      await vscode.commands.executeCommand("planner.setStatus", "T104", "done");
      assert.match(line("T102"), /^- \[\/\] Order state machine /);
    } finally {
      await config.update("parentStatus", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });
});
