import * as assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import * as vscode from "vscode";
import { overloadedWeeks } from "../../src/core/views/resources";
import { type DashboardPanel } from "../../src/extension/webviews/dashboardPanel";
import { copiesLine, lineAfter } from "../../src/extension/timer";
import { type ResourcesPanel } from "../../src/extension/webviews/resourcesPanel";
import {
  docText,
  getApi,
  openPlanFile,
  planUri,
  positionOf,
  restorePlan,
  TODAY,
  waitFor,
} from "./helpers";

const M2 = "milestones/M2-backend.md";

function line(rel: string, id: string): string {
  return docText(rel)
    .split("\n")
    .find((l) => l.endsWith(`^${id}`))!;
}

/** Stops the running timer as if it ran for 50 minutes (1h when rounded). */
async function stopAfter50Minutes(): Promise<number | undefined> {
  const api = await getApi();
  const running = api.timer.running!;
  api.timer.now = () => running.startedAt + 50 * 60_000;
  try {
    return await vscode.commands.executeCommand<number | undefined>("planner.stopTimer");
  } finally {
    api.timer.now = () => Date.now();
  }
}

/** Pastes a copy of a task line with `id` before `## Notes` in M2, with the cursor on it. */
async function paste(text: string, id: string): Promise<vscode.Position> {
  const api = await getApi();
  const editor = await openPlanFile(M2);
  const pos = await positionOf(M2, "## Notes");
  await editor.edit((b) => b.insert(pos, `${text}\n\n`));
  await waitFor(() => api.state.plan.tasks.filter((t) => t.id === id).length === 2, "copy indexed");
  editor.selection = new vscode.Selection(pos, pos);
  return pos;
}

/** Types a line above everything the tests paste (before `## Common` in M2). */
async function typeAbove(text: string): Promise<void> {
  const editor = await openPlanFile(M2);
  const heading = await positionOf(M2, "## Common");
  await editor.edit((b) => b.insert(heading, `${text}\n`));
}

/**
 * Copies a line of M2 as Copy Line Down or Up does: the copy goes in above the line (Down) or below
 * it (Up). Returns the line the cursor is left on, which the editor takes for the original line:
 * the one people then edit as the copy.
 */
async function copyLine(line: number, down: boolean): Promise<number> {
  const editor = await openPlanFile(M2);
  const text = editor.document.lineAt(line).text;
  await editor.edit((b) =>
    down
      ? b.insert(new vscode.Position(line, 0), `${text}\n`)
      : b.insert(new vscode.Position(line, text.length), `\n${text}`)
  );
  return down ? line + 1 : line;
}

/** Runs `f` and returns the warnings it showed, instead of showing them. */
async function warnings(f: () => Promise<unknown>): Promise<string[]> {
  const window = vscode.window as unknown as { showWarningMessage: (m: string) => unknown };
  const original = window.showWarningMessage;
  const shown: string[] = [];
  window.showWarningMessage = (m: string) => {
    shown.push(m);
    return Promise.resolve(undefined);
  };
  try {
    await f();
  } finally {
    window.showWarningMessage = original;
  }
  return shown;
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

  it("tells, on the person in team.md, when their workload makes a task late", async () => {
    const editor = await openPlanFile(M2);
    const pos = await positionOf(M2, "## Notes");
    // Due tomorrow, low priority: Sam does the other work first.
    await editor.edit((b) =>
      b.insert(pos, "- [ ] Urgent small fix @est:1d @owner:sam @due:2026-10-15 @prio:low\n\n")
    );
    const diag = await waitFor(
      () =>
        vscode.languages
          .getDiagnostics(planUri("team.md"))
          .find((x) => x.code === "overbooked" && x.message.startsWith("Sam ")),
      "workload diagnostic"
    );
    assert.match(
      diag.message,
      /^Sam has [\d.]+h of open work, about \d+ weeks at 40h a week, planned until \d{4}-\d\d-\d\d\. This task finishes after the deadline because Sam has other work first: Urgent small fix \(\d+ working days late\)\./
    );
    assert.equal(diag.severity, vscode.DiagnosticSeverity.Information);
    assert.ok(!vscode.languages.getDiagnostics(planUri(M2)).some((x) => x.code === "overbooked"));
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

  it("puts a task back to to do when its timer is stopped within a minute", async () => {
    const api = await getApi();
    const before = line(M2, "T121");
    await vscode.commands.executeCommand("planner.startTimer", "T121");
    await waitFor(() => api.state.plan.taskById("T121")?.status === "doing", "index");
    const hours = await vscode.commands.executeCommand<number>("planner.stopTimer");
    assert.equal(hours, 0);
    assert.equal(line(M2, "T121"), before);
  });

  it("puts back a done parent the timer reopened when it is stopped within a minute", async () => {
    const api = await getApi();
    const editor = await openPlanFile(M2);
    const pos = await positionOf(M2, "## Notes");
    // A subtask left open when its parent was finished ("Only this task").
    const parent = "- [x] Release checklist @est:4h @started:2026-10-01 @done:2026-10-10 ^T150";
    const subtask = "  - [ ] Kept open @est:1h ^T151";
    await editor.edit((b) => b.insert(pos, `${parent}\n${subtask}\n\n`));
    await waitFor(() => api.state.plan.taskById("T151"), "indexed");
    assert.equal(await vscode.commands.executeCommand("planner.startTimer", "T151"), true);
    assert.equal(line(M2, "T150"), "- [/] Release checklist @est:4h @started:2026-10-01 ^T150");
    await waitFor(() => api.state.plan.taskById("T151")?.status === "doing", "index");
    assert.equal(await vscode.commands.executeCommand("planner.stopTimer"), 0);
    assert.equal(line(M2, "T150"), parent);
    assert.equal(line(M2, "T151"), subtask);
  });

  it("puts back lines that the save starting the timer gave ids", async () => {
    const api = await getApi();
    const editor = await openPlanFile(M2);
    const pos = await positionOf(M2, "## Notes");
    const parent = "- [x] Release checklist @est:4h @started:2026-10-01 @done:2026-10-10 ^T150";
    await editor.edit((b) => b.insert(pos, `${parent}\n\n`));
    await editor.document.save();
    // Typed under it and not saved: starting the timer saves the file, which gives them ids.
    const at = pos.translate(1);
    await editor.edit((b) =>
      b.insert(at, "  - [ ] Follow-up @est:2h\n    - [ ] Fix typos @est:1h\n")
    );
    await waitFor(() => api.state.plan.tasks.some((t) => t.title === "Fix typos"), "indexed");
    editor.selection = new vscode.Selection(at.translate(1), at.translate(1));
    assert.equal(await vscode.commands.executeCommand("planner.startTimer"), true);
    const lines = () =>
      docText(M2)
        .split("\n")
        .slice(pos.line, pos.line + 3);
    const started = lines();
    assert.equal(started[0], "- [/] Release checklist @est:4h @started:2026-10-01 ^T150");
    assert.match(
      started[1],
      new RegExp(`^  - \\[/\\] Follow-up @est:2h @started:${TODAY} \\^T\\d+$`)
    );
    assert.match(
      started[2],
      new RegExp(`^    - \\[/\\] Fix typos @est:1h @started:${TODAY} \\^T\\d+$`)
    );
    // The timer follows the task by the id it was given.
    assert.equal(api.timer.running?.key, started[2].slice(started[2].lastIndexOf("^") + 1));
    assert.equal(await vscode.commands.executeCommand("planner.stopTimer"), 0);
    const id = (l: string) => l.slice(l.lastIndexOf(" ^"));
    assert.deepEqual(lines(), [
      parent,
      `  - [ ] Follow-up @est:2h${id(started[1])}`,
      `    - [ ] Fix typos @est:1h${id(started[2])}`,
    ]);
  });

  it("puts back a line whose trailing spaces the save starting the timer trimmed", async () => {
    const api = await getApi();
    const files = vscode.workspace.getConfiguration("files", { languageId: "markdown" });
    await files.update("trimTrailingWhitespace", true, vscode.ConfigurationTarget.Workspace, true);
    try {
      const editor = await openPlanFile(M2);
      const pos = await positionOf(M2, "## Notes");
      await editor.edit((b) => b.insert(pos, "- [ ] Spaces at the end @est:1h ^T150  \n\n"));
      await waitFor(() => api.state.plan.taskById("T150"), "indexed");
      assert.equal(await vscode.commands.executeCommand("planner.startTimer", "T150"), true);
      assert.equal(line(M2, "T150"), `- [/] Spaces at the end @est:1h @started:${TODAY} ^T150`);
      assert.equal(await vscode.commands.executeCommand("planner.stopTimer"), 0);
      assert.equal(line(M2, "T150"), "- [ ] Spaces at the end @est:1h ^T150");
    } finally {
      await files.update(
        "trimTrailingWhitespace",
        undefined,
        vscode.ConfigurationTarget.Workspace,
        true
      );
    }
  });

  it("puts back each line on its own: a done parent also when its subtask changed", async () => {
    const api = await getApi();
    const editor = await openPlanFile(M2);
    const pos = await positionOf(M2, "## Notes");
    // Subtasks left open when their parent was finished ("Only this task").
    const parent = "- [x] Release checklist @est:4h @started:2026-10-01 @done:2026-10-10 ^T150";
    const subtasks = "  - [ ] Notes @est:1h ^T151\n  - [ ] Slides @est:2h ^T152\n";
    await editor.edit((b) => b.insert(pos, `${parent}\n${subtasks}\n`));
    await waitFor(() => api.state.plan.taskById("T152"), "indexed");
    assert.equal(await vscode.commands.executeCommand("planner.startTimer", "T151"), true);
    assert.equal(line(M2, "T150"), "- [/] Release checklist @est:4h @started:2026-10-01 ^T150");
    // Within the minute the subtask is finished, and the parent's title is edited.
    assert.equal(await vscode.commands.executeCommand("planner.setStatus", "T151", "done"), true);
    const title = await positionOf(M2, "Release checklist");
    await editor.edit((b) => b.replace(new vscode.Range(title, title.translate(0, 7)), "Launch"));
    assert.equal(await vscode.commands.executeCommand("planner.stopTimer"), 0);
    assert.equal(
      line(M2, "T150"),
      "- [x] Launch checklist @est:4h @started:2026-10-01 @done:2026-10-10 ^T150"
    );
    assert.equal(line(M2, "T151"), `  - [x] Notes @est:1h @started:${TODAY} @done:${TODAY} ^T151`);
    assert.equal(line(M2, "T152"), "  - [ ] Slides @est:2h ^T152");
  });

  it("puts back the date of a done parent finished again within the minute", async () => {
    const api = await getApi();
    const editor = await openPlanFile(M2);
    const pos = await positionOf(M2, "## Notes");
    const parent = "- [x] Release checklist @est:4h @started:2026-10-01 @done:2026-10-10 ^T150";
    await editor.edit((b) => b.insert(pos, `${parent}\n  - [ ] Kept open @est:1h ^T151\n\n`));
    await waitFor(() => api.state.plan.taskById("T151"), "indexed");
    assert.equal(await vscode.commands.executeCommand("planner.startTimer", "T151"), true);
    // Its last open subtask finished: the parent the timer reopened is done again, today.
    assert.equal(await vscode.commands.executeCommand("planner.setStatus", "T151", "done"), true);
    assert.equal(
      line(M2, "T150"),
      `- [x] Release checklist @est:4h @started:2026-10-01 @done:${TODAY} ^T150`
    );
    assert.equal(await vscode.commands.executeCommand("planner.stopTimer"), 0);
    assert.equal(line(M2, "T150"), parent);
    assert.equal(
      line(M2, "T151"),
      `  - [x] Kept open @est:1h @started:${TODAY} @done:${TODAY} ^T151`
    );
  });

  it("puts back a task that moved or was edited, not one whose status changed", async () => {
    const api = await getApi();
    const editor = await openPlanFile(M2);
    const before = line(M2, "T121");
    const start = async () => {
      assert.equal(await vscode.commands.executeCommand("planner.startTimer", "T121"), true);
      await waitFor(() => api.state.plan.taskById("T121")?.status === "doing", "index");
    };
    await start();
    const heading = await positionOf(M2, "## Common");
    await editor.edit((b) => b.insert(heading, "Typed while the timer ran.\n\n"));
    assert.equal(await vscode.commands.executeCommand("planner.stopTimer"), 0);
    assert.equal(line(M2, "T121"), before);

    // Its title edited: the edit stays, the status and its date go back.
    await start();
    const title = await positionOf(M2, "Shared API library");
    await editor.edit((b) => b.replace(new vscode.Range(title, title.translate(0, 6)), "Common"));
    assert.equal(await vscode.commands.executeCommand("planner.stopTimer"), 0);
    assert.equal(line(M2, "T121"), before.replace("Shared API", "Common API"));

    // Its status changed: left as it is.
    await start();
    assert.equal(await vscode.commands.executeCommand("planner.setStatus", "T121", "review"), true);
    const review = line(M2, "T121");
    assert.equal(await vscode.commands.executeCommand("planner.stopTimer"), 0);
    assert.equal(line(M2, "T121"), review);
  });

  it("starts a timer on a task without an id while another runs in the same file", async () => {
    const api = await getApi();
    assert.equal(await vscode.commands.executeCommand("planner.startTimer", "T121"), true);
    const running = api.timer.running!;
    api.timer.now = () => running.startedAt + 30 * 60_000;
    try {
      const editor = await openPlanFile(M2);
      const pos = await positionOf(M2, "## Notes");
      await editor.edit((b) => b.insert(pos, "- [ ] Fix login bug @est:2h\n\n"));
      await waitFor(() => api.state.plan.tasks.some((t) => t.title === "Fix login bug"), "indexed");
      editor.selection = new vscode.Selection(pos, pos);
      // Stopping the other timer logs its time and saves the file, which gives this task an id.
      assert.equal(await vscode.commands.executeCommand("planner.startTimer"), true);
      assert.match(line(M2, "T121"), /@act:0.5h/);
      const started = docText(M2).split("\n")[pos.line];
      assert.match(
        started,
        new RegExp(`^- \\[/\\] Fix login bug @est:2h @started:${TODAY} \\^T\\d+$`)
      );
      assert.equal(api.timer.running?.key, started.slice(started.lastIndexOf("^") + 1));
    } finally {
      await vscode.commands.executeCommand("planner.stopTimer");
      api.timer.now = () => Date.now();
    }
  });

  it("starts a timer on a renamed copy that stopping the other timer gives a new id", async () => {
    const api = await getApi();
    assert.equal(await vscode.commands.executeCommand("planner.startTimer", "T121"), true);
    const running = api.timer.running!;
    api.timer.now = () => running.startedAt + 30 * 60_000;
    try {
      // A copy of T104 made into another task, not saved yet.
      const pos = await paste("- [ ] Payment events schema @est:6h ^T104", "T104");
      // Stopping the other timer saves the file, which gives the copy a new id.
      assert.equal(await vscode.commands.executeCommand("planner.startTimer"), true);
      assert.match(line(M2, "T121"), /@act:0.5h/);
      const started = docText(M2).split("\n")[pos.line];
      assert.match(
        started,
        new RegExp(`^- \\[/\\] Payment events schema @est:6h @started:${TODAY} \\^T\\d+$`)
      );
      const id = started.slice(started.lastIndexOf("^") + 1);
      assert.notEqual(id, "T104");
      assert.equal(api.timer.running?.key, id);
    } finally {
      await vscode.commands.executeCommand("planner.stopTimer");
      api.timer.now = () => Date.now();
    }
  });

  it("follows a task without an id, and finds it by its title once its line is cut", async () => {
    const api = await getApi();
    // Not saved, so it gets no id: the timer knows it by its line.
    const settings = vscode.workspace.getConfiguration("planner");
    await settings.update("autoSave", false, vscode.ConfigurationTarget.Workspace);
    try {
      const editor = await openPlanFile(M2);
      const pos = await positionOf(M2, "## Notes");
      await editor.edit((b) => b.insert(pos, "- [ ] Fix login bug @est:2h\n\n"));
      await waitFor(() => api.state.plan.tasks.some((t) => t.title === "Fix login bug"), "indexed");
      editor.selection = new vscode.Selection(pos, pos);
      assert.equal(await vscode.commands.executeCommand("planner.startTimer"), true);
      assert.equal(api.timer.running?.key, `${M2}#${pos.line + 1}`);
      await typeAbove("Typed while the timer ran.\n");
      assert.equal(api.timer.running?.key, `${M2}#${pos.line + 3}`);
      // Cut and pasted elsewhere: no longer followed, but no other task in the file has its title.
      const started = `- [/] Fix login bug @est:2h @started:${TODAY}`;
      assert.equal(docText(M2).split("\n")[pos.line + 2], started);
      await editor.edit((b) => b.delete(new vscode.Range(pos.line + 2, 0, pos.line + 3, 0)));
      await typeAbove(started);
      assert.equal(await stopAfter50Minutes(), 1);
      assert.ok(docText(M2).includes(`- [/] Fix login bug @est:2h @act:1h @started:${TODAY}\n`));
    } finally {
      await settings.update("autoSave", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  describe("a copied task line keeps the id", () => {
    const ORIGINAL = "  - [ ] Order events schema @est:6h ^T104";
    const COPY = "- [ ] Order events schema @est:6h ^T104";
    const lines = () => docText(M2).split("\n");

    it("times the copy under the cursor, also when lines are typed above it", async () => {
      const pos = await paste(COPY, "T104");
      assert.equal(await vscode.commands.executeCommand("planner.startTimer"), true);
      assert.equal(lines()[pos.line], `- [/] Order events schema @est:6h @started:${TODAY} ^T104`);
      assert.ok(lines().includes(ORIGINAL), "the original is unchanged");
      await typeAbove("Typed while the timer ran.\n");
      assert.equal(await stopAfter50Minutes(), 1);
      assert.equal(
        lines()[pos.line + 2],
        `- [/] Order events schema @est:6h @act:1h @started:${TODAY} ^T104`
      );
      assert.ok(lines().includes(ORIGINAL), "the original is unchanged");
    });

    it("logs the time on the copy, not on the original in another file", async () => {
      const M1 = "milestones/M1-discovery-design.md";
      const original =
        "- [ ] Internal review of the specification @est:4h @owner:sam @dep:T006 #review ^T011";
      const before = docText(M1);
      const pos = await paste(original, "T011");
      assert.equal(await vscode.commands.executeCommand("planner.startTimer"), true);
      await typeAbove("Typed while the timer ran.\n");
      assert.equal(await stopAfter50Minutes(), 1);
      assert.match(lines()[pos.line + 2], /^- \[\/\] Internal review .*@act:1h.* \^T011$/);
      assert.equal(docText(M1), before);
    });

    it("logs the time on a copy that starting the timer gave a new id", async () => {
      // A copy of T104 made into another task: the save that starts the timer renumbers it.
      const pos = await paste("- [ ] Payment events schema @est:6h ^T104", "T104");
      assert.equal(await vscode.commands.executeCommand("planner.startTimer"), true);
      const started = lines()[pos.line];
      const id = started.slice(started.lastIndexOf("^") + 1);
      assert.notEqual(id, "T104");
      const api = await getApi();
      assert.equal(api.timer.running?.key, id);
      await typeAbove("- [ ] Typed above @est:1h\n");
      assert.equal(await stopAfter50Minutes(), 1);
      assert.equal(
        line(M2, id),
        `- [/] Payment events schema @est:6h @act:1h @started:${TODAY} ^${id}`
      );
      assert.equal(line(M2, "T104"), ORIGINAL);
    });

    it("follows the timed copy when it gets a new id while the timer runs", async () => {
      const api = await getApi();
      const pos = await paste(COPY, "T104");
      assert.equal(await vscode.commands.executeCommand("planner.startTimer"), true);
      // The duplicate id's quick fix on the copy: then the original is the only T104.
      const diagnostic = await waitFor(
        () =>
          vscode.languages
            .getDiagnostics(planUri(M2))
            .find((d) => d.code === "duplicate-id" && d.range.start.line === pos.line),
        "duplicate-id"
      );
      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        "vscode.executeCodeActionProvider",
        planUri(M2),
        diagnostic.range
      );
      const fix = actions.find((a) => a.title.startsWith("Give this task a new id"))!;
      assert.ok(await vscode.workspace.applyEdit(fix.edit!));
      const id = /\^(T\d+)$/.exec(lines()[pos.line])![1];
      assert.notEqual(id, "T104");
      assert.equal(api.timer.running?.key, id);
      await typeAbove("Typed while the timer ran.\n");
      assert.equal(await stopAfter50Minutes(), 1);
      assert.equal(
        line(M2, id),
        `- [/] Order events schema @est:6h @act:1h @started:${TODAY} ^${id}`
      );
      assert.equal(line(M2, "T104"), ORIGINAL);
    });

    it("logs nothing when the timed copy cannot be told from the original", async () => {
      const pos = await paste(COPY, "T104");
      assert.equal(await vscode.commands.executeCommand("planner.startTimer"), true);
      // Cut and pasted elsewhere: the line is no longer followed, and both have its id and title.
      const started = lines()[pos.line];
      const editor = await openPlanFile(M2);
      await editor.edit((b) => b.delete(new vscode.Range(pos, pos.translate(1))));
      await typeAbove(started);
      const shown = await warnings(async () => assert.equal(await stopAfter50Minutes(), undefined));
      assert.deepEqual(shown, ["Planner: more than one task has the id T104; 1h not logged."]);
      assert.ok(!docText(M2).includes("@act:1h"), "nothing logged");
      assert.ok(lines().includes(started) && lines().includes(ORIGINAL));
    });
  });

  describe("a timed task line copied with Copy Line Down or Up", () => {
    const TITLE = "Shared API library (auth, validation, logging)";
    const lines = () => docText(M2).split("\n");
    const lineOf = (id: string) => lines().findIndex((l) => l.endsWith(`^${id}`));

    for (const down of [true, false])
      for (const save of [false, true])
        it(`logs on the task, not on the copy edited after Copy Line ${down ? "Down" : "Up"}${save ? " and saved" : ""}`, async () => {
          const api = await getApi();
          assert.equal(await vscode.commands.executeCommand("planner.startTimer", "T121"), true);
          // The line under the cursor is made into another task.
          const cursor = await copyLine(lineOf("T121"), down);
          const editor = await openPlanFile(M2);
          const from = editor.document.lineAt(cursor).text.indexOf(TITLE);
          await editor.edit((b) =>
            b.replace(
              new vscode.Range(cursor, from, cursor, from + TITLE.length),
              "Payment API client"
            )
          );
          if (save) await editor.document.save();
          assert.equal(api.timer.running?.key, "T121");
          assert.equal(api.timer.running?.title, TITLE);
          assert.equal(await stopAfter50Minutes(), 1);
          assert.match(
            lines().find((l) => l.includes(TITLE))!,
            /@act:1h .*\^T121$/
          );
          assert.doesNotMatch(
            lines().find((l) => l.includes("Payment API client"))!,
            /@act/
          );
        });

    it("logs nothing while the copy and the task cannot be told apart", async () => {
      assert.equal(await vscode.commands.executeCommand("planner.startTimer", "T121"), true);
      await copyLine(lineOf("T121"), true);
      const shown = await warnings(async () => assert.equal(await stopAfter50Minutes(), undefined));
      assert.deepEqual(shown, ["Planner: more than one task has the id T121; 1h not logged."]);
      assert.ok(!docText(M2).includes("@act:1h"), "nothing logged");
    });

    it("says which title when it cannot tell a task without an id from its copy", async () => {
      const api = await getApi();
      // Not saved, so it gets no id.
      const settings = vscode.workspace.getConfiguration("planner");
      await settings.update("autoSave", false, vscode.ConfigurationTarget.Workspace);
      try {
        const editor = await openPlanFile(M2);
        const pos = await positionOf(M2, "## Notes");
        await editor.edit((b) => b.insert(pos, "- [ ] Fix login bug @est:2h\n\n"));
        await waitFor(
          () => api.state.plan.tasks.some((t) => t.title === "Fix login bug"),
          "indexed"
        );
        editor.selection = new vscode.Selection(pos, pos);
        assert.equal(await vscode.commands.executeCommand("planner.startTimer"), true);
        await copyLine(pos.line, false);
        const shown = await warnings(async () =>
          assert.equal(await stopAfter50Minutes(), undefined)
        );
        assert.deepEqual(shown, [
          'Planner: more than one task is called "Fix login bug"; 1h not logged.',
        ]);
      } finally {
        await settings.update("autoSave", undefined, vscode.ConfigurationTarget.Workspace);
      }
    });
  });

  it("logs time manually", async () => {
    const api = await getApi();
    await vscode.commands.executeCommand("planner.logTime", "T102", "1h30m");
    assert.match(line(M2, "T102"), /^- \[\/\] Order state machine @est:12h @act:1.5h @owner:sam/);
    await waitFor(() => api.state.plan.taskById("T102")?.act === 1.5, "index");
    await vscode.commands.executeCommand("planner.logTime", "T102", 2);
    assert.match(line(M2, "T102"), /@act:3.5h/);
  });

  it("follows the timed line through edits above it, at its start and within it", () => {
    const change = (sl: number, sc: number, el: number, ec: number, text: string) => ({
      range: new vscode.Range(sl, sc, el, ec),
      rangeOffset: 0,
      rangeLength: 0,
      text,
    });
    const at = (...changes: vscode.TextDocumentContentChangeEvent[]) => lineAfter(10, changes);
    // Lines added or removed above it.
    assert.equal(at(change(2, 0, 2, 0, "a\nb\n")), 12);
    assert.equal(at(change(2, 0, 4, 0, "")), 8);
    assert.equal(at(change(2, 5, 3, 1, "x")), 9);
    assert.equal(at(change(9, 0, 10, 0, "")), 9);
    assert.equal(at(change(10, 0, 10, 0, "Typed above\n")), 11);
    // Each change applies to the text the ones before it left.
    assert.equal(at(change(2, 0, 2, 0, "a\n"), change(1, 0, 2, 0, "")), 10);
    // Indented, edited, joined with the line below, or lines added below it: it stays.
    assert.equal(at(change(10, 0, 10, 0, "  ")), 10);
    assert.equal(at(change(10, 0, 10, 5, "- [/]")), 10);
    assert.equal(at(change(10, 8, 11, 0, "")), 10);
    assert.equal(at(change(11, 0, 11, 0, "a\n")), 10);
    // Deleted, replaced, or joined with the line above: no longer followed.
    assert.equal(at(change(10, 0, 11, 0, "")), undefined);
    assert.equal(at(change(9, 0, 12, 0, "x\n")), undefined);
    assert.equal(at(change(9, 4, 10, 0, "")), undefined);
    assert.equal(at(change(10, 0, 10, 3, "a\nb")), undefined);
  });

  it("tells a copy of the timed line from other edits", () => {
    const LINE = "- [/] Task @est:1h ^T1";
    const change = (text: string) => ({
      range: new vscode.Range(10, 0, 10, 0),
      rangeOffset: 0,
      rangeLength: 0,
      text,
    });
    const copies = (...texts: string[]) => copiesLine(LINE, 10, texts.map(change));
    // Copy Line Down or Up, a paste of it, or of lines with it, on the timed line.
    assert.ok(copies(`${LINE}\n`));
    assert.ok(copies(`\n${LINE}`));
    assert.ok(copies("x", `a\r\n${LINE}\r\nb\r\n`));
    // Typed, or other lines.
    assert.ok(!copies(LINE, "\n", "- [ ] Other @est:1h\n"));
    // A copy pasted elsewhere: the timed line (on line 3 here) stays where it is.
    assert.ok(!copiesLine(LINE, 3, [change(`${LINE}\n`)]));
  });
});
