import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { valuesArg } from "../../src/extension/commands/args";
import { type KanbanPanel } from "../../src/extension/webviews/kanbanPanel";
import { type ResourcesPanel } from "../../src/extension/webviews/resourcesPanel";
import { type MilestoneNode } from "../../src/extension/views/milestonesTree";
import { existsSync } from "node:fs";
import { deleteMilestoneLinks } from "../../src/core/writer/entities";
import { docText, getApi, planUri, readPlanFile, restorePlan, TODAY, waitFor } from "./helpers";

const M2 = "milestones/M2-backend.md";
const M3 = "milestones/M3-frontend.md";
const M6 = "milestones/M6-documentation.md";

/** Asserts the end of a document (with a readable message when it differs). */
function assertEndsWith(rel: string, expected: string): void {
  assert.equal(docText(rel).slice(-expected.length), expected);
}

function line(rel: string, id: string): string | undefined {
  return docText(rel)
    .split("\n")
    .find((l) => l.endsWith(`^${id}`));
}

async function run<T>(command: string, ...args: unknown[]): Promise<T> {
  return vscode.commands.executeCommand<T>(command, ...args);
}

/** Files created by the tests are not part of the sample: delete them again. */
async function removeCreated(): Promise<void> {
  const api = await getApi();
  const edit = new vscode.WorkspaceEdit();
  edit.deleteFile(planUri(M6), { ignoreIfNotExists: true });
  await vscode.workspace.applyEdit(edit);
  await waitFor(() => !api.service.index.get(M6), "created milestone removed");
}

async function lensTitles(rel: string): Promise<Array<{ line: number; title: string }>> {
  const lenses = await waitFor(async () => {
    const l = await run<vscode.CodeLens[]>("vscode.executeCodeLensProvider", planUri(rel), 100);
    return l.length ? l : undefined;
  }, `code lenses of ${rel}`);
  return lenses.map((l) => ({ line: l.range.start.line, title: l.command?.title ?? "" }));
}

describe("create and edit from the user interface", () => {
  before(async () => {
    await getApi();
    await restorePlan();
  });
  afterEach(async () => {
    await restorePlan();
    await removeCreated();
  });

  it("adds a task to a section and a subtask under a task", async () => {
    const api = await getApi();
    const id = await run<string>(
      "planner.addTask",
      { milestone: "M2", section: "Billing", reveal: false },
      { title: "Billing report export", owner: "sam", est: "4h", deps: ["T113"], tags: ["billing"] }
    );
    assert.equal(id, "T408");
    assert.ok(
      docText(M2).includes(
        "#billing ^T115\n- [ ] Billing report export @est:4h @owner:sam @dep:T113 #billing ^T408\n"
      )
    );
    await waitFor(() => api.state.plan.taskById("T408"), "new task indexed");
    const sub = await run<string>("planner.addSubtask", "T102", { title: "Unit tests", est: "2h" });
    assert.equal(sub, "T409");
    assert.ok(
      docText(M2).includes(
        "order and payment events only for now.\n  - [ ] Unit tests @est:2h ^T409\n- [ ] Payment provider"
      )
    );
    const t = await waitFor(() => api.state.plan.taskById("T409"), "subtask indexed");
    assert.equal(t.parent?.id, "T102");
  });

  it("edits a task, a punch item, and resolves Gantt/Kanban keys", async () => {
    const api = await getApi();
    assert.ok(
      await run<boolean>("planner.editTask", "T121", {
        title: "Shared API library",
        status: "doing",
        attrs: { owner: "priya", est: "4d" },
        addTags: ["library"],
      })
    );
    assert.equal(
      line(M2, "T121"),
      `- [/] Shared API library @est:4d @owner:priya @started:${TODAY} #backend #library ^T121`
    );
    await waitFor(() => api.state.plan.taskById("T121")?.owner === "priya", "index");
    // Webview context menus pass { webviewSection, key }.
    assert.ok(
      await run<boolean>(
        "planner.editTask",
        { webviewSection: "task", key: "T122" },
        { attrs: { prio: "high" }, removeTags: ["notifications"] }
      )
    );
    assert.equal(
      line(M2, "T122"),
      "- [ ] Notifications and e-mail service @est:12h @owner:sam @dep:T121 @prio:high #backend ^T122"
    );
    assert.ok(
      await run<boolean>("planner.editTask", "P002", {
        attrs: { owner: "sam", due: "2026-11-01" },
      })
    );
    assert.equal(
      line("punchlist.md", "P002"),
      "- [ ] Error text for an expired card is missing @sev:C @owner:sam @due:2026-11-01 @from:UAT-01/TC-02 #notifications ^P002"
    );
  });

  it("takes tree nodes and Gantt rows as targets, never as values", async () => {
    const api = await getApi();
    const m2 = api.state.plan.milestoneById("M2")!;
    const common = m2.sections.find((x) => x.title === "Common")!;
    // The "+" on a section row passes the tree node.
    const a = await run<string>(
      "planner.addTask",
      { kind: "section", milestone: m2, section: common },
      { title: "Library tests" }
    );
    assert.ok(docText(M2).includes(`#notifications ^T122\n- [ ] Library tests ^${a}\n`));
    await waitFor(() => api.state.plan.taskById(a), "indexed");
    // "Add task…" in the Gantt context menu of a section row.
    const b = await run<string>(
      "planner.addTask",
      { webviewSection: "section", key: `section:M2:${common.line}` },
      { title: "Library docs" }
    );
    assert.ok(docText(M2).includes(`^${a}\n- [ ] Library docs ^${b}\n`));
    // Toolbar commands receive the focused node or a view context: not values.
    const context = { $treeViewId: "planner.milestones", $focusedTreeItem: true };
    assert.equal(valuesArg(context, ["id", "name"], ["id", "name"]), undefined);
    assert.equal(valuesArg({ kind: "milestone", milestone: m2 }, ["id", "name"]), undefined);
    assert.equal(valuesArg([{ title: "x" }], ["title"], ["title"]), undefined);
    assert.deepEqual(valuesArg({ title: "x" }, ["title", "est"], ["title"]), { title: "x" });
  });

  it("moves a task to another milestone and deletes a task with its dependencies", async () => {
    const api = await getApi();
    assert.equal(await run<string>("planner.moveTask", "T115", { milestone: "M5" }), "T115");
    await waitFor(() => api.state.plan.taskById("T115")?.milestoneId === "M5", "task moved");
    assert.equal(line(M2, "T115"), undefined);

    assert.ok(await run<boolean>("planner.deleteTask", "T121", { confirm: false }));
    assert.equal(line(M2, "T121"), undefined);
    assert.equal(
      line(M2, "T122"),
      "- [ ] Notifications and e-mail service @est:12h @owner:sam #backend #notifications ^T122"
    );
    assert.equal(
      line(M2, "T110"),
      "- [ ] Account and profile services @est:4d @owner:alex @eq:accounts #accounts ^T110"
    );
    await waitFor(() => !api.state.plan.taskById("T121"), "task deleted");
    assert.ok(
      !api.state.plan.tasks.some((t) => t.deps.some((d) => d.id === "T121")),
      "no broken dependency left"
    );
  });

  it("deletes a milestone with every dependency on it, and reverts it", async () => {
    const api = await getApi();
    const M1 = "milestones/M1-discovery-design.md";
    const before = new Map([M1, M2, M3].map((rel) => [rel, readPlanFile(rel)]));
    assert.ok(await run<boolean>("planner.deleteMilestone", "M1", { confirm: false }));
    await waitFor(() => !api.state.plan.milestoneById("M1"), "milestone deleted");
    assert.ok(!existsSync(planUri(M1).fsPath));
    for (const rel of [M2, M3]) assert.doesNotMatch(docText(rel), /^depends:/m);
    // From a Gantt milestone row: tasks of other milestones lose their dependencies on its tasks.
    assert.ok(
      await run<boolean>(
        "planner.deleteMilestone",
        { webviewSection: "milestone", key: "milestone:M2" },
        { confirm: false }
      )
    );
    await waitFor(() => !api.state.plan.milestoneById("M2"), "second milestone deleted");
    assert.equal(
      line(M3, "T207"),
      "- [ ] Billing pages @est:2d @owner:priya @dep:T203 #frontend #billing ^T207"
    );
    const plan = api.state.plan;
    assert.ok(
      plan.tasks.every((t) => t.deps.every((d) => plan.taskById(d.id))),
      "no broken dependency left"
    );

    // The Undo of the message: the file comes back and the other files are as they were.
    await restorePlan();
    const m1 = api.state.plan.milestoneById("M1")!;
    const revert = await api.service.applyRevertible(deleteMilestoneLinks(api.state.plan, m1), {
      source: "view",
      deleteFiles: [m1.file],
    });
    assert.ok(revert && !existsSync(planUri(M1).fsPath));
    assert.ok(await revert());
    await waitFor(() => api.state.plan.milestoneById("M1"), "milestone restored");
    for (const [rel, text] of before) assert.equal(docText(rel), text, rel);
    assert.equal(await revert(), false, "a second undo is refused");
  });

  it("removes a person and hands their tasks and punch items over", async () => {
    const api = await getApi();
    const owned = () =>
      [...api.state.plan.tasks, ...api.state.plan.punch].filter((t) => t.owner === "sam");
    const count = owned().length;
    assert.ok(count > 0);
    assert.equal(
      await run<boolean>("planner.removePerson", "sam", { reassignTo: "sam", confirm: false }),
      false,
      "not to themselves"
    );
    assert.ok(
      await run<boolean>("planner.removePerson", "sam", { reassignTo: "priya", confirm: false })
    );
    await waitFor(() => !api.state.plan.personById("sam"), "person removed");
    assert.doesNotMatch(docText("team.md"), /^## Sam$/m);
    assert.equal(owned().length, 0);
    assert.match(line(M2, "T102")!, /@owner:priya /);
    assert.match(docText("punchlist.md"), /cancelled payment @sev:A @owner:priya /);
    // Without an heir their items are left unassigned.
    assert.ok(await run<boolean>("planner.removePerson", "maria", { confirm: false }));
    await waitFor(() => !api.state.plan.personById("maria"), "second person removed");
    assert.ok(!api.state.plan.tasks.some((t) => t.owner === "maria"));
  });

  it("adds a section that offers 'Add a task…' until it has one", async () => {
    const api = await getApi();
    const section = "Unit 400 – Packaging";
    assert.equal(await run<string>("planner.addSection", "M2", section), section);
    assertEndsWith(M2, `\n## ${section}\n`);
    const m2 = api.milestones
      .getChildren()
      .find((n) => n.kind === "milestone" && n.milestone.id === "M2")!;
    const node = await waitFor(
      () =>
        api.milestones
          .getChildren(m2)
          .find(
            (n): n is Extract<MilestoneNode, { kind: "section" }> =>
              n.kind === "section" && n.section.title === section
          ),
      "new section shown"
    );
    const [placeholder] = api.milestones.getChildren(node);
    assert.equal(placeholder.kind, "add");
    const item = api.milestones.getTreeItem(placeholder);
    assert.equal(item.label, "Add a task…");
    assert.equal(item.command?.command, "planner.addTask");
    // The placeholder's arguments, plus values instead of the form.
    const id = await run<string>(
      "planner.addTask",
      { ...(item.command!.arguments![0] as object), reveal: false },
      { title: "Packaging FBs", est: "2d" }
    );
    assertEndsWith(M2, `## ${section}\n\n- [ ] Packaging FBs @est:2d ^${id}\n`);
    await waitFor(() => api.state.plan.taskById(id!), "task indexed");
    // Nodes hold the plan they were built from: get them again.
    const m2now = api.milestones
      .getChildren()
      .find((n) => n.kind === "milestone" && n.milestone.id === "M2")!;
    const fresh = api.milestones
      .getChildren(m2now)
      .find((n) => n.kind === "section" && n.section.title === section)!;
    assert.deepEqual(
      api.milestones.getChildren(fresh).map((n) => n.kind),
      ["task"]
    );
  });

  it("creates and edits a milestone", async () => {
    const api = await getApi();
    const id = await run<string>("planner.addMilestone", {
      id: "M6",
      name: "Documentation",
      target: "2027-04-15",
      depends: ["M5"],
    });
    assert.equal(id, "M6");
    assert.equal(
      docText(M6),
      "# M6 – Documentation\n\nid: M6\ntarget: 2027-04-15\nstatus: planned\ndepends: M5\n"
    );
    await waitFor(() => api.state.plan.milestoneById("M6"), "milestone indexed");
    const m6 = api.milestones
      .getChildren()
      .find((n) => n.kind === "milestone" && n.milestone.id === "M6")!;
    assert.deepEqual(
      api.milestones.getChildren(m6).map((n) => n.kind),
      ["add"]
    );
    assert.ok(
      await run<boolean>("planner.editMilestone", "M6", {
        name: "Documentation & handover",
        target: "2027-04-30",
        status: "active",
      })
    );
    assert.equal(
      docText(M6),
      "# M6 – Documentation & handover\n\nid: M6\ntarget: 2027-04-30\nstatus: active\ndepends: M5\n"
    );
  });

  it("captures to the inbox and adds punch items", async () => {
    assert.ok(await run<boolean>("planner.captureInbox", "Order spare fuses #infrastructure"));
    assertEndsWith("inbox.md", "#infrastructure\n- [ ] Order spare fuses #infrastructure\n");
    const id = await run<string>(
      "planner.addPunchItem",
      { status: "doing" },
      { title: "Login page is slow", sev: "C", owner: "priya" }
    );
    assert.equal(id, "P008");
    assert.equal(
      line("punchlist.md", "P008"),
      `- [/] Login page is slow @sev:C @owner:priya @started:${TODAY} ^P008`
    );
  });

  it("adds a card from a Kanban column with the column's status and the filter's owner", async () => {
    const api = await getApi();
    await vscode.commands.executeCommand("planner.openKanban");
    const panel: KanbanPanel = await waitFor(() => api.kanban(), "kanban panel");
    await panel.receive({
      type: "options",
      options: { board: "tasks", swimlane: "none", showCancelled: false, cardMode: "tasks" },
    });
    await panel.receive({ type: "filter", filter: { owner: ["priya"], milestone: ["M3"] } });
    const target = panel.addTarget("doing");
    assert.deepEqual(target, { status: "doing", owner: "priya", milestone: "M3", reveal: false });
    const id = await run<string>(
      "planner.addTask",
      { ...target, section: "Framework" },
      { title: "Login screen" }
    );
    assert.equal(line(M3, id!), `- [/] Login screen @owner:priya @started:${TODAY} ^${id}`);
    assert.ok(docText(M3).includes(`#frontend ^T203\n- [/] Login screen`));
    await panel.receive({
      type: "options",
      options: { board: "punch", swimlane: "none", showCancelled: false, cardMode: "tasks" },
    });
    await panel.receive({ type: "filter", filter: { owner: ["priya"] } });
    assert.deepEqual(panel.addTarget("todo"), { status: "todo", owner: "priya" });
    await panel.receive({ type: "filter", filter: {} });
    assert.deepEqual(panel.addTarget("todo"), { status: "todo", owner: undefined });
  });

  it("adds and edits people and time off; a rename keeps the owner id", async () => {
    const api = await getApi();
    const id = await run<string>("planner.addPerson", {
      name: "Chris Baker",
      role: "Data engineer",
      capacity: "40h/week",
      skills: ["infrastructure"],
      color: "red",
    });
    assert.equal(id, "chris-baker");
    assertEndsWith(
      "team.md",
      "color: yellow\n\n## Chris Baker\n\nid: chris-baker\nrole: Data engineer\ncapacity: 40h/week\nskills: infrastructure\ncolor: red\n"
    );
    await waitFor(() => api.state.plan.personById("chris-baker"), "person indexed");
    assert.ok(await run<boolean>("planner.addTimeOff", "chris-baker", "2026-12-01..2026-12-05"));
    assertEndsWith("team.md", "color: red\noff: 2026-12-01..2026-12-05\n");
    assert.equal(
      await run<boolean>("planner.addTimeOff", "chris-baker", "2026-12-05..2026-12-01"),
      false
    );

    assert.ok(
      await run<boolean>(
        "planner.editPerson",
        { id: "sam" },
        { name: "Sam Taylor", capacity: "32h/week" }
      )
    );
    const team = docText("team.md");
    assert.equal(
      team.slice(team.indexOf("## Sam"), team.indexOf("## Priya")),
      "## Sam Taylor\n\nid: sam\nrole: Backend developer\ncapacity: 32h/week\nskills: backend, frontend\n" +
        "color: green\noff: 2026-11-17..2026-11-21\noff: 2027-02-09 # single day; multiple off: lines allowed\n" +
        "overtime: 2026-11-02..2026-11-13 +8h/week # catch up on M2 before the holiday\n\n"
    );
    await waitFor(() => api.state.plan.personById("sam")?.name === "Sam Taylor", "rename indexed");
    assert.equal(api.state.plan.taskById("T121")?.owner, "sam");
    assert.equal(api.state.plan.personById("sam")?.capacityHours, 32);
  });

  it("plans overtime and extra working days, and shows them in the team load", async () => {
    const api = await getApi();
    assert.ok(
      await run<boolean>("planner.addOvertime", "priya", "2026-11-16..2026-11-20 +8h/week")
    );
    assert.ok(await run<boolean>("planner.addWorkday", { id: "priya" }, "2026-11-21 6h"));
    assert.equal(await run<boolean>("planner.addOvertime", "priya", "next week"), false);
    assert.equal(await run<boolean>("planner.addWorkday", "priya", "2026-11-21 30h"), false);
    const team = docText("team.md");
    assert.ok(
      team
        .slice(team.indexOf("## Priya"), team.indexOf("## Jordan"))
        .endsWith(
          "off: 2026-12-28..2027-01-08\novertime: 2026-11-16..2026-11-20 +8h/week\nworkday: 2026-11-21 6h\n\n"
        )
    );
    const priya = await waitFor(
      () =>
        api.state.plan.personById("priya")?.workdays.length
          ? api.state.plan.personById("priya")
          : undefined,
      "indexed"
    );
    assert.equal(priya.overtime[0].hours, 8);
    // The person form edits the lists as a whole.
    assert.ok(
      await run<boolean>("planner.editPerson", "priya", {
        overtime: [],
        workday: ["2026-11-21 6h", "2026-11-28"],
      })
    );
    assert.ok(
      docText("team.md").includes(
        "off: 2026-12-28..2027-01-08\nworkday: 2026-11-21 6h\nworkday: 2026-11-28\n"
      )
    );
    // Team load: Sam's overtime of the sample is scheduled in W45.
    const panel = await vscode.commands.executeCommand<ResourcesPanel>("planner.openResources");
    await panel.receive({ type: "mode", mode: "capacity" });
    const sam = panel.model().rows.find((r) => r.id === "sam")!;
    assert.deepEqual(
      (({ normal, overtimeCapacity, overtime }) => ({ normal, overtimeCapacity, overtime }))(
        sam.cells.find((c) => c.week === "2026-W45")!
      ),
      { normal: 40, overtimeCapacity: 8, overtime: 8 }
    );
    // The tasks that use Sam's overtime say so in their CodeLens.
    const m2 = await lensTitles("milestones/M2-backend.md");
    assert.ok(
      m2.some((l) => l.title.endsWith("· 1.6 h overtime")),
      m2.map((l) => l.title).join("\n")
    );
    // CodeLens in team.md and the person's hover description.
    const lenses = await lensTitles("team.md");
    assert.ok(lenses.some((l) => l.title === "$(watch) Plan overtime"));
    assert.ok(lenses.some((l) => l.title === "$(add) Add working day"));
  });

  it("completes extra working days and overtime periods in team.md", async () => {
    const editor = await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(planUri("team.md"))
    );
    const line = editor.document.getText().split("\n").indexOf("off: 2026-12-28..2027-01-08");
    const pos = new vscode.Position(line + 1, 0);
    await editor.edit((b) => b.insert(pos, "workday: \n"));
    const labels = async (p: vscode.Position) =>
      (
        await vscode.commands.executeCommand<vscode.CompletionList>(
          "vscode.executeCompletionItemProvider",
          editor.document.uri,
          p
        )
      ).items.map((i) => (typeof i.label === "string" ? i.label : i.label.label));
    const days = await labels(new vscode.Position(line + 1, "workday: ".length));
    assert.deepEqual(days.slice(0, 3), ["2026-10-17", "2026-10-18", "2026-10-24"]);
    await editor.edit((b) =>
      b.replace(new vscode.Range(line + 1, 0, line + 1, "workday: ".length), "overtime: ")
    );
    const periods = await labels(new vscode.Position(line + 1, "overtime: ".length));
    assert.ok(periods.includes("2026-10-19..2026-10-23 +8h/week"), periods.join());
  });

  it("edits the project calendar", async () => {
    const api = await getApi();
    assert.ok(
      await run<boolean>("planner.editProject", {
        hoursPerDay: "7.5",
        holidays: ["2026-12-25", "2026-12-26", "2027-01-01", "2027-04-27", "2027-05-05"],
      })
    );
    assert.ok(
      docText("project.md").includes(
        "hoursPerDay: 7.5\nbudget: 800h # hours agreed with the customer\nholidays: 2026-12-25, 2026-12-26, 2027-01-01, 2027-04-27, 2027-05-05\n"
      )
    );
    await waitFor(() => api.state.plan.project.hoursPerDay === 7.5, "project indexed");
  });

  it("sets the budget from the project form and warns when the forecast is over it", async () => {
    const api = await getApi();
    // The sample is 26 h over its 800 h budget: a warning on the budget line says why.
    const warning = await waitFor(
      () =>
        vscode.languages
          .getDiagnostics(planUri("project.md"))
          .find((d) => d.code === "over-budget"),
      "over-budget warning"
    );
    assert.match(warning.message, /^Forecast 826 h is 26 h over the budget of 800 h\./);
    assert.ok(await run<boolean>("planner.editProject", { budget: "110d" }));
    assert.ok(docText("project.md").includes("budget: 110d # hours agreed with the customer\n"));
    await waitFor(() => api.state.plan.project.budget === 880, "budget indexed");
    await waitFor(
      () =>
        !vscode.languages
          .getDiagnostics(planUri("project.md"))
          .some((d) => d.code === "over-budget"),
      "warning gone"
    );
    assert.ok(await run<boolean>("planner.editProject", { budget: "" }));
    assert.ok(!docText("project.md").includes("budget:"));
  });

  it("shows clickable actions as CodeLens and hides them with planner.codeLens.actions", async () => {
    const m2 = await lensTitles(M2);
    const at = (needle: string) =>
      docText(M2)
        .split("\n")
        .findIndex((l) => l.includes(needle));
    const titlesAt = (lenses: typeof m2, n: number) =>
      lenses.filter((l) => l.line === n).map((l) => l.title);
    assert.deepEqual(titlesAt(m2, 0).slice(1), [
      "$(add) Add task",
      "$(list-tree) Add section",
      "$(edit) Edit milestone",
    ]);
    assert.ok(titlesAt(m2, at("^T121")).includes("$(person) Sam"));
    assert.ok(titlesAt(m2, at("^T104")).includes("$(person) Sam (from the parent)"));
    assert.ok(titlesAt(m2, at("^T112")).includes("$(person) Assign owner"));
    assert.ok(titlesAt(m2, at("^T112")).includes("$(edit) Edit"));
    const team = await lensTitles("team.md");
    assert.deepEqual(titlesAt(team, 0), ["$(person-add) Add person"]);
    assert.ok(team.some((l) => l.title === "$(calendar) Add time off"));
    const settings = vscode.workspace.getConfiguration("planner");
    await settings.update("codeLens.actions", false, vscode.ConfigurationTarget.Workspace);
    try {
      const plain = await lensTitles(M2);
      assert.ok(
        plain.every((l) => !l.title.startsWith("$(")),
        "only schedule lenses"
      );
    } finally {
      await settings.update("codeLens.actions", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });
});
