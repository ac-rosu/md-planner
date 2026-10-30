// Settings and files people get wrong: .mcp.json open with unsaved changes or customised, a plan
// folder written as ./plan or as an absolute path, an empty plan folder, New project into a folder
// with plan files, odd custom templates, a broken .vscode/settings.json, settings typed as text,
// `.claude` as a file, and a plan file renamed and renamed back.
import * as assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { rollUpParents } from "../../src/extension/commands/status";
import { docText, getApi, planUri, restorePlan, waitFor, workspaceDir } from "./helpers";

const M2 = "milestones/M2-backend.md";
const MIN = 60_000;
const HOUR = 60 * MIN;

const planner = () => vscode.workspace.getConfiguration("planner");
const setting = (key: string, value: unknown) =>
  planner().update(key, value, vscode.ConfigurationTarget.Workspace);
const run = <T>(command: string, ...args: unknown[]) =>
  vscode.commands.executeCommand<T>(command, ...args);

type Kind = "showWarningMessage" | "showErrorMessage" | "showInformationMessage";

/**
 * Runs `f` with the messages of the given kind answered in order by `answers` (undefined
 * dismisses one); returns the arguments each was shown with.
 */
async function answering(
  kind: Kind,
  answers: Array<string | undefined>,
  f: () => Thenable<unknown>
): Promise<unknown[][]> {
  const window = vscode.window as unknown as Record<Kind, (...args: unknown[]) => unknown>;
  const original = window[kind];
  const shown: unknown[][] = [];
  window[kind] = (...args: unknown[]) => {
    shown.push(args);
    return Promise.resolve(answers.shift());
  };
  try {
    await f();
  } finally {
    window[kind] = original;
  }
  return shown;
}

/** Deletes workspace files and folders (closing the editors first). */
async function remove(...rels: string[]): Promise<void> {
  await run("workbench.action.closeAllEditors");
  for (const rel of rels) rmSync(join(workspaceDir(), rel), { recursive: true, force: true });
}

/** Back to the sample plan in plan/ after a test pointed planner.planFolder elsewhere. */
async function backToSample(): Promise<void> {
  const api = await getApi();
  await setting("planFolder", undefined);
  await waitFor(
    () => api.service.root?.fsPath === join(workspaceDir(), "plan") && api.service.hasPlan,
    "the sample plan located again"
  );
  await restorePlan();
}

describe("Careless configuration", () => {
  before(async () => {
    await getApi();
    await restorePlan();
  });

  describe("Configure MCP", () => {
    after(() => remove(".mcp.json", ".claude"));

    it("keeps unsaved edits of an open .mcp.json and the user's own entry settings", async () => {
      const file = vscode.Uri.file(join(workspaceDir(), ".mcp.json"));
      writeFileSync(
        file.fsPath,
        JSON.stringify(
          {
            mcpServers: {
              "md-planner": {
                command: "/old/node",
                args: ["/old/server.js", "--plan", "/old/plan"],
                env: { ELECTRON_RUN_AS_NODE: "1", HTTP_PROXY: "http://proxy:8080" },
                disabled: true,
              },
            },
          },
          null,
          2
        ) + "\n"
      );
      const doc = await vscode.workspace.openTextDocument(file);
      const editor = await vscode.window.showTextDocument(doc);
      // An unsaved edit: another server added by hand.
      await editor.edit((b) =>
        b.insert(
          doc.positionAt(doc.getText().indexOf('"md-planner"')),
          '"other": { "command": "x" },\n    '
        )
      );
      assert.ok(doc.isDirty);
      await answering("showInformationMessage", [], () => run("planner.configureMcp"));
      const saved = JSON.parse(readFileSync(file.fsPath, "utf8"));
      assert.deepEqual(saved.mcpServers.other, { command: "x" });
      const entry = saved.mcpServers["md-planner"];
      assert.equal(entry.disabled, true);
      assert.equal(entry.env.HTTP_PROXY, "http://proxy:8080");
      assert.equal(entry.type, "stdio");
      assert.deepEqual(entry.args.slice(1), [
        "--plan",
        join(workspaceDir(), "plan"),
        "--workspace",
        workspaceDir(),
      ]);
      assert.equal(doc.isDirty, false);
    });
  });

  describe("planner.planFolder", () => {
    afterEach(async () => {
      await remove(".mcp.json", ".claude", "later-plan", "empty-plan");
      await backToSample();
    });

    it("notices a plan created later in ./later-plan", async () => {
      const api = await getApi();
      await setting("planFolder", "./later-plan");
      await waitFor(() => api.service.root === undefined, "no plan folder");
      // Created outside VS Code (git, an agent through the MCP server).
      mkdirSync(join(workspaceDir(), "later-plan"));
      writeFileSync(
        join(workspaceDir(), "later-plan", "project.md"),
        "# Later\n\nstart: 2026-10-01\nend: 2026-12-18\n"
      );
      await waitFor(
        () =>
          api.service.root?.fsPath === join(workspaceDir(), "later-plan") && api.service.hasPlan,
        "the new plan noticed"
      );
    });

    it("is no plan while the plan folder is empty, and is one once it has a project.md", async () => {
      const api = await getApi();
      mkdirSync(join(workspaceDir(), "empty-plan"));
      await setting("planFolder", "empty-plan");
      await waitFor(
        () => api.service.root?.fsPath === join(workspaceDir(), "empty-plan"),
        "the empty plan folder located"
      );
      assert.equal(api.service.hasPlan, false);
      writeFileSync(
        join(workspaceDir(), "empty-plan", "project.md"),
        "# Now\n\nstart: 2026-10-01\n"
      );
      await waitFor(() => api.service.hasPlan, "project.md noticed");
    });

    it("creates the new project in an absolute plan folder, not below the workspace", async () => {
      const api = await getApi();
      const abs = join(mkdtempSync(join(tmpdir(), "planner-abs-")), "myplan");
      await setting("planFolder", abs);
      await waitFor(() => api.service.root === undefined, "no plan folder");
      let root: vscode.Uri | undefined;
      await answering("showInformationMessage", [], async () => {
        root = await run<vscode.Uri>("planner.newProject", {
          name: "Absolute",
          code: "",
          start: "2027-01-04",
          end: "2027-03-31",
          template: "blank",
          lead: "",
        });
      });
      assert.equal(root?.fsPath, abs);
      assert.equal(api.service.root?.fsPath, abs);
      assert.ok(existsSync(join(abs, "project.md")));
      assert.equal(existsSync(join(workspaceDir(), abs)), false);
      const mcp = JSON.parse(readFileSync(join(workspaceDir(), ".mcp.json"), "utf8"));
      assert.deepEqual(mcp.mcpServers["md-planner"].args.slice(1, 3), ["--plan", abs]);
    });
  });

  describe("New project", () => {
    after(() => setting("templatesFolder", undefined));

    it("asks before adding a template to plan files that are there; no keeps them alone", async () => {
      const folder = mkdtempSync(join(tmpdir(), "planner-partial-"));
      const mine = "# M1 – Mine\n\nid: M1\n\n- [ ] My task ^T1\n";
      mkdirSync(join(folder, "plan", "milestones"), { recursive: true });
      writeFileSync(join(folder, "plan", "milestones", "M1-mine.md"), mine);
      writeFileSync(join(folder, "plan", "team.md"), "# Team\n\n## Kim\n\nid: kim\n");
      const options = {
        name: "Partial",
        code: "",
        start: "2027-01-04",
        end: "2027-06-30",
        template: "software",
        lead: "",
        folder: vscode.Uri.file(folder),
      };
      const asked = await answering("showWarningMessage", [undefined], async () =>
        assert.equal(await run("planner.newProject", options), undefined)
      );
      assert.match(
        String(asked[0][0]),
        /plan\/ already has plan files \(milestones\/M1-mine\.md, team\.md\)/
      );
      assert.match(
        (asked[0][1] as { detail: string }).detail,
        /Added: .*milestones\/M1-discovery-design\.md.*project\.md/
      );
      assert.equal(existsSync(join(folder, "plan", "project.md")), false);
      // Yes: the files that are missing are added; the user's files stay as they are.
      await answering("showInformationMessage", [], () =>
        run("planner.newProject", { ...options, addToExisting: true })
      );
      assert.ok(existsSync(join(folder, "plan", "project.md")));
      assert.equal(readFileSync(join(folder, "plan", "milestones", "M1-mine.md"), "utf8"), mine);
      assert.match(readFileSync(join(folder, "plan", "team.md"), "utf8"), /## Kim/);
    });

    it("works with a templatesFolder that is a file, and copies only a template's Markdown", async () => {
      const templates = mkdtempSync(join(tmpdir(), "planner-templates-"));
      writeFileSync(join(templates, "notes.txt"), "not a folder");
      await setting("templatesFolder", join(templates, "notes.txt"));
      const blank = mkdtempSync(join(tmpdir(), "planner-new-"));
      const warned = await answering("showWarningMessage", [], () =>
        answering("showInformationMessage", [], () =>
          run("planner.newProject", {
            name: "Blank",
            code: "",
            start: "2027-01-04",
            end: "2027-02-26",
            template: "blank",
            lead: "",
            folder: vscode.Uri.file(blank),
          })
        )
      );
      assert.ok(existsSync(join(blank, "plan", "project.md")));
      assert.match(String(warned[0][0]), /planner\.templatesFolder .* is not a folder/);

      mkdirSync(join(templates, "mini", ".git"), { recursive: true });
      mkdirSync(join(templates, ".git"));
      writeFileSync(join(templates, ".git", "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(templates, "mini", ".git", "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(templates, "mini", ".DS_Store"), Buffer.from([0, 1, 255]));
      writeFileSync(join(templates, "mini", "logo.png"), Buffer.from([137, 80, 78, 71, 255, 0]));
      writeFileSync(join(templates, "mini", "project.md"), "# {{name}}\n\nstart: {{start}}\n");
      await setting("templatesFolder", templates);
      const { listTemplates } = await import("../../src/extension/commands/newProject");
      const ext = vscode.extensions.getExtension("acro.md-planner")!;
      const names = (
        await listTemplates({ extensionUri: ext.extensionUri } as vscode.ExtensionContext)
      ).map((t) => t.name);
      assert.ok(names.includes("mini"));
      assert.ok(!names.includes(".git"));
      const folder = mkdtempSync(join(tmpdir(), "planner-new-"));
      await answering("showInformationMessage", [], () =>
        run("planner.newProject", {
          name: "Mini",
          code: "",
          start: "2027-01-04",
          end: "2027-02-26",
          template: "mini",
          lead: "",
          folder: vscode.Uri.file(folder),
        })
      );
      assert.ok(existsSync(join(folder, "plan", "project.md")));
      for (const junk of [".DS_Store", "logo.png", ".git"])
        assert.equal(existsSync(join(folder, "plan", junk)), false, junk);
    });
  });

  describe("settings typed carelessly", () => {
    afterEach(async () => {
      for (const key of [
        "parentStatus",
        "scheduling.unassignedCapacity",
        "time.roundingMinutes",
        "todos.include",
        "todos.keywords",
      ])
        await setting(key, undefined);
      const api = await getApi();
      const running = api.timer.running;
      if (running) {
        api.timer.now = () => running.startedAt + 30_000;
        await run("planner.stopTimer");
      }
      api.timer.now = () => Date.now();
      await restorePlan();
    });

    it("reads a parentStatus that is neither auto nor off as auto, as the MCP server does", async () => {
      assert.equal(rollUpParents(), true);
      await setting("parentStatus", "on");
      assert.equal(rollUpParents(), true);
      await setting("parentStatus", true);
      assert.equal(rollUpParents(), true);
      await setting("parentStatus", "off");
      assert.equal(rollUpParents(), false);
    });

    it("reads an unassignedCapacity of 40h as 40", async () => {
      const api = await getApi();
      await setting("scheduling.unassignedCapacity", "40h");
      assert.equal(api.state.scheduleOptions().unassignedCapacity, 40);
      await setting("scheduling.unassignedCapacity", 24);
      assert.equal(api.state.scheduleOptions().unassignedCapacity, 24);
      await setting("scheduling.unassignedCapacity", "lots");
      assert.equal(api.state.scheduleOptions().unassignedCapacity, 40);
    });

    it("logs time with a roundingMinutes of 15m or 900 without corrupting @act", async () => {
      const api = await getApi();
      const start = new Date(2026, 9, 14, 9, 0).getTime();
      const line = () =>
        docText(M2)
          .split("\n")
          .find((l) => l.endsWith("^T121"))!;
      await setting("time.roundingMinutes", "15m");
      api.timer.now = () => start;
      assert.equal(await run("planner.startTimer", "T121"), true);
      api.timer.now = () => start + 7 * MIN;
      assert.equal(await run("planner.stopTimer"), 0.25);
      assert.match(line(), /@act:0\.25h/);
      // 900 (seconds typed as minutes): an hour at most, not 15 hours.
      await setting("time.roundingMinutes", 900);
      api.timer.now = () => start + HOUR;
      assert.equal(await run("planner.startTimer", "T121"), true);
      api.timer.now = () => start + HOUR + 7 * MIN;
      assert.equal(await run("planner.stopTimer"), 1);
      assert.match(line(), /@act:1\.25h/);
    });

    it("asks when the rounded time is more than a working day", async () => {
      const api = await getApi();
      // A 7.5-hour day: 7h 10m rounded up to the hour is 8 hours.
      const project = await vscode.workspace.openTextDocument(planUri("project.md"));
      const at = project.getText().indexOf("hoursPerDay: 8");
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        project.uri,
        new vscode.Range(project.positionAt(at), project.positionAt(at + 14)),
        "hoursPerDay: 7.5"
      );
      assert.ok(await vscode.workspace.applyEdit(edit));
      await waitFor(() => api.service.plan.project.hoursPerDay === 7.5, "7.5 hours a day");
      await setting("time.roundingMinutes", 60);
      const start = new Date(2026, 9, 14, 8, 0).getTime();
      api.timer.now = () => start;
      assert.equal(await run("planner.startTimer", "T121"), true);
      api.timer.now = () => start + 7 * HOUR + 10 * MIN;
      const asked = await answering("showWarningMessage", ["Log 8h"], async () =>
        assert.equal(await run("planner.stopTimer"), 8)
      );
      assert.match(
        String(asked[0][0]),
        /ran for 7h 10m, which rounds up to 8h: more than a working day \(7\.5h\)/
      );
    });

    it("does not hang on a TODO glob with an unclosed {, and ignores an empty keyword", async () => {
      const api = await getApi();
      await setting("todos.include", "**/*.{ts,py");
      await setting("todos.keywords", ["TODO", ""]);
      await api.todoScanner.scanAll();
      // Typing in a source file matches it against the globs.
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(join(workspaceDir(), "src", "server", "payments.ts"))
      );
      const editor = await vscode.window.showTextDocument(doc);
      await editor.edit((b) => b.insert(new vscode.Position(0, 0), "// x\n"));
      await new Promise((r) => setTimeout(r, 600));
      await setting("todos.include", undefined);
      await api.todoScanner.scanAll();
      // The empty keyword does not make every line a TODO comment.
      const keywords = api.todoScanner.all.flatMap((f) => f.items.map((i) => i.keyword));
      assert.ok(keywords.length > 0);
      assert.deepEqual([...new Set(keywords)], ["TODO"]);
      await run("workbench.action.files.revert");
    });
  });

  it("formatting guard: says why format on save could not be turned off", async () => {
    const api = await getApi();
    const file = vscode.Uri.file(join(workspaceDir(), ".vscode", "settings.json"));
    const original = readFileSync(file.fsPath, "utf8");
    // Through VS Code, as a user would (a file written behind its model makes its next save hang).
    const write = async (text: string) => {
      const doc = await vscode.workspace.openTextDocument(file);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(file, new vscode.Range(0, 0, doc.lineCount, 0), text);
      assert.ok(await vscode.workspace.applyEdit(edit));
      assert.ok(await doc.save());
    };
    try {
      // A setting changed, and a comma too many with nothing after it.
      await write(original.replace('"alex"', '"zed"').replace(/\}\s*$/, "") + ',\n  "broken": \n');
      await waitFor(() => planner().get("me") === "zed", "the broken settings read");
      const shown = await answering("showErrorMessage", [undefined], async () =>
        assert.equal(await api.formatGuard.turnOffFormatOnSave(), false)
      );
      assert.match(String(shown[0][0]), /could not turn off format on save for Markdown/);
      assert.equal(shown[0][1], "Open Workspace Settings");
    } finally {
      await write(original);
      await waitFor(() => planner().get("me") === "alex", "the settings read again");
      await run("workbench.action.closeAllEditors");
    }
  });

  it("says why the skill cannot be added when .claude is a file", async () => {
    await getApi();
    const file = join(workspaceDir(), ".claude");
    rmSync(file, { recursive: true, force: true });
    writeFileSync(file, "not a folder\n");
    try {
      const shown = await answering("showErrorMessage", [], async () =>
        assert.equal(await run("planner.addAgentSkill"), undefined)
      );
      assert.match(String(shown[0][0]), /\.claude is a file, not a folder/);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("does not hold a renamed-and-renamed-back file twice", async () => {
    const api = await getApi();
    // A file of its own: VS Code's local history keeps following a renamed document.
    const rel = "milestones/M8-rename.md";
    const renamed = "milestones/M8-renamed.md";
    const from = planUri(rel);
    const to = planUri(renamed);
    try {
      const create = new vscode.WorkspaceEdit();
      create.createFile(from, {
        contents: Buffer.from("# M8 – Rename\n\nid: M8\n\n- [ ] Moved around @est:1h ^T980\n"),
      });
      assert.ok(await vscode.workspace.applyEdit(create));
      await waitFor(() => api.service.index.has(rel), "M8 read");
      const before = api.service.plan.tasks.length;
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(from));
      for (const [a, b] of [
        [from, to],
        [to, from],
      ]) {
        const edit = new vscode.WorkspaceEdit();
        edit.renameFile(a, b);
        assert.ok(await vscode.workspace.applyEdit(edit));
      }
      await waitFor(() => api.service.index.has(rel), "M8 back");
      // Once VS Code's events of the renames arrived, the plan has the file once.
      await waitFor(() => !api.service.index.has(renamed), "the renamed copy dropped", 2000);
      for (let i = 0; i < 20; i++) {
        assert.equal(api.service.index.has(renamed), false);
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(api.service.plan.tasks.length, before);
    } finally {
      await run("workbench.action.closeAllEditors");
      for (const uri of [from, to]) rmSync(uri.fsPath, { force: true });
      await waitFor(() => !api.service.index.has(rel), "M8 gone");
      await restorePlan();
    }
  });

  it("leaves out an open document whose file is gone, unless it has unsaved changes", async () => {
    const api = await getApi();
    const rel = "milestones/M9-ghost.md";
    const uri = planUri(rel);
    // A file event that arrives late (the create event of a rename, read after the rename back)
    // reads the file again: it is gone, and its open document, unchanged, is no reason to keep it.
    const late = (api.service as unknown as { reloadFromDisk(u: vscode.Uri): Promise<void> })
      .reloadFromDisk;
    try {
      writeFileSync(uri.fsPath, "# M9 – Ghost\n\nid: M9\n\n- [ ] Haunting @est:1h ^T990\n");
      await waitFor(() => api.service.index.has(rel), "M9 read");
      const doc = await vscode.workspace.openTextDocument(uri);
      rmSync(uri.fsPath);
      await waitFor(() => !api.service.index.has(rel), "M9 dropped");
      assert.ok(!doc.isClosed && !doc.isDirty);
      await late.call(api.service, uri);
      assert.equal(api.service.index.has(rel), false);
      assert.equal(api.service.plan.taskById("T990"), undefined);
    } finally {
      rmSync(uri.fsPath, { force: true });
      await restorePlan();
    }
  });
});
