import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as vscode from "vscode";
import { scheduleJsonText } from "../../src/core/scheduleJson";
import { type GanttPanel } from "../../src/extension/webviews/ganttPanel";
import { type TeamNode } from "../../src/extension/views/teamTree";
import { docText, getApi, planUri, restorePlan, waitFor } from "./helpers";

const M2 = "milestones/M2-backend.md";
const M3 = "milestones/M3-frontend.md";

async function openGantt(): Promise<GanttPanel> {
  const api = await getApi();
  await vscode.commands.executeCommand("planner.openGantt");
  const panel = await waitFor(() => api.gantt(), "gantt panel");
  return panel;
}

function line(rel: string, id: string): string {
  return docText(rel)
    .split("\n")
    .find((l) => l.endsWith(`^${id}`))!;
}

describe("scheduler integration and Gantt", () => {
  before(async () => {
    await getApi();
    await restorePlan();
  });
  afterEach(restorePlan);
  after(() => {
    void vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("writes the schedule cache and late-task diagnostics", async () => {
    const api = await getApi();
    api.state.recompute();
    const cache = planUri(".planner/schedule.json").fsPath;
    const text = await waitFor(() => {
      try {
        return readFileSync(cache, "utf8");
      } catch {
        return undefined;
      }
    }, "schedule.json");
    assert.equal(text, scheduleJsonText(api.state.plan, api.state.schedule));
    const diags = await waitFor(() => {
      const d = vscode.languages.getDiagnostics(planUri("milestones/M5-launch.md"));
      return d.find((x) => x.code === "late-task");
    }, "late diagnostic");
    assert.match(diags.message, /after the M5 target 2027-03-26/);
    // The warning names what holds the task back.
    assert.match(diags.message, /Held back by /);
  });

  it("shows scheduled dates and slack in CodeLens and load in the team view", async () => {
    const api = await getApi();
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      "vscode.executeCodeLensProvider",
      planUri(M2),
      100
    );
    const titles = lenses.map((l) => l.command?.title ?? "");
    assert.ok(
      titles.some((t) => /^\d+\/\d+ tasks · \d+% · forecast 2026-11-24 · 15 d ahead$/.test(t)),
      titles[0]
    );
    assert.ok(
      titles.includes("scheduled 2026-11-10 → 11-11 · slack 15 d · 1.6 h overtime"),
      titles.join("\n")
    );
    const people = api.team.getChildren() as Array<Extract<TeamNode, { kind: "person" }>>;
    const sam = api.team.getTreeItem(people.find((p) => p.id === "sam")!);
    assert.match(String(sam.description), /Backend developer · \d+ open · [\d.]+\/40 h/);
    const markTasks = api.team
      .getChildren(people.find((p) => p.id === "sam")!)
      .map((n) => (n.kind === "task" ? n.task.id : ""));
    assert.equal(markTasks[0], "T011", "sorted by scheduled start");
  });

  it("opens the Gantt and moves a bar by writing @start (snapped to a working day)", async () => {
    const api = await getApi();
    const panel = await openGantt();
    assert.equal(panel.viewOptions.grouping, "milestone");
    await panel.receive({ type: "move", key: "T104", start: "2026-11-07" }); // Saturday
    assert.equal(line(M2, "T104"), "  - [ ] Order events schema @est:6h @start:2026-11-09 ^T104");
    await waitFor(() => api.state.plan.taskById("T104")?.start === "2026-11-09", "index");
    await waitFor(() => api.state.schedule.byKey.get("T104")?.start === 20766, "rescheduled");
  });

  it("removes a fixed start from a pinned bar", async () => {
    const api = await getApi();
    await openGantt();
    assert.match(line(M2, "T105"), /@start:2026-11-10/);
    await vscode.commands.executeCommand("planner.removeFixedStart", { key: "T105" });
    assert.doesNotMatch(line(M2, "T105"), /@start/);
    await waitFor(() => api.state.plan.taskById("T105")?.start === undefined, "index");
  });

  it("resizes a bar by writing @est as the remaining hours", async () => {
    const panel = await openGantt();
    // T121 (Sam, 40 h/week) is scheduled 2026-10-21 → 10-23; ending on Monday 10-26 = 4 working days.
    await panel.receive({ type: "resize", key: "T121", finish: "2026-10-26" });
    assert.equal(
      line(M2, "T121"),
      "- [ ] Shared API library (auth, validation, logging) @est:32h @owner:sam #backend ^T121"
    );
  });

  it("links two bars by adding @dep, refuses cycles, and unlinks", async () => {
    const api = await getApi();
    const panel = await openGantt();
    await panel.receive({ type: "link", from: "T201", to: "T202" });
    assert.equal(
      line(M3, "T202"),
      "- [ ] Roles and audit log @est:1d @owner:priya @dep:T201 #frontend ^T202"
    );
    await waitFor(() => api.state.plan.taskById("T202")?.deps.length === 1, "index");
    const before = docText(M2);
    await panel.receive({ type: "link", from: "T102", to: "T101" });
    assert.equal(docText(M2), before, "a cycle is refused");
    await panel.receive({ type: "unlink", from: "T101", to: "T102" });
    assert.equal(line(M2, "T102"), "- [/] Order state machine @est:12h @owner:sam #checkout ^T102");
  });

  it("edits title, owner and estimate in one minimal edit, with undo and redo", async () => {
    const api = await getApi();
    const panel = await openGantt();
    const original = docText(M2);
    await panel.receive({
      type: "edit",
      key: "T105",
      title: "Payment provider and refund integration",
      owner: "alex",
      estimate: "3d",
    });
    const edited = line(M2, "T105");
    assert.equal(
      edited,
      "- [ ] Payment provider and refund integration @est:3d @owner:alex @start:2026-11-10 @prio:high @eq:checkout/payment #checkout ^T105"
    );
    await waitFor(() => api.history.canUndo, "history");
    await panel.receive({ type: "undo" });
    assert.equal(docText(M2), original);
    await panel.receive({ type: "redo" });
    assert.equal(line(M2, "T105"), edited);
  });

  it("rejects edits of done tasks and invalid estimates", async () => {
    const panel = await openGantt();
    const before = docText(M2);
    await panel.receive({ type: "move", key: "T101", start: "2026-11-02" });
    await panel.receive({ type: "edit", key: "T104", estimate: "lots" });
    assert.equal(docText(M2), before);
  });

  it("opens the Gantt focused on a task from the tree", async () => {
    const api = await getApi();
    const panel = await vscode.commands.executeCommand<GanttPanel>("planner.openGantt", "T107");
    assert.equal(panel, api.gantt());
  });
});
