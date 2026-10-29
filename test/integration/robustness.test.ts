// What careless users and tools do to plan files while VS Code runs: merge conflicts, other
// encodings, unreadable files, folders deleted or renamed at once, hidden files, files deleted
// while they are edited, and saves that fail. Files are written with Node, like git or an agent.
import * as assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { setAttr } from "../../src/core/writer";
import { getApi, planUri, restorePlan, waitFor, workspaceDir } from "./helpers";

type Kind = "showWarningMessage" | "showErrorMessage";

/** Runs `f` with a window message function replaced; returns the messages it was asked to show. */
async function messages(kind: Kind, answer: string | undefined, f: () => Promise<unknown>) {
  const window = vscode.window as unknown as Record<Kind, (m: string) => unknown>;
  const original = window[kind];
  const shown: string[] = [];
  window[kind] = (m: string) => {
    shown.push(m);
    return Promise.resolve(answer);
  };
  try {
    await f();
  } finally {
    window[kind] = original;
  }
  return shown;
}

function milestone(id: string, ...tasks: string[]): string {
  return [`# ${id} – Robustness`, "", `id: ${id}`, "status: planned", "", ...tasks, ""].join("\n");
}

/** Writes a plan file with Node (only the file watcher sees it) and waits until it is indexed. */
async function writeIndexed(rel: string, text: string | Uint8Array): Promise<string> {
  const api = await getApi();
  const file = planUri(rel).fsPath;
  writeFileSync(file, text);
  await waitFor(() => api.service.index.has(rel), `${rel} indexed`);
  return file;
}

/** Removes a plan file written by a test and waits until the index lets go of it. */
async function removeFile(rel: string): Promise<void> {
  const api = await getApi();
  rmSync(planUri(rel).fsPath, { force: true });
  await waitFor(() => !api.service.index.has(rel), `${rel} removed`);
}

/**
 * Waits until the watcher has caught up: events come in order, so once a file written now is
 * indexed, the events of everything before it have been handled.
 */
async function settle(): Promise<void> {
  const rel = "milestones/M99-settle.md";
  await writeIndexed(rel, milestone("M99"));
  await removeFile(rel);
}

describe("plan file robustness", () => {
  before(async () => {
    await getApi();
    await restorePlan();
  });

  after(async () => {
    await restorePlan();
  });

  it("reports merge conflict markers and asks before changing such a file", async () => {
    const api = await getApi();
    const rel = "milestones/M91-conflict.md";
    const text = milestone(
      "M91",
      "- [ ] One @est:1d ^T911",
      "<<<<<<< HEAD",
      "- [ ] Two @est:1d ^T912",
      "=======",
      "- [ ] Two, theirs @est:2d ^T913",
      ">>>>>>> feature"
    );
    const file = await writeIndexed(rel, text);
    try {
      assert.deepEqual(api.service.index.conflictLines(rel), [6, 8, 10]);
      await waitFor(
        () =>
          (api.diagnostics.collection.get(planUri(rel)) ?? []).filter(
            (d) => d.code === "merge-conflict" && d.severity === vscode.DiagnosticSeverity.Error
          ).length === 3,
        "merge-conflict diagnostics"
      );
      const edit = () => {
        const t = api.service.plan.taskById("T911")!;
        const edits = setAttr(api.service.index.get(rel)!.lines, t, "owner", "alex");
        return api.service.apply([{ path: rel, edits }]);
      };
      let ok: boolean | undefined;
      const asked = await messages(
        "showWarningMessage",
        undefined,
        async () => (ok = await edit())
      );
      assert.equal(ok, false);
      assert.deepEqual(asked, [
        "milestones/M91-conflict.md has git merge conflict markers (lines 7, 9, 11). Resolve the conflict first: the change could land inside it.",
      ]);
      assert.equal(readFileSync(file, "utf8"), text);
      await messages("showWarningMessage", "Change Anyway", async () => (ok = await edit()));
      assert.equal(ok, true);
      await waitFor(
        () => readFileSync(file, "utf8").includes("One @est:1d @owner:alex ^T911"),
        "changed anyway"
      );
    } finally {
      await removeFile(rel);
    }
  });

  it("does not change a file that is not UTF-8", async () => {
    const api = await getApi();
    const rel = "milestones/M92-latin1.md";
    const text = milestone("M92", "- [ ] Über die Brücke @est:1d ^T921");
    const bytes = Buffer.from(text, "latin1");
    const file = await writeIndexed(rel, bytes);
    try {
      await waitFor(() => api.service.index.notUtf8(rel), "marked not UTF-8");
      await waitFor(
        () =>
          (api.diagnostics.collection.get(planUri(rel)) ?? []).some((d) => d.code === "not-utf8"),
        "not-utf8 diagnostic"
      );
      const t = api.service.plan.taskById("T921")!;
      const edits = setAttr(api.service.index.get(rel)!.lines, t, "owner", "alex");
      let ok: boolean | undefined;
      const shown = await messages("showErrorMessage", undefined, async () => {
        ok = await api.service.apply([{ path: rel, edits }]);
      });
      assert.equal(ok, false);
      assert.match(shown[0], /^Planner: milestones\/M92-latin1\.md is not UTF-8/);
      assert.match(shown[0], /Reopen with Encoding → Latin-1/);
      assert.equal(Buffer.compare(readFileSync(file), bytes), 0);
      // Saved as UTF-8 by someone: the mark goes.
      writeFileSync(file, text, "utf8");
      await waitFor(() => !api.service.index.notUtf8(rel), "UTF-8 again");
    } finally {
      await removeFile(rel);
    }
  });

  (process.platform === "win32" || process.getuid?.() === 0 ? it.skip : it)(
    "leaves an unreadable file out with a warning; the plan still loads",
    async () => {
      const api = await getApi();
      const rel = "milestones/M93-locked.md";
      const file = await writeIndexed(rel, milestone("M93", "- [ ] Locked @est:1d ^T931"));
      chmodSync(file, 0o000);
      try {
        await vscode.commands.executeCommand("planner.refresh");
        assert.equal(api.service.index.has(rel), false);
        assert.ok(api.service.plan.milestoneById("M2"), "the rest of the plan is there");
        const warning = api.service.plan.issues.find((i) => i.file === rel);
        assert.equal(warning?.code, "unreadable-file");
        assert.equal(warning?.severity, "warning");
        assert.match(warning?.message ?? "", /^Could not read this file \(permission denied/);
      } finally {
        chmodSync(file, 0o644);
      }
      await vscode.commands.executeCommand("planner.refresh");
      assert.ok(api.service.plan.taskById("T931"));
      await removeFile(rel);
      assert.equal(
        api.service.plan.issues.some((i) => i.file === rel),
        false
      );
    }
  );

  it("follows folders created, renamed and deleted at once", async () => {
    const api = await getApi();
    const plan = join(workspaceDir(), "plan");
    // Moved in from outside the plan folder: one event for the folder.
    const outside = join(workspaceDir(), "moved-in");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "M94-moved.md"), milestone("M94", "- [ ] Moved @est:1d ^T941"));
    const first = join(plan, "milestones", "extra");
    const second = join(plan, "milestones", "renamed");
    try {
      renameSync(outside, first);
      await waitFor(
        () => api.service.plan.taskById("T941")?.file === "milestones/extra/M94-moved.md",
        "folder moved in"
      );
      renameSync(first, second);
      await waitFor(
        () =>
          api.service.plan.taskById("T941")?.file === "milestones/renamed/M94-moved.md" &&
          !api.service.index.has("milestones/extra/M94-moved.md"),
        "folder renamed"
      );
      rmSync(second, { recursive: true });
      await waitFor(() => !api.service.plan.milestoneById("M94"), "folder deleted");
    } finally {
      for (const dir of [outside, first, second]) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores hidden files the watcher reports", async () => {
    const api = await getApi();
    const milestones = join(workspaceDir(), "plan", "milestones");
    const apple = join(milestones, "._M2-backend.md");
    const trash = join(milestones, ".trash");
    writeFileSync(apple, Buffer.from([0, 5, 22, 7, 0, 2, 0, 0, 77, 97, 99]));
    mkdirSync(trash, { recursive: true });
    writeFileSync(join(trash, "M95.md"), milestone("M95", "- [ ] Deleted @est:1d ^T951"));
    try {
      await settle();
      assert.equal(api.service.index.has("milestones/._M2-backend.md"), false);
      assert.equal(api.service.plan.milestoneById("M95"), undefined);
    } finally {
      rmSync(apple, { force: true });
      rmSync(trash, { recursive: true, force: true });
    }
  });

  it("keeps a file deleted on disk while it is open with unsaved changes", async () => {
    const api = await getApi();
    const rel = "milestones/M96-open.md";
    await writeIndexed(rel, milestone("M96", "- [ ] Saved @est:1d ^T961"));
    const doc = await vscode.workspace.openTextDocument(planUri(rel));
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    await editor.edit((b) => b.insert(new vscode.Position(6, 0), "- [ ] Unsaved @est:1d ^T962\n"));
    await waitFor(() => api.service.plan.taskById("T962"), "unsaved task indexed");
    rmSync(planUri(rel).fsPath);
    await settle();
    assert.ok(api.service.plan.milestoneById("M96"), "still in the plan");
    assert.ok(api.service.plan.taskById("T962"), "with the editor's text");
    // Saved again, the file is back (its events handled before it is deleted for good).
    assert.equal(await doc.save(), true);
    await settle();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await removeFile(rel);
  });

  (process.platform === "win32" || process.getuid?.() === 0 ? it.skip : it)(
    "says when a save failed instead of a silent success",
    async () => {
      const api = await getApi();
      const rel = "milestones/M97-readonly.md";
      const file = await writeIndexed(rel, milestone("M97", "- [ ] Read only @est:1d ^T971"));
      chmodSync(file, 0o444);
      try {
        const t = api.service.plan.taskById("T971")!;
        const edits = setAttr(api.service.index.get(rel)!.lines, t, "owner", "alex");
        let ok: boolean | undefined;
        const shown = await messages("showWarningMessage", undefined, async () => {
          ok = await Promise.race([
            api.service.apply([{ path: rel, edits }], { save: true }),
            new Promise<undefined>((r) => setTimeout(() => r(undefined), 20_000)),
          ]);
        });
        assert.equal(ok, true, "the edit is applied (in the editor)");
        assert.deepEqual(
          shown.filter((m) => m.startsWith("Planner:")),
          [
            "Planner: milestones/M97-readonly.md not saved: the file changed on disk or could not be written. The change is in the editor, unsaved: compare it with the file on disk and save it, or revert it.",
          ]
        );
      } finally {
        chmodSync(file, 0o644);
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file);
        if (doc?.isDirty) {
          await vscode.window.showTextDocument(doc);
          await vscode.commands.executeCommand("workbench.action.files.revert");
        }
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      }
      assert.ok(existsSync(file));
      await removeFile(rel);
    }
  );
});
