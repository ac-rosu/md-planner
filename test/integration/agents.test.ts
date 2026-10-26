import * as assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { getApi } from "./helpers";

describe("AI agents", () => {
  const folder = () => vscode.workspace.workspaceFolders![0].uri;
  const file = () => join(folder().fsPath, ".claude/skills/md-planner/SKILL.md");
  const shipped = () =>
    readFileSync(
      join(
        vscode.extensions.getExtension("acro.md-planner")!.extensionPath,
        "skills/md-planner/SKILL.md"
      ),
      "utf8"
    );
  /** Changes the skill as a user would: an edit in the editor, saved. */
  async function editSkill(text: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file()));
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, doc.lineAt(doc.lineCount - 1).range.end, text);
    assert.ok(await vscode.workspace.applyEdit(edit));
    await doc.save();
  }
  after(() => rmSync(join(folder().fsPath, ".claude"), { recursive: true, force: true }));

  it("adds the md-planner skill to the workspace and replaces a changed copy only when asked", async () => {
    await getApi();
    rmSync(join(folder().fsPath, ".claude"), { recursive: true, force: true });
    assert.ok(await vscode.commands.executeCommand("planner.addAgentSkill"));
    assert.equal(readFileSync(file(), "utf8"), shipped());
    // Run again: nothing to do.
    assert.ok(await vscode.commands.executeCommand("planner.addAgentSkill"));
    assert.equal(readFileSync(file(), "utf8"), shipped());
    await editSkill("\nOur own conventions.\n");
    assert.equal(
      await vscode.commands.executeCommand("planner.addAgentSkill", { replace: false }),
      undefined
    );
    assert.match(readFileSync(file(), "utf8"), /Our own conventions/);
    assert.ok(await vscode.commands.executeCommand("planner.addAgentSkill", { replace: true }));
    assert.equal(readFileSync(file(), "utf8"), shipped());
  });

  it("keeps the skill it wrote up to date, but not one the user changed", async () => {
    const api = await getApi();
    assert.ok(await vscode.commands.executeCommand("planner.addAgentSkill", { replace: true }));
    // A newer extension brings another text: the copy the planner wrote follows it.
    await api.refreshAgentSkill(`${shipped()}\nA newer version.\n`);
    assert.match(readFileSync(file(), "utf8"), /A newer version\.\n$/);
    await editSkill("\nOur own conventions.\n");
    await api.refreshAgentSkill(shipped());
    assert.match(readFileSync(file(), "utf8"), /Our own conventions/);
    assert.ok(existsSync(file()));
  });
});
