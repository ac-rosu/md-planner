import * as assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { type Task } from "../../src/core/model";
import { currentTask } from "../../src/extension/commands/args";
import { type MilestoneNode } from "../../src/extension/views/milestonesTree";
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

/** Sets a status from a tree node that shows `task`, as it was when the tree was drawn. */
function setStatusOf(task: Task, status: string): Thenable<boolean | undefined> {
  return vscode.commands.executeCommand<boolean>(
    "planner.setStatus",
    { kind: "task", task },
    status
  );
}

describe("editor integration", () => {
  before(async () => {
    await getApi();
    await restorePlan();
  });
  afterEach(restorePlan);

  it("sets a status from a command, writes @started, saves, and undo restores it", async () => {
    const api = await getApi();
    const before = docText(M2);
    assert.equal(await vscode.commands.executeCommand("planner.setStatus", "T104", "doing"), true);
    const after = docText(M2);
    assert.match(
      after,
      new RegExp(`- \\[/\\] Order events schema @est:6h @started:${TODAY} \\^T104`)
    );
    assert.equal(readFileSync(planUri(M2).fsPath, "utf8"), after, "auto-saved");
    await waitFor(() => api.state.plan.taskById("T104")?.status === "doing", "index updated");
    await openPlanFile(M2);
    await vscode.commands.executeCommand("undo");
    assert.equal(docText(M2), before);
  });

  it("cycles the status of the task under the cursor", async () => {
    const editor = await openPlanFile(M2);
    const pos = await positionOf(M2, "Payment provider integration");
    editor.selection = new vscode.Selection(pos, pos);
    await vscode.commands.executeCommand("planner.cycleStatus");
    assert.match(
      docText(M2),
      /- \[\/\] Payment provider integration .* @prio:high @started:2026-10-14 @eq:checkout\/payment #checkout \^T105/
    );
    assert.ok(editor.document.isDirty, "editor edits are not auto-saved");
    await vscode.commands.executeCommand("undo");
    assert.match(docText(M2), /- \[ \] Payment provider integration @est:2d/);
  });

  it("assigns owners and estimates with minimal edits", async () => {
    await vscode.commands.executeCommand("planner.assignOwner", "T104", "priya");
    await vscode.commands.executeCommand("planner.addEstimate", "T104", "1d");
    assert.match(docText(M2), / {2}- \[ \] Order events schema @est:1d @owner:priya \^T104/);
  });

  it("completes owners, dependencies, keys and dates", async () => {
    const editor = await openPlanFile(M2);
    const pos = await positionOf(M2, " ^T104");
    await editor.edit((b) => b.insert(pos, " @owner:"));
    const at = pos.translate(0, " @owner:".length);
    const owners = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      editor.document.uri,
      at
    );
    const labels = owners.items.map((i) => (typeof i.label === "string" ? i.label : i.label.label));
    for (const id of ["alex", "sam", "priya", "jordan", "maria"])
      assert.ok(labels.includes(id), id);

    await editor.edit((b) => b.replace(new vscode.Range(pos, at), " @dep:T10"));
    const deps = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      editor.document.uri,
      pos.translate(0, " @dep:T10".length)
    );
    const depLabels = deps.items.map((i) =>
      typeof i.label === "string" ? i.label : i.label.label
    );
    assert.ok(depLabels.includes("T101") && depLabels.includes("T105"));
    assert.ok(!depLabels.includes("T104"), "a task cannot depend on itself");

    await editor.edit((b) =>
      b.replace(new vscode.Range(pos, pos.translate(0, " @dep:T10".length)), " @due:")
    );
    const dates = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      editor.document.uri,
      pos.translate(0, " @due:".length)
    );
    const dateLabels = dates.items.map((i) =>
      typeof i.label === "string" ? i.label : i.label.label
    );
    assert.ok(
      dateLabels.includes("2026-10-14") && dateLabels.includes("2026-10-19"),
      dateLabels.join()
    );
  });

  it("hovers, goes to definition and finds references for task ids", async () => {
    await openPlanFile(M2);
    const depPos = await positionOf(M2, "@dep:T101", 6);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      planUri(M2),
      depPos
    );
    const text = hovers
      .flatMap((h) => h.contents.map((c) => (c as vscode.MarkdownString).value))
      .join("\n");
    assert.match(text, /T101 · Data model & API contract/);

    const defs = await vscode.commands.executeCommand<vscode.Location[]>(
      "vscode.executeDefinitionProvider",
      planUri(M2),
      depPos
    );
    assert.equal(defs.length, 1);
    const defLine = (await vscode.workspace.openTextDocument(defs[0].uri)).lineAt(
      defs[0].range.start.line
    ).text;
    assert.match(defLine, /\^T101$/);

    const refs = await vscode.commands.executeCommand<vscode.Location[]>(
      "vscode.executeReferenceProvider",
      planUri(M2),
      depPos
    );
    assert.equal(refs.length, 2);

    const ownerPos = await positionOf(M2, "@owner:priya", 8);
    const ownerHover = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      planUri(M2),
      ownerPos
    );
    assert.match(
      (ownerHover[0].contents[0] as vscode.MarkdownString).value,
      /Priya.*Frontend developer/s
    );
  });

  it("renames a task id and every @dep", async () => {
    await openPlanFile(M2);
    const pos = await positionOf(M2, "^T101", 2);
    const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
      "vscode.executeDocumentRenameProvider",
      planUri(M2),
      pos,
      "T150"
    );
    assert.ok(edit);
    assert.ok(await vscode.workspace.applyEdit(edit));
    const text = docText(M2);
    assert.match(text, /\^T150\n/);
    assert.match(text, /@dep:T150 /);
    assert.doesNotMatch(text, /T101\b/);
  });

  it("publishes diagnostics and offers quick fixes", async () => {
    const api = await getApi();
    const editor = await openPlanFile(M2);
    const pos = await positionOf(M2, "@owner:sam @dep:T101");
    await editor.edit((b) =>
      b.replace(
        new vscode.Range(pos, pos.translate(0, "@owner:sam @dep:T101".length)),
        "@owner:bob @dep:T101,T999"
      )
    );
    const diags = await waitFor(() => {
      const d = vscode.languages.getDiagnostics(planUri(M2));
      return d.some((x) => x.code === "unknown-dep") ? d : undefined;
    }, "diagnostics");
    const unknownDep = diags.find((d) => d.code === "unknown-dep")!;
    assert.equal(editor.document.getText(unknownDep.range), "T999");
    assert.ok(diags.some((d) => d.code === "unknown-owner"));
    assert.equal(api.diagnostics.collection.get(planUri(M2))?.length, diags.length);

    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      planUri(M2),
      unknownDep.range
    );
    const remove = actions.find((a) => a.title === "Remove broken dependency T999")!;
    assert.ok(remove?.edit);
    await vscode.workspace.applyEdit(remove.edit!);
    assert.match(docText(M2), /@owner:bob @dep:T101 #checkout \^T102/);
  });

  it("offers estimate and id quick fixes", async () => {
    const editor = await openPlanFile(M2);
    const pos = await positionOf(M2, "- [ ] Password reset and e-mail verification @est:12h");
    await editor.edit((b) => b.insert(pos, "- [ ] Unestimated new task\n"));
    const diag = await waitFor(
      () =>
        vscode.languages
          .getDiagnostics(planUri(M2))
          .find((d) => d.code === "missing-estimate" && d.range.start.line === pos.line),
      "missing-estimate"
    );
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      planUri(M2),
      diag.range
    );
    assert.ok(
      actions.some((a) => a.title === "Make the next task (T112) a subtask of this one"),
      actions.map((a) => a.title).join("\n")
    );
    const add = actions.find((a) => a.title === "Add estimate @est:4h")!;
    await vscode.workspace.applyEdit(add.edit!);
    assert.equal(editor.document.lineAt(pos.line).text, "- [ ] Unestimated new task @est:4h");
  });

  it("assigns ids on save", async () => {
    const api = await getApi();
    const editor = await openPlanFile(M2);
    const pos = await positionOf(M2, "## Notes");
    await editor.edit((b) => b.insert(pos, "- [ ] Task without id @est:2h\n\n"));
    await waitFor(() => api.state.plan.tasks.some((t) => t.title === "Task without id"), "indexed");
    await editor.document.save();
    assert.match(editor.document.getText(), /- \[ \] Task without id @est:2h \^T408\n/);
  });

  it("gives a copied and retitled task line a new id on save and keeps the original", async () => {
    const api = await getApi();
    const editor = await openPlanFile(M2);
    const pos = await positionOf(M2, "  - [ ] Order events schema @est:6h ^T104");
    await editor.edit((b) => b.insert(pos, "  - [ ] Payment events schema @est:6h ^T104\n"));
    await waitFor(
      () => api.state.plan.tasks.filter((t) => t.id === "T104").length === 2,
      "duplicate indexed"
    );
    await editor.document.save();
    const lines = editor.document.getText().split("\n");
    assert.equal(lines[pos.line], "  - [ ] Payment events schema @est:6h ^T408");
    assert.equal(lines[pos.line + 1], "  - [ ] Order events schema @est:6h ^T104");
  });

  it("notices when format on save rewrites a plan file", async () => {
    const api = await getApi();
    const formatter = vscode.languages.registerDocumentFormattingEditProvider(
      { language: "markdown" },
      {
        // A formatter that re-indents notes, as Prettier did in a pilot user's plan.
        provideDocumentFormattingEdits: (doc) => {
          const line = doc
            .getText()
            .split("\n")
            .findIndex((l) => l.startsWith("        Notes"));
          return line < 0
            ? []
            : [vscode.TextEdit.replace(new vscode.Range(line, 0, line, 8), "  ")];
        },
      }
    );
    const config = vscode.workspace.getConfiguration("editor", { languageId: "markdown" });
    await config.update("formatOnSave", true, vscode.ConfigurationTarget.Workspace, true);
    try {
      const editor = await openPlanFile(M2);
      const pos = await positionOf(M2, "## Notes");
      await editor.edit((b) => b.insert(pos, "- [ ] Saved with a formatter @est:1h\n\n"));
      const before = api.formatGuard.reformatted.length;
      await editor.document.save();
      await waitFor(
        () => api.formatGuard.reformatted.length > before,
        "the guard noticed the formatter"
      );
      assert.equal(api.formatGuard.reformatted[api.formatGuard.reformatted.length - 1], M2);
    } finally {
      formatter.dispose();
      await config.update("formatOnSave", undefined, vscode.ConfigurationTarget.Workspace, true);
    }
  });

  it("turns a mistyped line into a task with a quick fix", async () => {
    const editor = await openPlanFile(M2);
    const pos = await positionOf(M2, "## Notes");
    await editor.edit((b) => b.insert(pos, "- [] Mistyped task @est:1h\n\n"));
    const diag = await waitFor(
      () =>
        vscode.languages
          .getDiagnostics(planUri(M2))
          .find((d) => d.code === "not-a-task" && d.range.start.line === pos.line),
      "not-a-task"
    );
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      planUri(M2),
      diag.range
    );
    const fix = actions.find((a) => a.title === "Make it a task: - [ ] Mistyped task @est:1h")!;
    await vscode.workspace.applyEdit(fix.edit!);
    assert.equal(editor.document.lineAt(pos.line).text, "- [ ] Mistyped task @est:1h");
  });

  it("offers the other statuses when hovering a checkbox", async () => {
    await openPlanFile(M2);
    const pos = await positionOf(M2, "- [ ] Order events schema", 3);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      planUri(M2),
      pos
    );
    const text = hovers
      .flatMap((h) => h.contents.map((c) => (c as vscode.MarkdownString).value))
      .join("\n");
    assert.match(text, /\*\*To do\*\*/);
    assert.match(text, /\[\$\(play-circle\) In progress\]\(command:planner\.setStatus\?/);
    assert.match(text, /Done\]\(command:planner\.setStatus\?/);
    assert.doesNotMatch(text, /To do\]\(command:/);
  });

  describe("a task line copied with its id", () => {
    const ORIGINAL = "  - [ ] Order events schema @est:6h ^T104";
    const COPY = "- [ ] Order events schema @est:6h ^T104";

    /** Pastes a copy of T104 (same title, so it keeps its id) before `## Notes`. */
    async function pasteCopy(): Promise<{ editor: vscode.TextEditor; line: number }> {
      const api = await getApi();
      const editor = await openPlanFile(M2);
      const pos = await positionOf(M2, "## Notes");
      await editor.edit((b) => b.insert(pos, `${COPY}\n\n`));
      await waitFor(
        () => api.state.plan.tasks.filter((t) => t.id === "T104").length === 2,
        "copy indexed"
      );
      return { editor, line: pos.line };
    }

    function lineAt(line: number): string {
      return docText(M2).split("\n")[line];
    }

    it("changes the copy under the cursor, also when the original is in another file", async () => {
      const api = await getApi();
      const M1 = "milestones/M1-discovery-design.md";
      const original =
        "- [ ] Internal review of the specification @est:4h @owner:sam @dep:T006 #review ^T011";
      const editor = await openPlanFile(M2);
      const pos = await positionOf(M2, "## Accounts");
      await editor.edit((b) => b.insert(pos, `${original}\n\n`));
      await waitFor(
        () => api.state.plan.tasks.filter((t) => t.id === "T011").length === 2,
        "copy indexed"
      );
      const before = docText(M2).split("\n");
      editor.selection = new vscode.Selection(pos, pos);
      assert.equal(await vscode.commands.executeCommand("planner.cycleStatus"), true);
      const after = docText(M2).split("\n");
      assert.match(
        after[pos.line],
        new RegExp(`^- \\[/\\] Internal review of the specification .*@started:${TODAY}.* \\^T011$`)
      );
      // Only the copy changed: not the M2 line on the original's line number, not the original.
      assert.deepEqual(
        after.filter((_, i) => i !== pos.line),
        before.filter((_, i) => i !== pos.line)
      );
      assert.ok(docText(M1).split("\n").includes(original));
    });

    it("sets the status of the copy under the cursor, not of the original", async () => {
      const { editor, line } = await pasteCopy();
      editor.selection = new vscode.Selection(line, 2, line, 2);
      assert.equal(
        await vscode.commands.executeCommand("planner.setStatus", undefined, "done"),
        true
      );
      assert.equal(lineAt(line), `- [x] Order events schema @est:6h @done:${TODAY} ^T104`);
      assert.ok(docText(M2).split("\n").includes(ORIGINAL), "the original is unchanged");
    });

    it("sets the status of the copy a tree node shows", async () => {
      const api = await getApi();
      const { line } = await pasteCopy();
      const copy = api.state.plan.file(M2)!.items.find((t) => t.line === line)!;
      assert.equal(
        await vscode.commands.executeCommand(
          "planner.setStatus",
          { kind: "task", task: copy },
          "done"
        ),
        true
      );
      assert.equal(lineAt(line), `- [x] Order events schema @est:6h @done:${TODAY} ^T104`);
      assert.ok(docText(M2).split("\n").includes(ORIGINAL), "the original is unchanged");
    });

    it("follows the copy a node shows when it got a new id, not the other copy", async () => {
      const api = await getApi();
      const { editor, line } = await pasteCopy();
      const copy = api.state.plan.file(M2)!.items.find((t) => t.line === line)!;
      // As the duplicate-id quick fix does, while a form or tree node still shows the copy.
      const at = editor.document.lineAt(line).text.indexOf("^T104");
      await editor.edit((b) => b.replace(new vscode.Range(line, at, line, at + 5), "^T999"));
      await waitFor(() => !api.state.plan.file(M2)!.items.includes(copy), "parsed again");
      assert.equal(await setStatusOf(copy, "done"), true);
      assert.equal(lineAt(line), `- [x] Order events schema @est:6h @done:${TODAY} ^T999`);
      assert.ok(docText(M2).split("\n").includes(ORIGINAL), "the original is unchanged");
    });

    it("does not take the original for a copy deleted while a form or a node shows it", async () => {
      const api = await getApi();
      const { editor, line } = await pasteCopy();
      const copy = api.state.plan.file(M2)!.items.find((t) => t.line === line)!;
      await editor.edit((b) => b.delete(new vscode.Range(line, 0, line + 1, 0)));
      await waitFor(
        () => api.state.plan.tasks.filter((t) => t.id === "T104").length === 1,
        "parsed again"
      );
      const before = docText(M2);
      assert.equal(await setStatusOf(copy, "done"), false);
      assert.equal(docText(M2), before);
      assert.equal(currentTask(api.state.plan, copy, api.service), undefined);
    });

    it("does not take the original in another file for a deleted copy", async () => {
      const api = await getApi();
      const M1 = "milestones/M1-discovery-design.md";
      const original =
        "- [ ] Internal review of the specification @est:4h @owner:sam @dep:T006 #review ^T011";
      const editor = await openPlanFile(M2);
      const pos = await positionOf(M2, "## Notes");
      await editor.edit((b) => b.insert(pos, `${original}\n\n`));
      const copies = () => api.state.plan.tasks.filter((t) => t.id === "T011");
      await waitFor(() => copies().length === 2, "copy indexed");
      const copy = copies().find((t) => t.file === M2)!;
      await editor.edit((b) => b.delete(new vscode.Range(pos.line, 0, pos.line + 1, 0)));
      await waitFor(() => copies().length === 1, "parsed again");
      const before = docText(M1);
      assert.equal(await setStatusOf(copy, "done"), false);
      assert.equal(docText(M1), before);
    });

    it("does not take the original in a file only read from disk for a deleted copy", async () => {
      const api = await getApi();
      // A milestone file that VS Code never opens: the planner reads it from disk.
      const M9 = "milestones/M9-spare.md";
      const file = planUri(M9).fsPath;
      const original = "- [ ] Spare part @est:2h ^T777";
      writeFileSync(file, `# M9 – Spare\n\n${original}\n`);
      try {
        await waitFor(() => api.state.plan.taskById("T777"), "read from disk");
        const editor = await openPlanFile(M2);
        const pos = await positionOf(M2, "## Notes");
        await editor.edit((b) => b.insert(pos, `${original}\n\n`));
        const copies = () => api.state.plan.tasks.filter((t) => t.id === "T777");
        await waitFor(() => copies().length === 2, "copy indexed");
        const copy = copies().find((t) => t.file === M2)!;
        await editor.edit((b) => b.delete(new vscode.Range(pos.line, 0, pos.line + 1, 0)));
        await waitFor(() => copies().length === 1, "parsed again");
        assert.equal(await setStatusOf(copy, "done"), false);
        assert.equal(readFileSync(file, "utf8"), `# M9 – Spare\n\n${original}\n`);
        assert.ok(!vscode.workspace.textDocuments.some((d) => d.uri.fsPath === file));
      } finally {
        rmSync(file, { force: true });
        await waitFor(() => !api.state.plan.file(M9), "removed");
      }
    });

    it("follows a copy cut and pasted elsewhere in its file, not the original", async () => {
      const api = await getApi();
      const { editor, line } = await pasteCopy();
      const copy = api.state.plan.file(M2)!.items.find((t) => t.line === line)!;
      await editor.edit((b) => b.delete(new vscode.Range(line, 0, line + 1, 0)));
      const billing = await positionOf(M2, "## Billing");
      await editor.edit((b) => b.insert(billing, `${COPY}\n`));
      await waitFor(() => !api.state.plan.file(M2)!.items.includes(copy), "parsed again");
      assert.equal(await setStatusOf(copy, "done"), true);
      assert.equal(lineAt(billing.line), `- [x] Order events schema @est:6h @done:${TODAY} ^T104`);
      assert.ok(docText(M2).split("\n").includes(ORIGINAL), "the original is unchanged");
    });

    it("acts on the line left as it was after Copy Line Down, not on the copy edited below", async () => {
      const api = await getApi();
      const node = api.state.plan.taskById("T104")!;
      const editor = await openPlanFile(M2);
      // Copy Line Down puts the copy above the line and the cursor below, on the line people then
      // edit as the copy: which one the node shows cannot be told from the edits.
      await editor.edit((b) => b.insert(new vscode.Position(node.line, 0), `${ORIGINAL}\n`));
      const below = node.line + 1;
      const from = lineAt(below).indexOf("Order");
      await editor.edit((b) =>
        b.replace(new vscode.Range(below, from, below, from + 5), "Payment")
      );
      await waitFor(
        () => api.state.plan.file(M2)!.items.some((t) => t.title === "Payment events schema"),
        "parsed again"
      );
      assert.equal(await setStatusOf(node, "done"), true);
      assert.equal(lineAt(node.line), `  - [x] Order events schema @est:6h @done:${TODAY} ^T104`);
      assert.match(lineAt(below), /^ {2}- \[ \] Payment events schema @est:6h \^T\d+$/);
    });

    it("gives copies that share an id rows of their own in the Milestones view", async () => {
      const api = await getApi();
      await pasteCopy();
      const copies = api.state.plan.file(M2)!.items.filter((t) => t.id === "T104");
      const items = copies.map((task) =>
        api.milestones.getTreeItem({ kind: "task", task } as MilestoneNode)
      );
      assert.equal(new Set(items.map((i) => i.id)).size, 2);
      assert.deepEqual(
        items.map((i) => i.command?.arguments?.[0]),
        copies.map((t) => ({ file: M2, line: t.line }))
      );
    });

    it("finds the copy an out-of-date tree node shows after a line typed above it", async () => {
      const api = await getApi();
      const { editor, line } = await pasteCopy();
      const copy = api.state.plan.file(M2)!.items.find((t) => t.line === line)!;
      // A line typed above it before the tree shows the change: the node's line is out of date.
      await editor.edit((b) =>
        b.insert(new vscode.Position(line, 0), "- [ ] Typed above @est:1h\n")
      );
      await waitFor(() => !api.state.plan.file(M2)!.items.includes(copy), "parsed again");
      assert.equal(await setStatusOf(copy, "done"), true);
      assert.match(lineAt(line), /^- \[ \] Typed above @est:1h \^T\d+$/);
      assert.equal(lineAt(line + 1), `- [x] Order events schema @est:6h @done:${TODAY} ^T104`);
      assert.ok(docText(M2).split("\n").includes(ORIGINAL), "the original is unchanged");
    });

    it("sets the status of the hovered copy as an editor edit, without saving", async () => {
      const { editor, line } = await pasteCopy();
      const disk = readFileSync(planUri(M2).fsPath, "utf8");
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        planUri(M2),
        new vscode.Position(line, 3)
      );
      const text = hovers
        .flatMap((h) => h.contents.map((c) => (c as vscode.MarkdownString).value))
        .join("\n");
      const link = /\[\$\([\w-]+\) Done\]\(command:planner\.setStatus\?(\S+) "/.exec(text);
      assert.ok(link, text);
      const args = JSON.parse(decodeURIComponent(link[1])) as unknown[];
      assert.equal(await vscode.commands.executeCommand("planner.setStatus", ...args), true);
      assert.equal(lineAt(line), `- [x] Order events schema @est:6h @done:${TODAY} ^T104`);
      assert.ok(docText(M2).split("\n").includes(ORIGINAL), "the original is unchanged");
      assert.ok(editor.document.isDirty, "a change from the editor is not saved");
      assert.equal(readFileSync(planUri(M2).fsPath, "utf8"), disk);
    });

    it("edits the copy in the task form, not the original", async () => {
      const { line } = await pasteCopy();
      const change = { status: "doing", attrs: { owner: "sam" } };
      assert.equal(
        await vscode.commands.executeCommand("planner.editTask", { file: M2, line }, change),
        true
      );
      assert.equal(
        lineAt(line),
        `- [/] Order events schema @est:6h @owner:sam @started:${TODAY} ^T104`
      );
      assert.ok(docText(M2).split("\n").includes(ORIGINAL), "the original is unchanged");
    });
  });

  it("finds a task again after a save gave it an id and a line was typed above it", async () => {
    const api = await getApi();
    const editor = await openPlanFile(M2);
    const pos = await positionOf(M2, "## Notes");
    await editor.edit((b) =>
      b.insert(pos, "- [ ] Fresh task @est:4h\n- [ ] Next task @est:1h\n\n")
    );
    const items = () => api.state.plan.file(M2)!.items;
    const fresh = await waitFor(() => items().find((t) => t.title === "Fresh task"), "indexed");
    const next = items().find((t) => t.title === "Next task")!;
    await editor.document.save();
    const saved = await waitFor(
      () => items().find((t) => t.line === pos.line && t.id),
      "id given on save"
    );
    assert.equal(currentTask(api.state.plan, fresh, api.service), saved);
    assert.equal(currentTask(api.state.plan, fresh, undefined), saved);
    // Typed above it: followed to its new line. Without the edits (a file changed on disk), its
    // line holds another task now, which is not taken for it.
    await editor.edit((b) => b.insert(pos, "- [ ] Typed above @est:1h\n"));
    await waitFor(() => items().some((t) => t.title === "Typed above"), "parsed again");
    const moved = items().find((t) => t.line === pos.line + 2)!;
    assert.equal(moved.title, "Next task");
    assert.equal(currentTask(api.state.plan, next, api.service), moved);
    assert.equal(currentTask(api.state.plan, next, undefined), undefined);
  });

  it("finds a copy again after a save gave it a new id, and no task in its place", async () => {
    const api = await getApi();
    const editor = await openPlanFile(M2);
    const pos = await positionOf(M2, "## Notes");
    // A copy of T104 made into another task, and two tasks with one title.
    await editor.edit((b) =>
      b.insert(
        pos,
        "- [ ] Payment events schema @est:6h ^T104\n" +
          "- [ ] Review @est:1h ^T150\n- [ ] Review @est:1h ^T151\n\n"
      )
    );
    const items = () => api.state.plan.file(M2)!.items;
    const copy = await waitFor(
      () => items().find((t) => t.title === "Payment events schema"),
      "indexed"
    );
    const review = items().find((t) => t.id === "T150")!;
    await editor.document.save();
    const renumbered = await waitFor(
      () => items().find((t) => t.line === pos.line && t.id !== "T104"),
      "new id given on save"
    );
    assert.equal(currentTask(api.state.plan, copy, api.service), renumbered);
    assert.equal(currentTask(api.state.plan, copy, undefined), renumbered);
    // Deleted: the task with its title that moved onto its line has another id, used once.
    await editor.edit((b) => b.delete(new vscode.Range(pos.translate(1), pos.translate(2))));
    await waitFor(() => !items().some((t) => t.id === "T150"), "parsed again");
    assert.equal(items().find((t) => t.line === review.line)?.id, "T151");
    assert.equal(currentTask(api.state.plan, review, api.service), undefined);
    assert.equal(currentTask(api.state.plan, review, undefined), undefined);
  });

  it("finds a task without an id that moved, not the task with its title now on its line", async () => {
    const api = await getApi();
    const editor = await openPlanFile(M2);
    const pos = await positionOf(M2, "## Notes");
    await editor.edit((b) =>
      b.insert(
        pos,
        "- [ ] Typed first @est:1h\n- [ ] Review @est:1h\n- [ ] Review @est:1h ^T150\n\n"
      )
    );
    const items = () => api.state.plan.file(M2)!.items;
    const review = () => items().find((t) => t.title === "Review" && !t.id);
    const captured = await waitFor(review, "indexed");
    // The line above it is deleted: the task with the same title and an id moves onto its line.
    await editor.edit((b) => b.delete(new vscode.Range(pos, pos.translate(1))));
    await waitFor(() => !items().some((t) => t.title === "Typed first"), "parsed again");
    assert.equal(items().find((t) => t.line === captured.line)?.id, "T150");
    assert.equal(currentTask(api.state.plan, captured, api.service), review());
    assert.equal(currentTask(api.state.plan, captured, undefined), review());
  });

  it("takes an out-of-date tree node's task on its new line, not the task now on its line", async () => {
    const api = await getApi();
    const editor = await openPlanFile(M2);
    const pos = await positionOf(M2, "## Notes");
    await editor.edit((b) => b.insert(pos, "- [ ] Review @est:1h\n- [ ] Review @est:1h\n\n"));
    const items = () => api.state.plan.file(M2)!.items;
    const node = await waitFor(() => items().find((t) => t.line === pos.line), "indexed");
    // A line typed above before the tree shows the change: the node's line holds that one now.
    await editor.edit((b) => b.insert(pos, "- [ ] Typed above @est:1h\n"));
    await waitFor(() => items().some((t) => t.title === "Typed above"), "parsed again");
    assert.equal(await setStatusOf(node, "done"), true);
    // Saved: every task without an id got one.
    const lines = docText(M2).split("\n");
    assert.match(lines[pos.line], /^- \[ \] Typed above @est:1h \^T\d+$/);
    assert.match(
      lines[pos.line + 1],
      new RegExp(`^- \\[x\\] Review @est:1h @done:${TODAY} \\^T\\d+$`)
    );
    assert.match(lines[pos.line + 2], /^- \[ \] Review @est:1h \^T\d+$/);
  });

  it("tells two copies with one id and title apart after a line typed above them", async () => {
    const api = await getApi();
    const editor = await openPlanFile(M2);
    const pos = await positionOf(M2, "## Notes");
    const done = "- [x] Review @est:1h @done:2026-10-01 ^T150";
    await editor.edit((b) => b.insert(pos, `${done}\n- [ ] Review @est:1h ^T150\n\n`));
    const items = () => api.state.plan.file(M2)!.items;
    const node = await waitFor(() => items().find((t) => t.line === pos.line + 1), "indexed");
    // A line typed above both before the tree shows it (or while a form is open on the to-do copy):
    // the done copy is on the node's line now. Without the edits the copies cannot be told apart.
    await editor.edit((b) => b.insert(pos, "Typed above.\n"));
    await waitFor(() => !items().includes(node), "parsed again");
    assert.equal(items().find((t) => t.line === node.line)?.status, "done");
    const moved = items().find((t) => t.line === pos.line + 2)!;
    assert.equal(currentTask(api.state.plan, node, api.service), moved);
    assert.equal(currentTask(api.state.plan, node, undefined), undefined);
    assert.equal(await setStatusOf(node, "doing"), true);
    const lines = docText(M2).split("\n");
    assert.equal(lines[pos.line + 1], done);
    assert.equal(lines[pos.line + 2], `- [/] Review @est:1h @started:${TODAY} ^T150`);
  });

  it("tells two copies without an id apart after a line typed above them and a save", async () => {
    const api = await getApi();
    const editor = await openPlanFile(M2);
    const pos = await positionOf(M2, "## Notes");
    await editor.edit((b) => b.insert(pos, "- [ ] Review @est:1h\n- [ ] Review @est:1h\n\n"));
    const items = () => api.state.plan.file(M2)!.items;
    const node = await waitFor(() => items().find((t) => t.line === pos.line + 1), "indexed");
    // A line typed above both, then saved: the node's line holds the other copy, with an id now.
    await editor.edit((b) => b.insert(pos, "Typed above.\n"));
    await editor.document.save();
    const reviews = () => items().filter((t) => t.title === "Review" && t.id);
    await waitFor(() => reviews().length === 2, "ids given on save");
    assert.equal(
      items().find((t) => t.line === node.line),
      reviews()[0]
    );
    assert.equal(currentTask(api.state.plan, node, api.service), reviews()[1]);
    assert.equal(currentTask(api.state.plan, node, undefined), undefined);
  });

  it("adds the plan folder to .prettierignore with an edit that can be undone", async () => {
    const api = await getApi();
    const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, ".prettierignore");
    try {
      // No file yet: it is created with the plan folder.
      await api.formatGuard.addToPrettierIgnore();
      assert.equal(readFileSync(uri.fsPath, "utf8"), "plan/\n");
      // An open file without a final line ending: the folder goes on a line of its own, the
      // editor shows it, and the file is saved.
      const doc = await vscode.workspace.openTextDocument(uri);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), "node_modules");
      assert.ok(await vscode.workspace.applyEdit(edit));
      await doc.save();
      await vscode.window.showTextDocument(doc);
      // It is an edit of the document, which Undo takes back like typing: the document changes
      // before the file does, not after the file was written behind its back. (Undo itself only
      // reaches the document while the window has the focus.)
      const changes: { text: string; onDisk: string }[] = [];
      const listening = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === doc)
          for (const c of e.contentChanges)
            changes.push({ text: c.text, onDisk: readFileSync(uri.fsPath, "utf8") });
      });
      try {
        await api.formatGuard.addToPrettierIgnore();
      } finally {
        listening.dispose();
      }
      assert.deepEqual(changes, [{ text: "\nplan/\n", onDisk: "node_modules" }]);
      assert.equal(doc.getText(), "node_modules\nplan/\n");
      assert.ok(!doc.isDirty);
      assert.equal(readFileSync(uri.fsPath, "utf8"), "node_modules\nplan/\n");
      // Already there: nothing changes.
      await api.formatGuard.addToPrettierIgnore();
      assert.equal(doc.getText(), "node_modules\nplan/\n");
    } finally {
      // Closing a dirty editor would ask whether to save it.
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
      if (doc?.isDirty) await doc.save();
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      const remove = new vscode.WorkspaceEdit();
      remove.deleteFile(uri, { ignoreIfNotExists: true });
      await vscode.workspace.applyEdit(remove);
    }
  });

  it("shows CodeLens above milestone headings", async () => {
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      "vscode.executeCodeLensProvider",
      planUri(M2),
      10
    );
    const heading = lenses.find((l) => l.range.start.line === 0)!;
    assert.match(
      heading.command!.title,
      /^\d+\/\d+ tasks · \d+% · forecast 2026-11-24 · 15 d ahead$/
    );
  });

  it("creates a new project from the software template", async () => {
    const folder = vscode.Uri.file(mkdtempSync(join(tmpdir(), "planner-new-")));
    const root = await vscode.commands.executeCommand<vscode.Uri>("planner.newProject", {
      name: "Mobile App 2",
      code: "P-2027-001",
      start: "2027-01-04",
      end: "2027-06-30",
      template: "software",
      lead: "Robin Lee",
      folder,
    });
    assert.ok(root);
    const project = readFileSync(join(root.fsPath, "project.md"), "utf8");
    assert.match(
      project,
      /^# Mobile App 2\n\ncode: P-2027-001\nstart: 2027-01-04\nend: 2027-06-30\n/
    );
    const team = readFileSync(join(root.fsPath, "team.md"), "utf8");
    assert.match(team, /## Robin Lee\n\nid: robin-lee\n/);
    const m1 = readFileSync(join(root.fsPath, "milestones/M1-discovery-design.md"), "utf8");
    assert.match(m1, /target: 2027-01-30|target: 2027-01-29/);
    for (const f of [
      "inbox.md",
      "punchlist.md",
      ".gitignore",
      "tests/UAT-01.md",
      "milestones/M5-launch.md",
    ]) {
      assert.ok(existsSync(join(root.fsPath, f)), f);
    }
    assert.doesNotMatch(m1 + project + team, /\{\{/);
    // Agents can use the new plan right away: .mcp.json names the md-planner server.
    const mcp = JSON.parse(readFileSync(join(folder.fsPath, ".mcp.json"), "utf8"));
    const server = mcp.mcpServers["md-planner"];
    assert.equal(server.type, "stdio");
    assert.deepEqual(server.args.slice(1), ["--plan", root.fsPath, "--workspace", folder.fsPath]);
    assert.match(server.args[0], /mcp-server\.js$/);
    // And the skill that tells them how to work with it.
    const extension = vscode.extensions.getExtension("acro.md-planner")!;
    assert.equal(
      readFileSync(join(folder.fsPath, ".claude/skills/md-planner/SKILL.md"), "utf8"),
      readFileSync(join(extension.extensionPath, "skills/md-planner/SKILL.md"), "utf8")
    );
  });
});

describe("custom templates", () => {
  after(async () => {
    await vscode.workspace
      .getConfiguration("planner")
      .update("templatesFolder", undefined, vscode.ConfigurationTarget.Workspace);
  });

  it("uses templates from planner.templatesFolder", async () => {
    const templates = mkdtempSync(join(tmpdir(), "planner-templates-"));
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(templates, "mini", "milestones"), { recursive: true });
    writeFileSync(
      join(templates, "mini", "project.md"),
      "# {{name}}\n\nstart: {{start}}\nend: {{end}}\n"
    );
    writeFileSync(
      join(templates, "mini", "milestones", "M1-only.md"),
      "# M1 – Only\n\nid: M1\ntarget: {{date:0.5}}\n"
    );
    await vscode.workspace
      .getConfiguration("planner")
      .update("templatesFolder", templates, vscode.ConfigurationTarget.Workspace);
    const folder = vscode.Uri.file(mkdtempSync(join(tmpdir(), "planner-new-")));
    const root = await vscode.commands.executeCommand<vscode.Uri>("planner.newProject", {
      name: "Mini",
      code: "",
      start: "2027-01-04",
      end: "2027-01-15",
      template: "mini",
      lead: "",
      folder,
    });
    assert.ok(root);
    assert.equal(
      readFileSync(join(root.fsPath, "milestones/M1-only.md"), "utf8"),
      "# M1 – Only\n\nid: M1\ntarget: 2027-01-08\n"
    );
  });
});
