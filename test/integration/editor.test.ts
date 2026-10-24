import * as assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
