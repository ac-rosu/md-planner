import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import {
  docText,
  getApi,
  openPlanFile,
  planUri,
  positionOf,
  restorePlan,
  TODAY,
  waitFor,
} from "./helpers";

const M2 = "milestones/M2-backend.md";

function line(id: string): string {
  return docText(M2)
    .split("\n")
    .find((l) => l.endsWith(`^${id}`))!;
}

/** The order of T105 to T108, the last tasks of Checkout. */
function checkout(): string[] {
  return docText(M2)
    .split("\n")
    .flatMap((l) => /\^(T10[5-8])$/.exec(l)?.[1] ?? []);
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

  it("moves a task without an id again and again, from the editor or the tree", async () => {
    const api = await getApi();
    const editor = await openPlanFile(M2);
    const doc = editor.document;
    const subtasks = new vscode.WorkspaceEdit();
    subtasks.insert(
      doc.uri,
      new vscode.Position(24, 0),
      "  - [ ] Sub one\n        Note of sub one.\n  - [ ] Sub two\n  - [ ] Sub three\n"
    );
    await vscode.workspace.applyEdit(subtasks);
    // Held down: the second Alt+Down comes before the first one is applied.
    editor.selection = new vscode.Selection(24, 0, 24, 0);
    const down = () => vscode.commands.executeCommand("planner.moveTaskDown", "editor");
    await Promise.all([down(), down()]);
    assert.deepEqual(doc.getText().split("\n").slice(24, 28), [
      "  - [ ] Sub two",
      "  - [ ] Sub three",
      "  - [ ] Sub one",
      "        Note of sub one.",
    ]);
    assert.equal(editor.selection.active.line, 26, "the cursor follows the task");
    // In the tree: select it and move it up twice (saving gives the subtasks ids).
    api.service.fireNow();
    await vscode.commands.executeCommand("planner.revealInTree", { task: { file: M2, line: 26 } });
    const up = () => vscode.commands.executeCommand("planner.moveTaskUp", "tree");
    await Promise.all([up(), up()]);
    assert.match(
      docText(M2),
      /\^T104\n(?: {8}.*\n)+ {2}- \[ \] Sub one \^T\d+\n {8}Note of sub one\.\n {2}- \[ \] Sub two \^T\d+\n {2}- \[ \] Sub three \^T\d+\n- \[ \] Payment provider/
    );
  });

  it("moves a task in the tree press after press while it keeps no id", async () => {
    const config = vscode.workspace.getConfiguration("planner");
    await config.update("autoAssignIds", false, vscode.ConfigurationTarget.Workspace);
    try {
      const api = await getApi();
      const editor = await openPlanFile(M2);
      const doc = editor.document;
      const subtasks = new vscode.WorkspaceEdit();
      subtasks.insert(
        doc.uri,
        new vscode.Position(24, 0),
        "  - [ ] Sub one\n        Note of sub one.\n  - [ ] Sub two\n  - [ ] Sub three\n"
      );
      await vscode.workspace.applyEdit(subtasks);
      await doc.save();
      api.service.fireNow();
      await vscode.commands.executeCommand("planner.revealInTree", {
        task: { file: M2, line: 24 },
      });
      const press = (move: string) => vscode.commands.executeCommand(move, "tree");
      await Promise.all([press("planner.moveTaskDown"), press("planner.moveTaskDown")]);
      assert.deepEqual(doc.getText().split("\n").slice(24, 28), [
        "  - [ ] Sub two",
        "  - [ ] Sub three",
        "  - [ ] Sub one",
        "        Note of sub one.",
      ]);
      // A third press at once would be dropped (see below): it comes once the two are done.
      await Promise.all([press("planner.moveTaskUp"), press("planner.moveTaskUp")]);
      await press("planner.moveTaskUp");
      assert.match(
        doc.getText(),
        /\^T103\n {2}- \[ \] Sub one\n {8}Note of sub one\.\n {2}- \[ \] Order events schema @est:6h \^T104\n(?: {8}.*\n)+ {2}- \[ \] Sub two\n {2}- \[ \] Sub three\n- \[ \] Payment provider/
      );
      assert.equal(doc.isDirty, false, "saved after each move");
    } finally {
      await config.update("autoAssignIds", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  it("drops presses in the tree while one waits, so a held-down key stops when released", async () => {
    await vscode.commands.executeCommand("planner.revealInTree", { task: "T105" });
    const press = () => vscode.commands.executeCommand<boolean>("planner.moveTaskDown", "tree");
    // Key repeat presses faster than a move from the tree is applied, saved and revealed: one press
    // waits for the move before it, the others do nothing.
    const pressed = await Promise.all([press(), press(), press(), press()]);
    assert.deepEqual(pressed, [true, true, false, false]);
    assert.deepEqual(checkout(), ["T106", "T107", "T105", "T108"]);
    assert.equal(await press(), true, "the next press moves it again");
    assert.deepEqual(checkout(), ["T106", "T107", "T108", "T105"]);
  });

  it("drops presses in the editor while one waits, and the cursor stays on the task", async () => {
    const editor = await openPlanFile(M2);
    const at = await positionOf(M2, "Payment provider integration");
    editor.selection = new vscode.Selection(at, at);
    const press = () => vscode.commands.executeCommand<boolean>("planner.moveTaskDown", "editor");
    const pressed = await Promise.all([press(), press(), press(), press()]);
    assert.deepEqual(pressed, [true, true, false, false]);
    assert.deepEqual(checkout(), ["T106", "T107", "T105", "T108"]);
    assert.equal(editor.selection.active.line, 26, "the cursor follows the task");
  });

  it("follows a moved task in the tree when saving changes its line (a formatter)", async () => {
    // Saving adds a blank line at the top, as format on save can.
    const formatter = vscode.workspace.onWillSaveTextDocument((e) => {
      if (e.document.uri.fsPath === planUri(M2).fsPath)
        e.waitUntil(Promise.resolve([vscode.TextEdit.insert(new vscode.Position(1, 0), "\n")]));
    });
    try {
      await vscode.commands.executeCommand("planner.revealInTree", { task: "T105" });
      await vscode.commands.executeCommand("planner.moveTaskDown", "tree");
      await vscode.commands.executeCommand("planner.moveTaskDown", "tree");
      assert.deepEqual(checkout(), ["T106", "T107", "T105", "T108"]);
    } finally {
      formatter.dispose();
    }
  });

  it("refuses a task without an id that the tree shows from before the plan changed", async () => {
    const api = await getApi();
    const editor = await openPlanFile(M2);
    const doc = editor.document;
    const subtasks = new vscode.WorkspaceEdit();
    subtasks.insert(doc.uri, new vscode.Position(24, 0), "  - [ ] Sub one\n  - [ ] Sub two\n");
    await vscode.workspace.applyEdit(subtasks);
    // Its node, and then a line added above it before the tree is drawn again.
    const sub = api.service.plan.file(M2)!.items.find((t) => t.title === "Sub one")!;
    const above = new vscode.WorkspaceEdit();
    above.insert(doc.uri, new vscode.Position(12, 0), "\n");
    await vscode.workspace.applyEdit(above);
    const text = doc.getText();
    const window = vscode.window as unknown as { setStatusBarMessage: (m: string) => unknown };
    const original = window.setStatusBarMessage;
    const shown: string[] = [];
    window.setStatusBarMessage = (m: string) => {
      shown.push(m);
      return new vscode.Disposable(() => undefined);
    };
    try {
      const node = { kind: "task", task: sub };
      assert.equal(await vscode.commands.executeCommand("planner.moveTaskDown", node), false);
      assert.deepEqual(shown, ["$(info) The plan changed in the meantime; try again."]);
      assert.equal(doc.getText(), text);
    } finally {
      window.setStatusBarMessage = original;
    }
    // Nor is it dragged; the task as the plan has it now is.
    const drag = (task: typeof sub) => {
      const data = new vscode.DataTransfer();
      api.milestonesDnd.handleDrag([{ kind: "task", task }], data);
      return data.get("application/vnd.code.tree.planner.milestones")?.value as unknown;
    };
    assert.equal(drag(sub), undefined);
    const now = api.service.plan.file(M2)!.items.find((t) => t.title === "Sub one")!;
    assert.deepEqual(drag(now), [`${M2}#26`]);
  });

  it("asks before an open task becomes a subtask of a cancelled one", async () => {
    await vscode.commands.executeCommand("planner.moveTaskUp", "T115");
    const window = vscode.window as unknown as { showWarningMessage: (m: string) => unknown };
    const original = window.showWarningMessage;
    const asked: string[] = [];
    let answer: string | undefined;
    window.showWarningMessage = (m: string) => {
      asked.push(m);
      return Promise.resolve(answer);
    };
    try {
      assert.equal(await vscode.commands.executeCommand("planner.indentTask", "T114"), false);
      assert.equal(
        asked[0],
        "T114 would end up under T115, which is cancelled, and no longer be scheduled."
      );
      assert.match(line("T114"), /^- \[ \] Payment retries/);
      answer = "Move anyway";
      assert.equal(await vscode.commands.executeCommand("planner.indentTask", "T114"), true);
      assert.match(line("T114"), /^ {2}- \[ \] Payment retries/);
    } finally {
      window.showWarningMessage = original;
    }
  });

  it("makes the next task a subtask with a quick fix, as an edit in the editor", async () => {
    const editor = await openPlanFile(M2);
    const doc = editor.document;
    const group = new vscode.WorkspaceEdit();
    group.insert(doc.uri, new vscode.Position(31, 0), "- [ ] Account work\n");
    await vscode.workspace.applyEdit(group);
    await doc.save();
    const at = await positionOf(M2, "Account work");
    editor.selection = new vscode.Selection(at, at);
    const diag = await waitFor(
      () =>
        vscode.languages
          .getDiagnostics(doc.uri)
          .find((d) => d.code === "missing-estimate" && d.range.start.line === 31),
      "missing-estimate"
    );
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      doc.uri,
      diag.range
    );
    const fix = actions.find((a) => a.title === "Make the next task (T110) a subtask of this one");
    assert.ok(fix?.command, "the quick fix is offered");
    await vscode.commands.executeCommand(fix.command.command, ...(fix.command.arguments ?? []));
    assert.match(doc.lineAt(32).text, /^ {2}- \[ \] Account and profile services .*\^T110$/);
    assert.equal(doc.isDirty, true, "an edit in the editor, not saved");
    assert.equal(vscode.window.activeTextEditor?.document, doc);
    assert.deepEqual(editor.selection.active, at, "the cursor stays");
  });

  it("moves the tasks of every cursor and selection with Alt+Up/Down", async () => {
    const editor = await openPlanFile(M2);
    const a = await positionOf(M2, "Account and profile services");
    const b = await positionOf(M2, "Login and single sign-on");
    editor.selections = [new vscode.Selection(a, a), new vscode.Selection(b, b)];
    await vscode.commands.executeCommand("planner.moveTaskDown", "editor");
    const ids = () =>
      editor.document
        .getText()
        .split("\n")
        .slice(31, 34)
        .map((l) => /\^(T\d+)$/.exec(l)?.[1]);
    assert.deepEqual(ids(), ["T112", "T110", "T111"]);
    assert.deepEqual(
      editor.selections.map((s) => [s.active.line, s.active.character]),
      [
        [32, a.character],
        [33, b.character],
      ]
    );
    // A selection over both task lines moves them back up together.
    editor.selection = new vscode.Selection(32, 0, 33, 5);
    await vscode.commands.executeCommand("planner.moveTaskUp", "editor");
    assert.deepEqual(ids(), ["T110", "T111", "T112"]);
    assert.deepEqual(
      [editor.selection.anchor, editor.selection.active].map((p) => [p.line, p.character]),
      [
        [31, 0],
        [32, 5],
      ]
    );
  });

  it("keeps a selection of whole lines on its task, from the menu and press after press", async () => {
    const editor = await openPlanFile(M2);
    const ids = () =>
      editor.document
        .getText()
        .split("\n")
        .slice(24, 28)
        .map((l) => /\^(T\d+)$/.exec(l)?.[1]);
    const selected = () =>
      [editor.selection.anchor, editor.selection.active].map((p) => [p.line, p.character]);
    // The whole line of T105 (Cmd+L): the end at the start of the next line does not take T106.
    editor.selection = new vscode.Selection(24, 0, 25, 0);
    // Reorganize ▸ in the editor's context menu passes the document.
    await vscode.commands.executeCommand("planner.moveTaskDown", editor.document.uri);
    assert.deepEqual(ids(), ["T106", "T105", "T107", "T108"]);
    assert.deepEqual(selected(), [
      [25, 0],
      [26, 0],
    ]);
    for (const [move, order] of [
      ["planner.moveTaskDown", ["T106", "T107", "T105", "T108"]],
      ["planner.moveTaskDown", ["T106", "T107", "T108", "T105"]],
      ["planner.moveTaskUp", ["T106", "T107", "T105", "T108"]],
      ["planner.moveTaskUp", ["T106", "T105", "T107", "T108"]],
    ] as const) {
      await vscode.commands.executeCommand(move, "editor");
      assert.deepEqual(ids(), order);
      const at = order.indexOf("T105") + 24;
      assert.deepEqual(selected(), [
        [at, 0],
        [at + 1, 0],
      ]);
    }
  });

  it("asks before a drop moves open work into a cancelled milestone", async () => {
    const api = await getApi();
    const doc = await vscode.workspace.openTextDocument(planUri("milestones/M3-frontend.md"));
    const cancel = new vscode.WorkspaceEdit();
    cancel.replace(doc.uri, doc.lineAt(4).range, "status: cancelled");
    await vscode.workspace.applyEdit(cancel);
    const m3 = api.state.plan.milestoneById("M3")!;
    assert.equal(m3.status, "cancelled");
    const pages = m3.sections.find((s) => s.title === "Pages")!;
    const data = new vscode.DataTransfer();
    data.set("application/vnd.code.tree.planner.milestones", new vscode.DataTransferItem(["T105"]));
    const window = vscode.window as unknown as { showWarningMessage: (m: string) => unknown };
    const original = window.showWarningMessage;
    const asked: string[] = [];
    window.showWarningMessage = (m: string) => {
      asked.push(m);
      return Promise.resolve(undefined);
    };
    try {
      await api.milestonesDnd.handleDrop({ kind: "section", milestone: m3, section: pages }, data);
      assert.deepEqual(asked, [
        "T105 would move into M3, which is cancelled, and no longer be scheduled.",
      ]);
      assert.match(line("T105"), /^- \[ \] Payment provider integration /);
    } finally {
      window.showWarningMessage = original;
    }
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

  it("drags the copy that kept its id, not the first task with that id", async () => {
    const api = await getApi();
    // A copied line given another title keeps the id until the file is saved.
    const at = await positionOf(M2, "- [ ] Payment provider integration");
    const edit = new vscode.WorkspaceEdit();
    edit.insert(planUri(M2), at, "- [ ] Payment fallback @est:4h ^T105\n");
    assert.ok(await vscode.workspace.applyEdit(edit));
    const copy = await waitFor(
      () => api.state.plan.file(M2)?.items.find((t) => t.title === "Payment fallback"),
      "copy indexed"
    );
    const m = api.state.plan.milestoneById("M2")!;
    const accounts = m.sections.find((s) => s.title === "Accounts")!;
    const data = new vscode.DataTransfer();
    api.milestonesDnd.handleDrag([{ kind: "task", task: copy }], data);
    await api.milestonesDnd.handleDrop({ kind: "section", milestone: m, section: accounts }, data);
    // The copy moved (saving gave it an id of its own); the original stayed in Checkout.
    assert.match(docText(M2), /\^T112\n- \[ \] Payment fallback @est:4h \^T\d+\n\n## Billing/);
    const text = docText(M2);
    const original = text.indexOf("- [ ] Payment provider integration @est:2d");
    assert.ok(text.indexOf("## Checkout") < original && original < text.indexOf("## Accounts"));
    assert.match(line("T105"), /Payment provider integration/);
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

  it("starts work while an earlier milestone is open only when told to, and shows it", async () => {
    const config = vscode.workspace.getConfiguration("planner");
    await config.update("confirmEarlyStart", true, vscode.ConfigurationTarget.Workspace);
    try {
      // M2 depends on M1, which still has open tasks; `true` answers "Start anyway".
      await vscode.commands.executeCommand(
        "planner.setStatus",
        "T121",
        "doing",
        undefined,
        undefined,
        true
      );
      assert.match(line("T121"), /^- \[\/\] Shared API library/);
      const diag = await waitFor(
        () =>
          vscode.languages
            .getDiagnostics(planUri(M2))
            .find((d) => d.code === "started-early" && d.range.start.line === 13),
        "started-early"
      );
      assert.match(diag.message, /^Started while M1 \(\d+ open tasks: .*\) is not finished\./);
    } finally {
      await config.update("confirmEarlyStart", undefined, vscode.ConfigurationTarget.Workspace);
    }
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
