import * as assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import * as vscode from "vscode";
import { getApi, planUri, restorePlan, waitFor } from "./helpers";

const M2 = "milestones/M2-backend.md";

describe("plan index sync", () => {
  before(async () => {
    await getApi();
    await restorePlan();
  });

  it("maps URIs to plan paths, ignoring path casing where VS Code does", async () => {
    const api = await getApi();
    const root = api.service.root!;
    // Windows: the workspace folder may be `/C:/...` while file events and paths built from an
    // fsPath are `/c:/...`; both name the same file.
    const upper = root.with({ path: `${root.path}/${M2}`.toUpperCase() });
    const lower = root.with({ path: `${root.path}/${M2}`.toLowerCase() });
    if (process.platform === "linux") {
      assert.equal(api.service.relPath(upper), undefined);
    } else {
      assert.equal(api.service.relPath(upper), M2);
      assert.equal(api.service.relPath(lower), M2);
      assert.ok(api.service.fileFor(lower), "found in the index");
    }
    assert.equal(api.service.relPath(planUri(M2)), M2);
    assert.equal(api.service.relPath(vscode.Uri.joinPath(root, "..", "README.md")), undefined);
  });

  it("follows plan files written, changed and deleted on disk by other programs", async () => {
    const api = await getApi();
    // Written with Node, like an MCP agent or git does, so only the file watcher sees it.
    const file = planUri("milestones/M9-external.md").fsPath;
    const milestone = (title: string) =>
      `# M9 – External\n\nid: M9\nstatus: planned\n\n- [ ] ${title} @est:1d ^T901\n`;
    try {
      writeFileSync(file, milestone("Written outside VS Code"));
      await waitFor(
        () => api.state.plan.taskById("T901")?.title === "Written outside VS Code",
        "created file indexed"
      );
      writeFileSync(file, milestone("Changed outside VS Code"));
      await waitFor(
        () => api.state.plan.taskById("T901")?.title === "Changed outside VS Code",
        "changed file indexed"
      );
    } finally {
      if (existsSync(file)) rmSync(file);
    }
    await waitFor(() => !api.state.plan.milestoneById("M9"), "deleted file removed");
  });
});
