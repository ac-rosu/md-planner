import * as assert from "node:assert/strict";
import * as vscode from "vscode";
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

const TEAM = "team.md";
const PUNCH = "punchlist.md";
const M1 = "milestones/M1-discovery-design.md";
const M2 = "milestones/M2-backend.md";

/** The planner diagnostic with this code on a line, once it is published. */
function diagnosticOn(rel: string, code: string, line: number): Promise<vscode.Diagnostic> {
  return waitFor(
    () =>
      vscode.languages
        .getDiagnostics(planUri(rel))
        .find((d) => d.code === code && d.range.start.line === line),
    `${code} on line ${line} of ${rel}`
  );
}

function noDiagnostic(rel: string, code: string): Promise<boolean> {
  return waitFor(
    () => !vscode.languages.getDiagnostics(planUri(rel)).some((d) => d.code === code),
    `no ${code} in ${rel}`
  );
}

/** The quick fixes for a diagnostic, without the Markdown and chat actions VS Code adds. */
async function actionsFor(
  rel: string,
  diagnostic: vscode.Diagnostic
): Promise<vscode.CodeAction[]> {
  const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
    "vscode.executeCodeActionProvider",
    planUri(rel),
    diagnostic.range
  );
  return actions.filter((a) => a.kind?.value === vscode.CodeActionKind.QuickFix.value);
}

describe("quick fixes", () => {
  before(async () => {
    await getApi();
    await restorePlan();
  });
  afterEach(restorePlan);

  it("moves a team.md period with the wrong year as a whole", async () => {
    const editor = await openPlanFile(TEAM);
    const pos = await positionOf(TEAM, "2026-12-22..2027-01-02");
    await editor.edit((b) =>
      b.replace(new vscode.Range(pos, pos.translate(0, 22)), "2027-12-22..2028-01-02")
    );
    const diag = await diagnosticOn(TEAM, "date-outside-project", pos.line);
    assert.equal(editor.document.getText(diag.range), "2027-12-22..2028-01-02");
    const actions = await actionsFor(TEAM, diag);
    const fix = actions.find(
      (a) => a.title === "Change 2027-12-22..2028-01-02 to 2026-12-22..2027-01-02"
    );
    assert.ok(fix?.isPreferred, actions.map((a) => a.title).join("\n"));
    await vscode.workspace.applyEdit(fix.edit!);
    assert.equal(editor.document.lineAt(pos.line).text, "off: 2026-12-22..2027-01-02");
    await noDiagnostic(TEAM, "date-outside-project");
  });

  it("offers depends: on the milestone before only when no earlier milestone waits for it", async () => {
    const api = await getApi();
    const m2 = await openPlanFile(M2);
    const at = await positionOf(M2, "depends: M1\n");
    await m2.edit((b) => b.delete(new vscode.Range(at, at.translate(1, 0))));
    const diag = await diagnosticOn(M2, "floating-milestone", 0);
    const add = (await actionsFor(M2, diag)).find(
      (a) => a.title === "Add depends: M1 (start after M1 is finished)"
    );
    assert.ok(add?.isPreferred);
    assert.match(add.edit!.get(planUri(M2))[0].newText, /depends: M1/);

    // M1's sign-off waits for M2's shared library: M2 comes first, and depends: M1 would be a cycle.
    const m1 = await openPlanFile(M1);
    const dep = await positionOf(M1, "@dep:T011 ", "@dep:T011".length);
    await m1.edit((b) => b.insert(dep, ",T121"));
    await noDiagnostic(M2, "floating-milestone");
    // Not even for the info published before the change.
    const stale = new PlanCodeActionProvider(api.service).provideCodeActions(
      await vscode.workspace.openTextDocument(planUri(M2)),
      diag.range,
      { diagnostics: [diag], triggerKind: vscode.CodeActionTriggerKind.Invoke, only: undefined }
    );
    assert.deepEqual(
      stale.map((a) => a.title),
      []
    );
  });

  it("points out an open subtask of a cancelled task, and cancels it or moves it out", async () => {
    const editor = await openPlanFile(M2);
    const end = await positionOf(M2, "#billing ^T115", "#billing ^T115".length);
    const subtask = "  - [ ] New statement export @est:16h @owner:sam ^T116";
    await editor.edit((b) => b.insert(end, `\n${subtask}`));
    const diag = await diagnosticOn(M2, "cancelled-parent-open-subtasks", end.line);
    assert.equal(diag.message, "Cancelled, so its open subtask (T116) is not scheduled either.");
    assert.equal(diag.severity, vscode.DiagnosticSeverity.Information);
    const actions = await actionsFor(M2, diag);
    assert.deepEqual(
      actions.map((a) => a.title),
      [
        "Cancel the open subtask too",
        "Move T116 out of this task (outdent)",
        "Reopen this task (to do)",
      ]
    );
    assert.ok(actions.every((a) => !a.isPreferred));

    await vscode.workspace.applyEdit(actions[0].edit!);
    assert.equal(
      editor.document.lineAt(end.line + 1).text,
      "  - [-] New statement export @est:16h @owner:sam ^T116"
    );
    await noDiagnostic(M2, "cancelled-parent-open-subtasks");

    // Open again (with an edit: undo goes to whichever editor has the focus), then move it out.
    const reopen = new vscode.WorkspaceEdit();
    reopen.replace(planUri(M2), editor.document.lineAt(end.line + 1).range, subtask);
    await vscode.workspace.applyEdit(reopen);
    const again = await diagnosticOn(M2, "cancelled-parent-open-subtasks", end.line);
    const move = (await actionsFor(M2, again))[1].command!;
    assert.equal(move.command, "planner.outdentTask");
    await vscode.commands.executeCommand(move.command, ...(move.arguments ?? []));
    assert.deepEqual(
      docText(M2)
        .split("\n")
        .slice(end.line, end.line + 2),
      [
        "- [-] Legacy PDF statement export @est:1d @owner:sam #billing ^T115",
        "- [ ] New statement export @est:16h @owner:sam ^T116",
      ]
    );
    await noDiagnostic(M2, "cancelled-parent-open-subtasks");
  });

  it("only offers to cancel the subtasks when other done or cancelled work holds them", async () => {
    const editor = await openPlanFile(M2);
    const titles = async (line: number) =>
      (await actionsFor(M2, await diagnosticOn(M2, "cancelled-parent-open-subtasks", line))).map(
        (a) => a.title
      );
    const offers = (line: number, expected: string[]) =>
      waitFor(
        async () => (await titles(line)).join("\n") === expected.join("\n"),
        `${expected.join(", ")} on line ${line}`
      );
    // Under a done task: the subtask moved out, or this task reopened, would still be moot.
    const done = await positionOf(M2, "#backend ^T120", "#backend ^T120".length);
    await editor.edit((b) =>
      b.insert(
        done,
        "\n  - [-] Old pipeline @est:4h ^T116\n    - [ ] Pipeline notes @est:2h @owner:sam ^T117"
      )
    );
    assert.deepEqual(await titles(done.line + 1), ["Cancel the open subtask too"]);

    // Open under a done subtask: reopening this task would not schedule it either.
    const end = await positionOf(M2, "#billing ^T115", "#billing ^T115".length);
    await editor.edit((b) =>
      b.insert(
        end,
        "\n  - [x] Statement layout @est:4h @done:2026-10-02 ^T118" +
          "\n    - [ ] Layout review @est:2h @owner:sam ^T119"
      )
    );
    assert.deepEqual(await titles(end.line), ["Cancel the open subtask too"]);

    // An open subtask of its own can be moved out, or this task reopened; not in a cancelled
    // milestone.
    const last = await positionOf(M2, "@owner:sam ^T119", "@owner:sam ^T119".length);
    await editor.edit((b) =>
      b.insert(last, "\n  - [ ] New statement export @est:16h @owner:sam ^T123")
    );
    await offers(end.line, [
      "Cancel the 2 open subtasks too",
      "Move T123 out of this task (outdent)",
      "Reopen this task (to do)",
    ]);
    const status = await positionOf(M2, "status: active", "status: ".length);
    await editor.edit((b) =>
      b.replace(new vscode.Range(status, status.translate(0, "active".length)), "cancelled")
    );
    await offers(end.line, ["Cancel the 2 open subtasks too"]);
  });

  it("gives a duplicated punch item a new punch id", async () => {
    const editor = await openPlanFile(PUNCH);
    const end = await positionOf(PUNCH, "^P007", "^P007".length);
    await editor.edit((b) =>
      b.insert(end, "\n- [ ] Expired card text in the app too @sev:C @owner:priya ^P002")
    );
    const diag = await diagnosticOn(PUNCH, "duplicate-id", end.line + 1);
    const actions = await actionsFor(PUNCH, diag);
    const fix = actions.find((a) => a.title === "Give this item a new id ^P008");
    assert.ok(fix, actions.map((a) => a.title).join("\n"));
    await vscode.workspace.applyEdit(fix.edit!);
    assert.equal(
      editor.document.lineAt(end.line + 1).text,
      "- [ ] Expired card text in the app too @sev:C @owner:priya ^P008"
    );
  });
});
