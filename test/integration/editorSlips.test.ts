// Slips made while typing in a plan file: saving in the middle of a line, Save All, a note typed
// with Enter, F2 on a copied id, a command on a task line in a code block.
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as vscode from "vscode";
import { scheduleJsonText } from "../../src/core/scheduleJson";
import { PlanCodeActionProvider } from "../../src/extension/language/codeActions";
import {
  docText,
  getApi,
  openPlanFile,
  planUri,
  positionOf,
  restorePlan,
  waitFor,
} from "./helpers";

const M2 = "milestones/M2-backend.md";
const M3 = "milestones/M3-frontend.md";

const lineOf = (rel: string, needle: string) =>
  docText(rel)
    .split("\n")
    .findIndex((l) => l.includes(needle));

describe("editor slips", () => {
  before(async () => {
    await getApi();
    await restorePlan();
  });
  afterEach(restorePlan);
  // The schedule cache is written in the background: leave one of the restored plan, not of a
  // plan a test changed (the next suites read it).
  after(async () => {
    const api = await getApi();
    api.state.recompute();
    const cache = planUri(".planner/schedule.json").fsPath;
    const expected = scheduleJsonText(api.state.plan, api.state.schedule);
    await waitFor(() => {
      try {
        return readFileSync(cache, "utf8") === expected;
      } catch {
        return false;
      }
    }, "schedule cache of the restored plan");
  });

  it("gives new tasks in two files different ids with Save All", async () => {
    const api = await getApi();
    for (const [rel, title] of [
      [M2, "New in M2"],
      [M3, "New in M3"],
    ]) {
      const editor = await openPlanFile(rel);
      const end = editor.document.lineAt(editor.document.lineCount - 1).range.end;
      await editor.edit((b) => b.insert(end, `- [ ] ${title} @est:1h\n`));
      editor.selection = new vscode.Selection(0, 0, 0, 0);
      await waitFor(() => api.state.plan.tasks.some((t) => t.title === title), "indexed");
    }
    await vscode.commands.executeCommand("workbench.action.files.saveAll");
    const ids = [M2, M3].map(
      (rel) => /New in M\d @est:1h \^(T\d+)/.exec(docText(rel))?.[1] ?? "no id"
    );
    assert.deepEqual(ids.slice().sort(), ["T408", "T409"]);
  });

  it("gives no id to the line being typed or a task without a title, until later", async () => {
    const api = await getApi();
    const editor = await openPlanFile(M2);
    const pos = await positionOf(M2, "## Notes");
    await editor.edit((b) => b.insert(pos, "- [ ] \n- [ ] Write docs @est:\n\n"));
    const typing = new vscode.Position(pos.line + 1, "- [ ] Write docs @est:".length);
    editor.selection = new vscode.Selection(typing, typing);
    await waitFor(() => api.state.plan.tasks.some((t) => t.title === "Write docs"), "indexed");
    await editor.document.save();
    assert.equal(editor.document.lineAt(pos.line).text, "- [ ] ");
    assert.equal(editor.document.lineAt(pos.line + 1).text, "- [ ] Write docs @est:");
    // Typing goes on where it was; the next save with the cursor elsewhere gives the id.
    await editor.edit((b) => b.insert(editor.selection.active, "4h"));
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    await waitFor(
      () => api.state.plan.tasks.find((t) => t.title === "Write docs")?.est === 4,
      "estimate indexed"
    );
    await editor.document.save();
    assert.equal(editor.document.lineAt(pos.line).text, "- [ ] ");
    assert.equal(editor.document.lineAt(pos.line + 1).text, "- [ ] Write docs @est:4h ^T408");
  });

  it("offers to indent a note typed with Enter under its task", async () => {
    const editor = await openPlanFile(M2);
    const pos = await positionOf(M2, "- [ ] Login and single sign-on");
    await editor.edit((b) => b.insert(pos, "Typed with Enter.\n"));
    const diag = await waitFor(
      () =>
        vscode.languages
          .getDiagnostics(planUri(M2))
          .find((d) => d.code === "note-not-indented" && d.range.start.line === pos.line),
      "note-not-indented"
    );
    assert.equal(diag.severity, vscode.DiagnosticSeverity.Hint);
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      planUri(M2),
      diag.range
    );
    const fix = actions.find((a) => a.title === "Indent it as a note of T110");
    assert.ok(fix?.edit, actions.map((a) => a.title).join("\n"));
    await vscode.workspace.applyEdit(fix.edit);
    assert.equal(editor.document.lineAt(pos.line).text, "      Typed with Enter.");
  });

  it("refuses F2 on an id that copies share, and an id that differs only in case", async () => {
    const api = await getApi();
    const editor = await openPlanFile(M2);
    const original = editor.document.lineAt(lineOf(M2, "^T112")).text;
    const pos = await positionOf(M2, "## Notes");
    await editor.edit((b) => b.insert(pos, `${original}\n\n`));
    await waitFor(
      () => api.state.plan.tasks.filter((t) => t.id === "T112").length === 2,
      "copy indexed"
    );
    const onCopy = new vscode.Position(pos.line, original.indexOf("^T112") + 2);
    await assert.rejects(
      Promise.resolve(vscode.commands.executeCommand("vscode.prepareRename", planUri(M2), onCopy)),
      /T112 is the id of 2 items/
    );
    await assert.rejects(
      Promise.resolve(
        vscode.commands.executeCommand(
          "vscode.executeDocumentRenameProvider",
          planUri(M2),
          onCopy,
          "T150"
        )
      ),
      /T112 is the id of 2 items/
    );
    assert.equal(editor.document.lineAt(pos.line).text, original);

    const onT113 = await positionOf(M2, "^T113", 2);
    await assert.rejects(
      Promise.resolve(
        vscode.commands.executeCommand(
          "vscode.executeDocumentRenameProvider",
          planUri(M2),
          onT113,
          "t111"
        )
      ),
      /The id T111 is already in use, and ids do not differ by case only/
    );
  });

  it("passes a copied line by its line to the quick-fix commands", async () => {
    const api = await getApi();
    const editor = await openPlanFile(M2);
    const at = lineOf(M2, "^T112") + 1;
    await editor.edit((b) =>
      b.insert(new vscode.Position(at, 0), "- [ ] Copied, retitled ^T112\n")
    );
    await waitFor(
      () => api.state.plan.tasks.filter((t) => t.id === "T112").length === 2,
      "copy indexed"
    );
    const diag = await waitFor(
      () =>
        vscode.languages
          .getDiagnostics(planUri(M2))
          .find((d) => d.code === "missing-estimate" && d.range.start.line === at),
      "missing-estimate"
    );
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      planUri(M2),
      diag.range
    );
    const add = actions.find((a) => a.title === "Add estimate…");
    assert.deepEqual(add?.command?.arguments, [{ file: M2, line: at }]);
  });

  it("does not move an id that is no longer where the diagnostic says", async () => {
    const api = await getApi();
    const editor = await openPlanFile(M2);
    const pos = await positionOf(M2, "## Notes");
    // `- [ ] Fix ^T6 @est:8h` was just changed into this; its diagnostic is not updated yet.
    await editor.edit((b) => b.insert(pos, "- [ ] Fix the form @est:8h\n\n"));
    await waitFor(() => api.state.plan.tasks.some((t) => t.title === "Fix the form"), "indexed");
    const line = pos.line;
    const text = editor.document.lineAt(line).text;
    const stale = new vscode.Diagnostic(
      new vscode.Range(line, 10, line, 13),
      "^T6 is read as title text",
      vscode.DiagnosticSeverity.Warning
    );
    stale.source = "planner";
    stale.code = "id-not-last";
    const actions = new PlanCodeActionProvider(api.service).provideCodeActions(
      editor.document,
      stale.range,
      {
        diagnostics: [stale],
        triggerKind: vscode.CodeActionTriggerKind.Invoke,
        only: undefined,
      }
    );
    assert.deepEqual(
      actions.map((a) => a.title),
      [],
      `${text}: ${actions.map((a) => a.title).join()}`
    );
  });

  it("offers no @ keys inside a quoted value", async () => {
    const editor = await openPlanFile(M2);
    const pos = await positionOf(M2, '@blocked:"waiting for ', '@blocked:"waiting for '.length);
    await editor.edit((b) => b.insert(pos, "@"));
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      editor.document.uri,
      pos.translate(0, 1)
    );
    // The planner's keys (VS Code adds the words of the document as text).
    const keysIn = (l: vscode.CompletionList) =>
      l.items
        .filter((i) => i.kind === vscode.CompletionItemKind.Property)
        .map((i) => (typeof i.label === "string" ? i.label : i.label.label));
    assert.deepEqual(keysIn(list), []);
    // After the quoted value they are offered again.
    const id = editor.document.lineAt(pos.line).text.lastIndexOf(" ^T106");
    const after = new vscode.Position(pos.line, id);
    await editor.edit((b) => b.insert(after, " @"));
    const keys = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      editor.document.uri,
      after.translate(0, 2)
    );
    assert.ok(keysIn(keys).includes("est"), keysIn(keys).join());
  });

  it("changes no task from a task line inside a code block in its notes", async () => {
    const api = await getApi();
    const editor = await openPlanFile(M2);
    const pos = await positionOf(M2, "  - [ ] Order events schema");
    const notesEnd = new vscode.Position(pos.line + 3, 0);
    await editor.edit((b) =>
      b.insert(notesEnd, "        ```\n        - [ ] in a code block\n        ```\n")
    );
    await waitFor(
      () => api.state.plan.taskById("T104")?.notes.some((n) => n.text === "- [ ] in a code block"),
      "notes indexed"
    );
    const before = editor.document.getText();
    const inCode = new vscode.Position(pos.line + 4, 10);
    editor.selection = new vscode.Selection(inCode, inCode);
    assert.equal(await vscode.commands.executeCommand("planner.cycleStatus"), false);
    assert.equal(await vscode.commands.executeCommand("planner.status.done"), false);
    assert.equal(editor.document.getText(), before);
  });
});
