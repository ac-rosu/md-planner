import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { type KanbanPanel } from "../../src/extension/webviews/kanbanPanel";
import { type PunchNode } from "../../src/extension/views/punchTree";
import { docText, getApi, restorePlan, TODAY, waitFor } from "./helpers";

const M2 = "milestones/M2-backend.md";

function line(rel: string, id: string): string {
  return docText(rel)
    .split("\n")
    .find((l) => l.endsWith(`^${id}`))!;
}

async function openKanban(): Promise<KanbanPanel> {
  const api = await getApi();
  await vscode.commands.executeCommand("planner.openKanban");
  const panel = await waitFor(() => api.kanban(), "kanban panel");
  await panel.receive({
    type: "options",
    options: { board: "tasks", swimlane: "none", showCancelled: false, cardMode: "tasks" },
  });
  await panel.receive({ type: "filter", filter: {} });
  return panel;
}

describe("Kanban", () => {
  before(async () => {
    await getApi();
    await restorePlan();
  });
  afterEach(restorePlan);

  it("moves a card between columns by changing the checkbox and dates", async () => {
    const api = await getApi();
    const panel = await openKanban();
    await panel.receive({ type: "move", key: "T121", status: "doing", lane: "all" });
    assert.equal(
      line(M2, "T121"),
      `- [/] Shared API library (auth, validation, logging) @est:3d @owner:sam @started:${TODAY} #backend ^T121`
    );
    await waitFor(() => api.state.plan.taskById("T121")?.status === "doing", "index");
    await panel.receive({ type: "move", key: "T121", status: "done", lane: "all" });
    assert.equal(
      line(M2, "T121"),
      `- [x] Shared API library (auth, validation, logging) @est:3d @owner:sam @started:${TODAY} @done:${TODAY} #backend ^T121`
    );
  });

  it("asks for a reason when blocking and removes it when unblocking", async () => {
    const api = await getApi();
    const panel = await openKanban();
    await panel.receive({
      type: "move",
      key: "T122",
      status: "blocked",
      lane: "all",
      reason: "alarm list not approved",
    });
    assert.equal(
      line(M2, "T122"),
      '- [!] Notifications and e-mail service @est:12h @owner:sam @dep:T121 @blocked:"alarm list not approved" #backend #notifications ^T122'
    );
    await waitFor(() => api.state.plan.taskById("T122")?.status === "blocked", "index");
    await panel.receive({ type: "move", key: "T122", status: "todo", lane: "all" });
    assert.equal(
      line(M2, "T122"),
      "- [ ] Notifications and e-mail service @est:12h @owner:sam @dep:T121 #backend #notifications ^T122"
    );
  });

  it("reorders within a column by writing @prio", async () => {
    const panel = await openKanban();
    // Dropped right below T105 (high) → T107 becomes high.
    await panel.receive({
      type: "move",
      key: "T107",
      status: "todo",
      lane: "all",
      above: "T105",
      below: "T011",
    });
    assert.match(line(M2, "T107"), /@dep:T102,T105 @prio:high @eq:checkout #checkout \^T107$/);
    await panel.receive({ type: "priority", key: "T105", prio: "med" });
    assert.doesNotMatch(line(M2, "T105"), /@prio/);
  });

  it("reassigns the owner when a card moves to another owner lane, and refuses milestone moves", async () => {
    const panel = await openKanban();
    await panel.receive({
      type: "options",
      options: { board: "tasks", swimlane: "owner", showCancelled: false, cardMode: "tasks" },
    });
    await panel.receive({ type: "move", key: "T121", status: "todo", lane: "priya" });
    assert.match(line(M2, "T121"), /@owner:priya #backend \^T121$/);
    await panel.receive({
      type: "options",
      options: { board: "tasks", swimlane: "milestone", showCancelled: false, cardMode: "tasks" },
    });
    const before = docText(M2);
    await panel.receive({ type: "move", key: "T122", status: "todo", lane: "M3" });
    assert.equal(docText(M2), before);
  });

  it("filters with the sidebar filter and persists it per board", async () => {
    const panel = await openKanban();
    await panel.receive({ type: "filter", filter: { owner: ["maria"] } });
    assert.deepEqual(panel.filter, { owner: ["maria"] });
    await panel.receive({
      type: "options",
      options: { board: "punch", swimlane: "severity", showCancelled: false, cardMode: "tasks" },
    });
    assert.deepEqual(panel.filter, {});
  });

  it("has a punch-list board and a punch tree grouped by severity and owner", async () => {
    const api = await getApi();
    const panel = await vscode.commands.executeCommand<KanbanPanel>("planner.openPunchBoard");
    assert.equal(panel.viewOptions.board, "punch");
    await panel.receive({ type: "move", key: "P002", status: "done", lane: "C" });
    assert.match(
      line("punchlist.md", "P002"),
      new RegExp(
        `^- \\[x\\] Error text .* @owner:priya @done:${TODAY} @from:UAT-01/TC-02 #notifications \\^P002$`
      )
    );
    await waitFor(() => api.state.plan.punchById("P002")?.status === "done", "index");
    const roots = api.punch.getChildren() as PunchNode[];
    assert.deepEqual(
      roots.map((r) => (r.kind === "severity" ? r.sev : r.kind)),
      ["A", "B", "closed"]
    );
    const b = api.punch.getChildren(roots[1]);
    assert.deepEqual(
      b.map((n) => (n.kind === "owner" ? n.owner : "")),
      ["alex", "sam"]
    );
    assert.equal(api.punch.getTreeItem(roots[0]).description, "1 open");
  });
});
