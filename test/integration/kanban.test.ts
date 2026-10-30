import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { type KanbanCard } from "../../src/core/views/kanban";
import { type KanbanPanel } from "../../src/extension/webviews/kanbanPanel";
import { type PunchNode } from "../../src/extension/views/punchTree";
import { type HostToKanban } from "../../src/webview/shared/protocol";
import { docText, getApi, planUri, positionOf, restorePlan, TODAY, waitFor } from "./helpers";

const M2 = "milestones/M2-backend.md";

function line(rel: string, id: string): string {
  return docText(rel)
    .split("\n")
    .find((l) => l.endsWith(`^${id}`))!;
}

function lineWith(rel: string, title: string): string {
  return docText(rel)
    .split("\n")
    .find((l) => l.includes(`] ${title} @`))!;
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

/** The messages of one type the panel sends to the webview while `action` runs. */
async function sent<T extends HostToKanban["type"]>(
  panel: KanbanPanel,
  type: T,
  action: () => unknown
): Promise<Array<Extract<HostToKanban, { type: T }>>> {
  const out: Array<Extract<HostToKanban, { type: T }>> = [];
  const post = panel.post.bind(panel);
  panel.post = (m) => {
    if (m.type === type) out.push(m as Extract<HostToKanban, { type: T }>);
    post(m);
  };
  try {
    await action();
  } finally {
    panel.post = post;
  }
  return out;
}

/** The cards of the board the panel shows now. */
async function cardsOf(panel: KanbanPanel): Promise<KanbanCard[]> {
  const [m] = await sent(panel, "model", () => panel.sendModel());
  return m.model.lanes.flatMap((l) => Object.values(l.cards).flatMap((c) => c ?? []));
}

/** Pastes a line above `before` in M2, unsaved, and waits until the plan has it. */
async function paste(before: string, text: string, title: string): Promise<void> {
  const api = await getApi();
  const edit = new vscode.WorkspaceEdit();
  edit.insert(planUri(M2), await positionOf(M2, before), `${text}\n`);
  assert.ok(await vscode.workspace.applyEdit(edit));
  await waitFor(
    () => api.state.plan.file(M2)?.items.some((t) => t.title === title),
    "pasted line indexed"
  );
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

  it("keeps the priority when a card moves to another column, whatever its neighbours", async () => {
    const panel = await openKanban();
    // Dropped into Doing right below T105 (high): only the status changes.
    await panel.receive({
      type: "move",
      key: "T107",
      status: "doing",
      lane: "all",
      above: "T105",
    });
    assert.match(line(M2, "T107"), /^- \[\/\] /);
    assert.doesNotMatch(line(M2, "T107"), /@prio/);
  });

  it("moves the card of a copied line that kept its id, not the first task with that id", async () => {
    const panel = await openKanban();
    // A copied line given another title keeps the id until the file is saved.
    await paste(
      "- [ ] Notifications and e-mail service",
      "- [ ] Shared API client @est:1d @owner:sam #backend ^T121",
      "Shared API client"
    );
    const cards = await cardsOf(panel);
    const original = cards.find((c) => c.title.startsWith("Shared API library"))!;
    const copy = cards.find((c) => c.title === "Shared API client")!;
    // Opening the board at a task shows its card (here the first task with the id).
    const focus = await sent(panel, "focus", () =>
      vscode.commands.executeCommand("planner.openKanban", { file: M2, line: 13 })
    );
    assert.deepEqual(
      focus.map((f) => f.key),
      [original.key]
    );
    await panel.receive({ type: "move", key: copy.key, status: "doing", lane: "all" });
    // The copy started (saving gave it an id of its own); the original did not change.
    assert.match(
      lineWith(M2, "Shared API client"),
      new RegExp(
        `^- \\[/\\] Shared API client @est:1d @owner:sam @started:${TODAY} #backend \\^T\\d+$`
      )
    );
    assert.equal(
      lineWith(M2, "Shared API library (auth, validation, logging)"),
      "- [ ] Shared API library (auth, validation, logging) @est:3d @owner:sam #backend ^T121"
    );
  });

  it("reorders next to the card of a copied line by the copy's priority", async () => {
    const panel = await openKanban();
    await paste(
      "- [ ] Notifications and e-mail service",
      "- [ ] Shared API client @est:1d @owner:sam @prio:high #backend ^T121",
      "Shared API client"
    );
    const copy = (await cardsOf(panel)).find((c) => c.title === "Shared API client")!;
    // Dropped right below the copy (high), not below the original (medium): T122 becomes high.
    await panel.receive({
      type: "move",
      key: "T122",
      status: "todo",
      lane: "all",
      above: copy.key,
    });
    assert.match(line(M2, "T122"), /@dep:T121 @prio:high #backend #notifications \^T122$/);
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

  it("checks a filter and options before keeping them, and when the board opens again", async () => {
    const api = await getApi();
    const panel = await openKanban();
    // A message that went wrong: an owner that is not a list.
    await panel.receive({ type: "filter", filter: { owner: "sam", tag: ["backend"] } as never });
    assert.deepEqual(panel.filter, { tag: ["backend"] });
    assert.ok((await cardsOf(panel)).length > 0);
    // Stored by an older version, or by such a message: the board opens all the same.
    await api.panels.memento.update("kanban.filter", { tasks: { owner: "sam", status: "doing" } });
    await api.panels.memento.update("kanban.options", { board: "bugs", swimlane: "owner" });
    panel.dispose();
    await vscode.commands.executeCommand("planner.openKanban");
    const again = await waitFor(() => api.kanban(), "kanban panel");
    assert.deepEqual(again.viewOptions, {
      board: "tasks",
      swimlane: "owner",
      showCancelled: false,
      cardMode: "tasks",
    });
    assert.deepEqual(again.filter, {});
    assert.ok((await cardsOf(again)).length > 0);
    await again.receive({ type: "filter", filter: {} });
  });
});
