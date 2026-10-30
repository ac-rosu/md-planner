import * as assert from "node:assert/strict";
import { readFileSync, renameSync } from "node:fs";
import * as vscode from "vscode";
import { formatDate } from "../../src/core/dates";
import { scheduleJsonText } from "../../src/core/scheduleJson";
import { applyEdits } from "../../src/core/text";
import { diffEdits } from "../../src/extension/editHistory";
import { type GanttPanel } from "../../src/extension/webviews/ganttPanel";
import { type TeamNode } from "../../src/extension/views/teamTree";
import { DEFAULT_GANTT_OPTIONS, type GanttViewOptions } from "../../src/webview/shared/protocol";
import { docText, getApi, planUri, restorePlan, TODAY, waitFor } from "./helpers";

const M2 = "milestones/M2-backend.md";
const M3 = "milestones/M3-frontend.md";
const M5 = "milestones/M5-launch.md";

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
    // Written in the background: the one from activation has the real today.
    const text = await waitFor(() => {
      try {
        const json = readFileSync(cache, "utf8");
        return json.includes(`"today": "${TODAY}"`) ? json : undefined;
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
    assert.equal(panel.viewOptions.order, "schedule", "rows follow the schedule by default");
    const posted: Array<{ type: string; message?: string }> = [];
    const post = panel.post.bind(panel);
    panel.post = (m) => {
      posted.push(m as { type: string; message?: string });
      post(m);
    };
    await panel.receive({ type: "move", key: "T104", start: "2026-11-07" }); // Saturday
    assert.equal(line(M2, "T104"), "  - [ ] Order events schema @est:6h @start:2026-11-09 ^T104");
    // The notice gives the new dates (worked out before writing) and what else moves.
    assert.match(
      posted.find((m) => m.type === "notice")?.message ?? "",
      /^T104: fixed start none → 2026-11-09\. It is now pinned: .* Ends Mon 2026-11-09\. Also moves Sam's other work: T122 \(−1 d\)/
    );
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
    const api = await getApi();
    const panel = await openGantt();
    // Every drag is reported with what changed and an Undo button.
    const posted: unknown[] = [];
    const post = panel.post.bind(panel);
    panel.post = (m) => {
      posted.push(m);
      post(m);
    };
    // T121 (Sam, 40 h/week) is scheduled 2026-10-20 → 10-22; ending on Friday 10-23 = 4 working days.
    await panel.receive({ type: "resize", key: "T121", finish: "2026-10-23" });
    assert.equal(
      line(M2, "T121"),
      "- [ ] Shared API library (auth, validation, logging) @est:32h @owner:sam #backend ^T121"
    );
    // The notice says where the bar ends now and which other tasks move with it; its Undo button
    // undoes this edit (the newest one in the history).
    const notice = posted.find((m) => (m as { type: string }).type === "notice");
    assert.deepEqual(notice, {
      type: "notice",
      level: "info",
      message:
        "T121: estimate 3d → 32h, ends Fri 2026-10-23. Also moves T122 (+1 d), T110 (+1 d), T111 (+1 d) and 3 more, which wait for it; Sam's other work: T206 (+2 d) and T104 (+1 d).",
      undo: (notice as { undo?: number }).undo,
    });
    assert.equal(typeof (notice as { undo?: number }).undo, "number");
    await waitFor(
      () => formatDate(api.state.schedule.byKey.get("T121")?.finish ?? 0) === "2026-10-23",
      "rescheduled"
    );
  });

  it("says when a drag changes nothing, without an Undo button for someone else's edit", async () => {
    const api = await getApi();
    const panel = await openGantt();
    const notices = noticesOf(panel);
    const [m2, m5] = [docText(M2), docText(M5)];
    // T405 (Priya) ends on a full Friday; T121 has no dependencies.
    await panel.receive({ type: "resize", key: "T405", finish: "2027-03-06" });
    await panel.receive({ type: "unlink", from: "T101", to: "T121" });
    assert.equal(docText(M5), m5);
    assert.equal(docText(M2), m2);
    // A real move, then a drop on the Sunday before its new fixed start.
    await panel.receive({ type: "move", key: "T104", start: "2026-11-07" });
    await waitFor(() => api.state.plan.taskById("T104")?.start === "2026-11-09", "index");
    const moved = docText(M2);
    await panel.receive({ type: "move", key: "T104", start: "2026-11-08" });
    assert.equal(docText(M2), moved);
    assert.deepEqual(
      notices.map((n) => [
        n.message.replace(/^(T104: fixed start none → 2026-11-09\.).*/, "$1"),
        n.undo !== undefined,
      ]),
      [
        ["T405 still ends Fri 2027-03-05: Priya has no working hours on Sat 2027-03-06.", false],
        ["T121 does not depend on T101.", false],
        ["T104: fixed start none → 2026-11-09.", true],
        [
          "T104 already has the fixed start 2026-11-09 (Sun 2026-11-08 is not a working day).",
          false,
        ],
      ]
    );
    // Undo still undoes the move, the last edit.
    await panel.receive({ type: "undo" });
    assert.equal(notices[notices.length - 1].message, "Undid: Move T104 to 2026-11-09");
    assert.equal(docText(M2), m2);
  });

  it("refuses to change a bar whose id another task has, but removes an arrow out of it", async () => {
    const api = await getApi();
    const panel = await openGantt();
    const notices = noticesOf(panel);
    // A copied line: T122 gets the id of T121.
    const doc = await vscode.workspace.openTextDocument(planUri(M2));
    const at = doc.getText().indexOf("^T122");
    const copy = new vscode.WorkspaceEdit();
    copy.replace(doc.uri, new vscode.Range(doc.positionAt(at), doc.positionAt(at + 5)), "^T121");
    await vscode.workspace.applyEdit(copy);
    await waitFor(() => !api.state.plan.taskById("T122"), "index");
    const before = docText(M2);
    await panel.receive({ type: "move", key: "T121", start: "2026-11-02" });
    await panel.receive({ type: "resize", key: "T121", finish: "2026-10-30" });
    await panel.receive({ type: "edit", key: "T121", title: "Shared library" });
    await panel.receive({ type: "link", from: "T121", to: "T105" });
    // The arrow into the copy, which waits for T121: which of the two would lose its @dep?
    await panel.receive({ type: "unlink", from: "T121", to: "T121" });
    assert.equal(docText(M2), before);
    const refused = {
      level: "error",
      message: "2 tasks have the id T121: give each its own id first.",
      undo: undefined,
    };
    assert.deepEqual(notices, [refused, refused, refused, refused, refused]);
    // An arrow out of it: T110 loses @dep:T121, the same edit whichever T121 it comes from.
    await panel.receive({ type: "unlink", from: "T121", to: "T110" });
    assert.equal(
      line(M2, "T110"),
      "- [ ] Account and profile services @est:4d @owner:alex @eq:accounts #accounts ^T110"
    );
    assert.deepEqual(
      notices.slice(5).map((n) => ({ ...n, undo: typeof n.undo })),
      [{ level: "info", message: "T110 no longer waits for T121.", undo: "number" }]
    );
  });

  it("says why a moved bar starts later than where it was dropped", async () => {
    const api = await getApi();
    const panel = await openGantt();
    const notices: string[] = [];
    const post = panel.post.bind(panel);
    panel.post = (m) => {
      const n = m as { type: string; message: string };
      if (n.type === "notice") notices.push(n.message);
      post(m);
    };
    // M2 waits for M1, which ends on Monday 2026-10-19.
    await panel.receive({ type: "move", key: "T121", start: "2026-10-14" });
    assert.equal(
      notices[0],
      "T121: fixed start none → 2026-10-14. M2 waits for M1 to finish, so it starts Tue 2026-10-20. Ends Thu 2026-10-22."
    );
    await waitFor(() => api.state.plan.taskById("T121")?.start === "2026-10-14", "index");
    // Sam is off from Tuesday to Saturday.
    await panel.receive({ type: "move", key: "T105", start: "2026-11-17" });
    assert.match(
      notices[1],
      /^T105: fixed start 2026-11-10 → 2026-11-17\. Sam has no working hours from Tue 2026-11-17 to Sun 2026-11-22, so it starts Mon 2026-11-23\. Ends Tue 2026-11-24\./
    );
  });

  it("resizes a subtask that shares its parent's estimate, and changes the parent with it", async () => {
    const api = await getApi();
    const panel = await openGantt();
    const notices: string[] = [];
    const post = panel.post.bind(panel);
    panel.post = (m) => {
      const n = m as { type: string; message: string };
      if (n.type === "notice") notices.push(n.message);
      post(m);
    };
    // Without its own estimate, T104 gets what T103's 6 h leave of T102's 12 h.
    const doc = await vscode.workspace.openTextDocument(planUri(M2));
    const at = doc.getText().indexOf(" @est:6h ^T104");
    const remove = new vscode.WorkspaceEdit();
    remove.delete(doc.uri, new vscode.Range(doc.positionAt(at), doc.positionAt(at + 8)));
    await vscode.workspace.applyEdit(remove);
    await waitFor(() => api.state.plan.taskById("T104")?.budget === 6, "budget");
    const before = docText(M2);
    await panel.receive({ type: "resize", key: "T104", finish: "2026-10-27" });
    assert.equal(line(M2, "T104"), "  - [ ] Order events schema @est:24h ^T104");
    assert.equal(
      line(M2, "T102"),
      "- [/] Order state machine @est:30h @owner:sam @dep:T101 #checkout ^T102"
    );
    assert.match(
      notices[0],
      /^T104: estimate 6h → 24h, ends Tue 2026-10-27\. T102: estimate 12h → 30h, so its subtasks still add up to it\. /
    );
    await waitFor(() => api.state.plan.taskById("T104")?.est === 24, "index");
    await waitFor(
      () => formatDate(api.state.schedule.byKey.get("T104")?.finish ?? 0) === "2026-10-27",
      "rescheduled"
    );
    // One Undo takes back both estimates.
    await panel.receive({ type: "undo" });
    assert.equal(docText(M2), before);
  });

  it("keeps a zoom without rebuilding the chart, and rebuilds for other options", async () => {
    const panel = await openGantt();
    const posted: Array<{ type: string }> = [];
    const post = panel.post.bind(panel);
    panel.post = (m) => {
      posted.push(m as { type: string });
      post(m);
    };
    const before = panel.viewOptions;
    // A pinch or Ctrl+wheel zoom only stores the pixels per day.
    await panel.receive({ type: "options", options: { ...before, pxPerDay: 21.5 } });
    assert.equal(panel.viewOptions.pxPerDay, 21.5);
    assert.equal(posted.filter((m) => m.type === "model").length, 0);
    await panel.receive({ type: "options", options: { ...before, order: "file" } });
    assert.equal(posted.filter((m) => m.type === "model").length, 1);
    await panel.receive({ type: "options", options: before });
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

  it("refuses an edit from a dialog whose task is no longer on its line, or got another title", async () => {
    const api = await getApi();
    const panel = await openGantt();
    const notices = noticesOf(panel);
    // A task without id is known by its line.
    await insertAbove(M2, "- [ ] Payment provider integration", "- [ ] Refund policy @est:4h");
    const refund = api.state.plan.file(M2)!.items.find((t) => t.title === "Refund policy")!;
    const key = `${M2}#${refund.line + 1}`;
    // While its dialog is open, a line is added above it: its line holds that one now.
    await insertAbove(M2, "- [ ] Refund policy", "- [ ] Chargebacks @est:2h");
    const before = docText(M2);
    await panel.receive({ type: "edit", key, original: "Refund policy", estimate: "8h" });
    assert.equal(docText(M2), before);
    assert.deepEqual(notices.at(-1), {
      level: "error",
      message: `Line ${refund.line + 1} of ${M2} holds another task since the dialog opened ("Chargebacks", was "Refund policy"). Nothing was written; open the dialog again to edit it.`,
      undo: undefined,
    });
    // A title changed meanwhile is not overwritten; the owner of the same task is still set.
    await panel.receive({ type: "edit", key: "T105", original: "Payments", title: "Payment API" });
    assert.equal(docText(M2), before);
    assert.match(notices.at(-1)!.message, /^The title of T105 changed since the dialog opened/);
    await panel.receive({ type: "edit", key: "T105", original: "Payments", owner: "alex" });
    assert.match(line(M2, "T105"), /^- \[ \] Payment provider integration @est:2d @owner:alex /);
  });

  it("raises the parent's estimate when a subtask that shares it gets an estimate of its own", async () => {
    const api = await getApi();
    const panel = await openGantt();
    const notices = noticesOf(panel);
    // Without its own estimate, T104 gets what T103's 6 h leave of T102's 12 h.
    await removeText(M2, " @est:6h ^T104", 8);
    await waitFor(() => api.state.plan.taskById("T104")?.budget === 6, "budget");
    const before = docText(M2);
    await panel.receive({
      type: "edit",
      key: "T104",
      original: "Order events schema",
      estimate: "10h",
    });
    assert.equal(line(M2, "T104"), "  - [ ] Order events schema @est:10h ^T104");
    assert.equal(
      line(M2, "T102"),
      "- [/] Order state machine @est:16h @owner:sam @dep:T101 #checkout ^T102"
    );
    assert.match(
      notices.at(-1)!.message,
      /^Saved T104\. T102: estimate 12h → 16h, so its subtasks still add up to it\./
    );
    // One Undo takes back both estimates.
    await panel.receive({ type: "undo" });
    assert.equal(docText(M2), before);
  });

  it("checks its options before keeping them, and when it opens again", async () => {
    const api = await getApi();
    const panel = await openGantt();
    const before = panel.viewOptions;
    await panel.receive({
      type: "options",
      options: { ...before, grouping: "people", zoom: 5 } as unknown as GanttViewOptions,
    });
    assert.deepEqual(panel.viewOptions, { ...before, grouping: "milestone", zoom: "week" });
    // Stored by an older version, or by a message that went wrong: the chart still opens.
    await api.panels.memento.update("gantt.options", { order: 7, hideDone: true });
    panel.dispose();
    const again = await openGantt();
    assert.deepEqual(again.viewOptions, { ...DEFAULT_GANTT_OPTIONS, hideDone: true });
    await again.receive({ type: "options", options: before });
  });
});

describe("undo and redo from the views", () => {
  before(async () => {
    await getApi();
    await restorePlan();
  });
  afterEach(restorePlan);
  after(() => {
    void vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("undoes and redoes an edit after its save gave other tasks ids", async () => {
    const panel = await openGantt();
    const notices = noticesOf(panel);
    // Pasted without an id and not saved: the save after the next view edit gives it one.
    await insertAbove(M2, "- [ ] Payment provider integration", "- [ ] Refund policy @est:4h");
    const pasted = docText(M2);
    await panel.receive({ type: "move", key: "T104", start: "2026-11-09" });
    const id = /^- \[ \] Refund policy @est:4h \^(T\d+)$/m.exec(docText(M2))?.[1];
    assert.ok(id, "the save gave the pasted task an id");
    const withId = pasted.replace("Refund policy @est:4h", `Refund policy @est:4h ^${id}`);
    await panel.receive({ type: "undo" });
    assert.equal(notices.at(-1)?.message, "Undid: Move T104 to 2026-11-09");
    // The move is gone; the id is given again on save.
    assert.equal(docText(M2), withId);
    await panel.receive({ type: "redo" });
    assert.equal(notices.at(-1)?.message, "Redid: Move T104 to 2026-11-09");
    assert.equal(line(M2, "T104"), "  - [ ] Order events schema @est:6h @start:2026-11-09 ^T104");
    assert.match(docText(M2), new RegExp(`Refund policy @est:4h \\^${id}\\n`));
    await panel.receive({ type: "undo" });
    assert.equal(docText(M2), withId);
  });

  it("undoes from a notice only the edit it reports, while it is the last one", async () => {
    const api = await getApi();
    const gantt = await openGantt();
    const notices = noticesOf(gantt);
    const original = docText(M2);
    await gantt.receive({ type: "move", key: "T104", start: "2026-11-09" });
    const entry = notices.at(-1)?.undo;
    assert.equal(typeof entry, "number");
    // Right after, a card moves on the board.
    await vscode.commands.executeCommand("planner.openKanban");
    const kanban = await waitFor(() => api.kanban(), "kanban panel");
    await kanban.receive({ type: "move", key: "T122", status: "blocked", reason: "keys" });
    const carded = docText(M2);
    await gantt.receive({ type: "undo", entry });
    assert.equal(docText(M2), carded, "the card move stays");
    assert.deepEqual(notices.at(-1), {
      level: "error",
      message:
        '"Move T104 to 2026-11-09" was not undone: "T122: blocked" came after it. Undo in the toolbar undoes the last edit first.',
      undo: undefined,
    });
    // Once the card move is undone, the drag is the last edit again.
    await gantt.receive({ type: "undo" });
    await gantt.receive({ type: "undo", entry });
    assert.equal(docText(M2), original);
    await gantt.receive({ type: "undo", entry });
    assert.equal(notices.at(-1)?.message, '"Move T104 to 2026-11-09" is undone already.');
  });

  it("clears the history when an edited file was renamed, instead of failing every time", async () => {
    const api = await getApi();
    const panel = await openGantt();
    const notices = noticesOf(panel);
    await panel.receive({ type: "move", key: "T202", start: "2026-11-09" });
    const renamed = "milestones/M3-ui.md";
    renameSync(planUri(M3).fsPath, planUri(renamed).fsPath);
    try {
      await waitFor(() => !api.service.index.has(M3), "renamed in the index");
      await panel.receive({ type: "undo" });
    } finally {
      renameSync(planUri(renamed).fsPath, planUri(M3).fsPath);
      await waitFor(
        () => api.service.index.has(M3) && !api.service.index.has(renamed),
        "renamed back"
      );
    }
    assert.deepEqual(notices.at(-1), {
      level: "error",
      message: `"Move T202 to 2026-11-09" cannot be undone here: ${M3} was renamed or deleted since. Use Undo in the editor instead.`,
      undo: undefined,
    });
    assert.equal(api.history.canUndo, false);
    // Undo no longer finds anything to undo, instead of the same error every time.
    await panel.receive({ type: "undo" });
    assert.equal(notices.length, 2);
  });

  it("keeps the edit to undo when the undo is refused, and says so", async () => {
    const api = await getApi();
    const panel = await openGantt();
    const notices = noticesOf(panel);
    const original = docText(M2);
    await panel.receive({ type: "move", key: "T104", start: "2026-11-09" });
    const moved = docText(M2);
    // As when the question about merge conflict markers is cancelled.
    const apply = api.service.apply.bind(api.service);
    api.service.apply = () => Promise.resolve(false);
    try {
      await panel.receive({ type: "undo" });
    } finally {
      api.service.apply = apply;
    }
    assert.equal(docText(M2), moved);
    assert.deepEqual(notices.at(-1), {
      level: "error",
      message: '"Move T104 to 2026-11-09" was not undone: the files were not changed.',
      undo: undefined,
    });
    assert.equal(api.history.canUndo, true);
    assert.equal(api.history.canRedo, false);
    await panel.receive({ type: "undo" });
    assert.equal(docText(M2), original);
  });

  it("works out the edits between two texts, touching only what differs", () => {
    const apply = (from: string, to: string) => {
      const edits = diffEdits(from, to);
      return { text: applyEdits(from, edits), edits: edits.length };
    };
    // Ids added on save: one small edit per line.
    const from = "# M\n\n- [ ] A @est:4h\n- [ ] B\n- [ ] C\n";
    const to = "# M\n\n- [ ] A @est:4h ^T1\n- [ ] B ^T2\n- [ ] C\n";
    assert.deepEqual(apply(from, to), { text: to, edits: 2 });
    assert.deepEqual(diffEdits(from, to)[0], {
      range: { start: { line: 2, character: 15 }, end: { line: 2, character: 15 } },
      newText: " ^T1",
    });
    assert.deepEqual(apply(to, from), { text: from, edits: 2 });
    // Lines added or removed, line endings, emoji: never split.
    for (const [a, b] of [
      ["a\nb\nc\n", "a\nx\ny\nc\n"],
      ["a\r\nb\r\n", "a\nb\r\n"],
      ["x 😀 y\n", "x 😁 y\n"],
      ["", "a\n"],
      ["a\n", ""],
    ])
      assert.equal(apply(a, b).text, b);
    assert.deepEqual(diffEdits("same\n", "same\n"), []);
  });
});

/** The notices a panel sends from now on. */
function noticesOf(panel: GanttPanel): Array<{ level: string; message: string; undo?: number }> {
  const out: Array<{ level: string; message: string; undo?: number }> = [];
  const post = panel.post.bind(panel);
  panel.post = (m) => {
    if (m.type === "notice") out.push({ level: m.level, message: m.message, undo: m.undo });
    post(m);
  };
  return out;
}

/** Inserts a line (unsaved) above the first line that starts with `before`. */
async function insertAbove(rel: string, before: string, text: string): Promise<void> {
  const api = await getApi();
  const doc = await vscode.workspace.openTextDocument(planUri(rel));
  const at = doc.getText().indexOf(`\n${before}`) + 1;
  const edit = new vscode.WorkspaceEdit();
  edit.insert(doc.uri, doc.positionAt(at), `${text}\n`);
  assert.ok(await vscode.workspace.applyEdit(edit));
  const title = text.replace(/^- \[.\] /, "").replace(/ @.*$/, "");
  await waitFor(
    () => api.state.plan.file(rel)?.items.some((t) => t.title === title),
    "inserted line indexed"
  );
}

/** Removes `length` characters at the first occurrence of `text` (unsaved). */
async function removeText(rel: string, text: string, length: number): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(planUri(rel));
  const at = doc.getText().indexOf(text);
  const edit = new vscode.WorkspaceEdit();
  edit.delete(doc.uri, new vscode.Range(doc.positionAt(at), doc.positionAt(at + length)));
  assert.ok(await vscode.workspace.applyEdit(edit));
}
