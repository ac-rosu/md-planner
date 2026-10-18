import * as assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { getApi, openPlanFile, waitFor } from "./helpers";

interface Manifest {
  contributes: {
    commands: Array<{ command: string }>;
    viewsWelcome: Array<{ contents: string }>;
    walkthroughs: Array<{
      steps: Array<{ description: string; media: { image?: string; markdown?: string } }>;
    }>;
  };
}

describe("extension manifest", () => {
  const ext = () => vscode.extensions.getExtension("acro.md-planner")!;
  const manifest = () => ext().packageJSON as Manifest;

  it("registers every contributed command", async () => {
    await getApi();
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = manifest()
      .contributes.commands.map((c) => c.command)
      .filter((c) => !registered.has(c));
    assert.deepEqual(missing, []);
  });

  it("links only to existing commands from the walkthrough and welcome views", async () => {
    await getApi();
    const registered = new Set(await vscode.commands.getCommands(true));
    const texts = [
      ...manifest().contributes.viewsWelcome.map((v) => v.contents),
      ...manifest().contributes.walkthroughs.flatMap((w) => w.steps.map((s) => s.description)),
    ];
    const links = texts.flatMap((t) => [...t.matchAll(/\(command:([\w.]+)/g)].map((m) => m[1]));
    assert.ok(links.length >= 10, "the walkthrough links to commands");
    assert.deepEqual(
      links.filter((c) => !registered.has(c)),
      []
    );
  });

  it("opens the user manual in a locked Markdown preview", async () => {
    await getApi();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("planner.openManual");
    const previewLabel = () =>
      vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .find(
          (t) =>
            t.input instanceof vscode.TabInputWebview && /markdown\.preview/.test(t.input.viewType)
        )?.label;
    assert.match(await waitFor(previewLabel, "the Markdown preview of the manual"), /README/);
    assert.ok(existsSync(join(ext().extensionPath, "docs", "manual", "README.md")));
    // A dynamic preview would switch to the next Markdown file; the manual's preview must not.
    await openPlanFile("milestones/M2-backend.md");
    await new Promise((r) => setTimeout(r, 1000));
    assert.match(previewLabel() ?? "", /README/);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("ships every walkthrough image and page", () => {
    const files = manifest().contributes.walkthroughs.flatMap((w) =>
      w.steps.map((s) => s.media.image ?? s.media.markdown!)
    );
    assert.deepEqual(
      files.filter((f) => !existsSync(join(ext().extensionPath, f))),
      []
    );
  });
});
