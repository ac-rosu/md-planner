import * as assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import * as vscode from "vscode";
import { overloadedWeeks } from "../../src/core/views/resources";
import { type DashboardPanel } from "../../src/extension/webviews/dashboardPanel";
import { type ResourcesPanel } from "../../src/extension/webviews/resourcesPanel";
import { docText, getApi, planUri, restorePlan, TODAY, waitFor } from "./helpers";

const M2 = "milestones/M2-backend.md";

function line(rel: string, id: string): string {
  return docText(rel)
    .split("\n")
    .find((l) => l.endsWith(`^${id}`))!;
}

describe("team load, dashboard, baselines and time tracking", () => {
  before(async () => {
    await getApi();
    await restorePlan();
  });
  afterEach(restorePlan);

  it("opens the dashboard with milestone cards and the sample baseline", async () => {
    const api = await getApi();
    await waitFor(() => api.baselines.names().includes("2026-10-07-kickoff"), "baselines loaded");
    const panel = await vscode.commands.executeCommand<DashboardPanel>("planner.openDashboard");
    const { model, baselines, baseline } = panel.model();
    assert.deepEqual(baselines, ["2026-10-07-kickoff"]);
    assert.equal(baseline, "2026-10-07-kickoff");
    assert.equal(model.milestones.length, 5);
    assert.ok((model.milestones[0].trend?.slip ?? 0) > 0, "M1 slipped since kickoff");
    assert.equal(model.lists.blocked[0].id, "T106");
  });

  it("saves a baseline as JSON and shows it in the Gantt", async () => {
    const api = await getApi();
    const id = await vscode.commands.executeCommand<string>(
      "planner.saveBaseline",
      "Integration test"
    );
    assert.equal(id, `${TODAY}-integration-test`);
    const file = planUri(`baselines/${id}.json`).fsPath;
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(saved.name, "Integration test");
      assert.equal(saved.tasks.T107.finish, "2026-11-20");
      await waitFor(() => api.baselines.names().includes(id), "baseline listed");
      const gantt = await vscode.commands.executeCommand<{
        viewOptions: { showBaseline: boolean };
      }>("planner.openGantt");
      assert.ok(gantt.viewOptions.showBaseline);
      assert.equal(api.baselines.lookup(id)?.name, "Integration test");
    } finally {
      rmSync(file, { force: true });
      await api.baselines.reload();
    }
    assert.ok(!existsSync(file));
  });

  it("shows overload per ISO week in demand mode and none when scheduled", async () => {
    const panel = await vscode.commands.executeCommand<ResourcesPanel>("planner.openResources");
    await panel.receive({ type: "mode", mode: "capacity" });
    assert.equal(overloadedWeeks(panel.model()).size, 0);
    await panel.receive({ type: "mode", mode: "demand" });
    assert.equal(panel.viewMode, "demand");
    assert.deepEqual(overloadedWeeks(panel.model()).get("sam"), ["2026-W43", "2026-W44"]);
    await panel.receive({ type: "mode", mode: "capacity" });
  });

  it("reports overbooked tasks as info diagnostics", async () => {
    const diags = await waitFor(() => {
      const d = vscode.languages.getDiagnostics(planUri(M2)).filter((x) => x.code === "overbooked");
      return d.length ? d : undefined;
    }, "overbooked diagnostics");
    assert.ok(diags.some((d) => /Sam is overbooked in 2026-W43/.test(d.message)));
    assert.equal(diags[0].severity, vscode.DiagnosticSeverity.Information);
  });

  it("times a task: start moves it to doing, stop adds rounded time to @act", async () => {
    const api = await getApi();
    assert.equal(await vscode.commands.executeCommand("planner.startTimer", "T121"), true);
    assert.match(
      line(M2, "T121"),
      new RegExp(`^- \\[/\\] .* @owner:sam @started:${TODAY} #backend \\^T121$`)
    );
    const running = api.timer.running!;
    assert.equal(running.key, "T121");
    assert.ok(api.timer.item.text.includes("T121"));
    await waitFor(() => api.state.plan.taskById("T121")?.status === "doing", "index");
    api.timer.now = () => running.startedAt + 50 * 60_000;
    const hours = await vscode.commands.executeCommand<number>("planner.stopTimer");
    api.timer.now = () => Date.now();
    assert.equal(hours, 1);
    assert.match(line(M2, "T121"), /@est:3d @act:1h @owner:sam/);
    assert.equal(api.timer.running, undefined);
  });

  it("logs time manually", async () => {
    const api = await getApi();
    await vscode.commands.executeCommand("planner.logTime", "T102", "1h30m");
    assert.match(line(M2, "T102"), /^- \[\/\] Order state machine @est:12h @act:1.5h @owner:sam/);
    await waitFor(() => api.state.plan.taskById("T102")?.act === 1.5, "index");
    await vscode.commands.executeCommand("planner.logTime", "T102", 2);
    assert.match(line(M2, "T102"), /@act:3.5h/);
  });
});
