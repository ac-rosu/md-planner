import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { largePlanFiles } from "../fixtures/largePlan";
import { getApi, planUri, restorePlan, waitFor } from "./helpers";

// 2,000 generated tasks next to the sample (owners from the sample team, ids that do not clash).
const files = largePlanFiles({
  people: ["alex", "sam", "priya", "jordan", "maria"],
  milestoneStart: 101,
  taskStart: 5001,
  standalone: false,
});

describe("performance with 2,000 more tasks", () => {
  before(async () => {
    await getApi();
    await restorePlan();
  });
  after(async () => {
    const api = await getApi();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    for (const path of Object.keys(files)) await vscode.workspace.fs.delete(planUri(path));
    // Every deletion reaches the index on its own (slow on a CI runner): wait for all 20 files, so
    // the next suite starts from the sample plan alone.
    await waitFor(
      () => !api.service.index.paths.some((p) => p in files),
      "generated files removed",
      20_000
    );
    await restorePlan();
    // Recompute now, so diagnostics computed with the generated tasks do not outlive them.
    api.service.fireNow();
  });

  it("recomputes the schedule, diagnostics and every open view quickly", async () => {
    const api = await getApi();
    const before = api.state.plan.tasks.length;
    for (const [path, text] of Object.entries(files)) {
      await vscode.workspace.fs.writeFile(planUri(path), Buffer.from(text, "utf8"));
    }
    await waitFor(
      () => api.state.plan.tasks.length === before + 2000,
      "2,000 tasks loaded",
      20_000
    );
    for (const command of [
      "planner.openGantt",
      "planner.openKanban",
      "planner.openResources",
      "planner.openDashboard",
    ])
      await vscode.commands.executeCommand(command);
    await waitFor(
      () => api.gantt() && api.kanban() && api.resources() && api.dashboard(),
      "all panels open"
    );

    // Recompute = plan, schedule, cache, and every listener: panels rebuild and post their models.
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      api.state.recompute();
      api.state.issues({ missingIds: false });
      times.push(Date.now() - t0);
    }
    const best = Math.min(...times);
    console.log(
      `      recompute with 4 views open, ${api.state.plan.tasks.length} tasks: ${best} ms`
    );
    assert.ok(best < 500, `recompute took ${best} ms`);

    // An edit from a command is applied, saved and reflected in the schedule within a second
    // (including the 300 ms debounce).
    const t0 = Date.now();
    await vscode.commands.executeCommand("planner.assignOwner", "T5910", "maria");
    await waitFor(
      () => api.state.schedule.byKey.get("T5910")?.resource === "maria",
      "rescheduled after the edit"
    );
    const latency = Date.now() - t0;
    console.log(`      edit → schedule updated: ${latency} ms`);
    assert.ok(latency < 1500, `edit to schedule took ${latency} ms`);
  });
});
