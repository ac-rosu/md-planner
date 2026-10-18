import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { type InboxNode } from "../../src/extension/views/inboxTree";
import { type MilestoneNode } from "../../src/extension/views/milestonesTree";
import { type TeamNode } from "../../src/extension/views/teamTree";
import { docText, getApi, readPlanFile, restorePlan, TODAY, waitFor } from "./helpers";

describe("sidebar views", () => {
  before(async () => {
    await getApi();
    await restorePlan();
  });
  afterEach(restorePlan);

  it("loads the sample plan", async () => {
    const api = await getApi();
    assert.ok(api.service.root);
    assert.equal(api.service.index.paths.length, 11);
    assert.deepEqual(
      api.state.plan.milestones.map((m) => m.id),
      ["M1", "M2", "M3", "M4", "M5"]
    );
  });

  it("shows milestone → section → task → subtask", async () => {
    const api = await getApi();
    const roots = api.milestones.getChildren();
    assert.equal(roots.length, 5);
    const m2 = roots[1];
    const item = api.milestones.getTreeItem(m2);
    assert.equal(item.label, "M2 – Backend");
    assert.match(String(item.description), /\d+\/\d+ · \d+% · target 2026-12-15/);
    const sections = api.milestones.getChildren(m2).filter((n) => n.kind === "section");
    assert.deepEqual(
      sections.map((s) => (s.kind === "section" ? s.section.title : "")),
      ["Common", "Checkout", "Accounts", "Billing"]
    );
    const checkout = api.milestones.getChildren(sections[1]);
    const t102 = checkout.find(
      (n): n is Extract<MilestoneNode, { kind: "task" }> =>
        n.kind === "task" && n.task.id === "T102"
    )!;
    const t102Item = api.milestones.getTreeItem(t102);
    assert.equal(t102Item.description, "T102 · SA · 7/12h");
    assert.equal(t102Item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.deepEqual(
      api.milestones.getChildren(t102).map((n) => (n.kind === "task" ? n.task.id : "")),
      ["T103", "T104"]
    );
    assert.equal((api.milestones.getTreeItem(t102).iconPath as vscode.ThemeIcon).id, "play-circle");
  });

  it("shows the team with open tasks per person, me first", async () => {
    const api = await getApi();
    const people = api.team.getChildren() as Array<Extract<TeamNode, { kind: "person" }>>;
    assert.deepEqual(
      people.map((p) => p.id),
      ["alex", "sam", "priya", "jordan", "maria", "unassigned"]
    );
    const priya = api.team.getChildren(people[2]).map((n) => (n.kind === "task" ? n.task.id : ""));
    assert.ok(priya.includes("T009") && priya.includes("T106"));
    assert.ok(!priya.includes("T104"), "only Priya's tasks");
    const unassigned = api.team
      .getChildren(people[5])
      .map((n) => (n.kind === "task" ? n.task.id : ""));
    assert.deepEqual(unassigned, ["T209", "T112"], "sorted by scheduled start");
  });

  it("filters views by owner and text", async () => {
    const api = await getApi();
    await api.milestones.filter.set({ owner: ["priya"] });
    const ids = api.milestones
      .getChildren()
      .map((n) => (n.kind === "milestone" ? n.milestone.id : ""));
    assert.deepEqual(ids, ["M1", "M2", "M3", "M5"]);
    await api.milestones.filter.set({ text: "cloudevents" });
    const m2 = api.milestones.getChildren();
    assert.equal(m2.length, 1);
    await api.milestones.filter.clear();
    assert.equal(api.milestones.getChildren().length, 5);
  });

  it("lists inbox items and plans one into a milestone section", async () => {
    const api = await getApi();
    const items = api.inbox.getChildren() as InboxNode[];
    assert.equal(items.length, 3);
    const first = items[0].task;
    const id = await vscode.commands.executeCommand<string>(
      "planner.planIntoMilestone",
      { file: first.file, line: first.line },
      { milestone: "M2", section: "Common" }
    );
    assert.equal(id, "T408");
    await waitFor(() => api.state.plan.taskById("T408"), "moved task indexed");
    assert.match(
      docText("milestones/M2-backend.md"),
      /#backend #notifications \^T122\n- \[ \] Ask the payment provider for the production API keys #customer \^T408\n\n## Checkout/
    );
    assert.doesNotMatch(docText("inbox.md"), /production API keys/);
    // Saved because planner.autoSave is on.
    assert.match(readPlanFile("inbox.md"), /^(?![\s\S]*production API keys)/);
    assert.equal(api.state.plan.taskById("T408")?.section, "Common");
  });

  it("uses today for written dates", async () => {
    const api = await getApi();
    assert.equal(api.service.today(), TODAY);
  });
});
