import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { formatDate } from "../../src/core/dates";
import { type InboxNode } from "../../src/extension/views/inboxTree";
import { type HostToKanban } from "../../src/webview/shared/protocol";
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
const MIN = 60_000;
const HOUR = 60 * MIN;
/** When the timers in these tests start: 17:42 the day before TODAY, local time. */
const START = new Date(2026, 9, 13, 17, 42).getTime();

function line(rel: string, id: string): string {
  return docText(rel)
    .split("\n")
    .find((l) => l.endsWith(`^${id}`))!;
}

/** The part of team.md from a person's heading to the next one. */
function section(name: string): string {
  const team = docText("team.md");
  const from = team.indexOf(`## ${name}\n`);
  const to = team.indexOf("\n## ", from + 1);
  return team.slice(from, to < 0 ? undefined : to + 1);
}

const run = <T>(command: string, ...args: unknown[]) =>
  vscode.commands.executeCommand<T>(command, ...args);

type Kind =
  | "showQuickPick"
  | "showInputBox"
  | "showWarningMessage"
  | "showInformationMessage"
  | "showErrorMessage";
const KINDS: Kind[] = [
  "showQuickPick",
  "showInputBox",
  "showWarningMessage",
  "showInformationMessage",
  "showErrorMessage",
];
type Shown = Record<Kind, unknown[][]>;
type Item = vscode.QuickPickItem & { action?: string; description?: string };
type Answer = (args: unknown[]) => unknown;

/**
 * Runs `f` with the questions it asks answered in order, per kind, by `answers` (each gets the
 * arguments it was asked with); a quick pick or input box without an answer fails the test.
 * Messages without an answer are dismissed. Returns everything shown, by kind.
 */
async function answering(
  answers: Partial<Record<Kind, Answer[]>>,
  f: (shown: Shown) => Promise<unknown>
): Promise<Shown> {
  const window = vscode.window as unknown as Record<Kind, (...args: unknown[]) => unknown>;
  const originals = KINDS.map((k) => window[k]);
  const shown = Object.fromEntries(KINDS.map((k) => [k, []])) as unknown as Shown;
  for (const k of KINDS)
    window[k] = (...args: unknown[]) => {
      shown[k].push(args);
      const answer = answers[k]?.shift();
      if (answer) return Promise.resolve(answer(args));
      if (k === "showQuickPick" || k === "showInputBox")
        return Promise.reject(new Error(`unexpected ${k}: ${JSON.stringify(args.at(-1))}`));
      return Promise.resolve(undefined);
    };
  try {
    await f(shown);
  } finally {
    KINDS.forEach((k, i) => (window[k] = originals[i]));
  }
  return shown;
}

/** Answers a quick pick with the first item that matches. */
const pick =
  (match: (i: Item) => boolean): Answer =>
  ([items]) => {
    const found = (items as Item[]).find(match);
    assert.ok(found, `no item to pick among ${(items as Item[]).map((i) => i.label).join(", ")}`);
    return found;
  };
const labelled = (label: string) => pick((i) => i.label === label);
const field = (label: string) => pick((i) => i.label.endsWith(` ${label}`));
const action = (id: string) => pick((i) => i.action === id);
const typed =
  (text: string): Answer =>
  () =>
    text;
const button =
  (text: string | undefined): Answer =>
  () =>
    text;

describe("Careless use", () => {
  before(async () => {
    await getApi();
    await restorePlan();
  });
  afterEach(async () => {
    const api = await getApi();
    const running = api.timer.running;
    if (running) {
      // Within the minute: stops without a question.
      api.timer.now = () => running.startedAt + 30_000;
      await run("planner.stopTimer");
    }
    api.timer.now = () => Date.now();
    await restorePlan();
  });

  describe("a timer", () => {
    it("asks before logging a night's time; Cancel keeps it running", async () => {
      const api = await getApi();
      api.timer.now = () => START;
      assert.equal(await run("planner.startTimer", "T121"), true);
      api.timer.now = () => START + 16 * HOUR + 18 * MIN;
      api.timer.render();
      // Hours and minutes, not a time of day; and it stands out.
      assert.equal(api.timer.item.text, "$(clock) T121 16h 18m");
      assert.ok(api.timer.item.backgroundColor);

      const cancelled = await answering({ showWarningMessage: [button(undefined)] }, async () =>
        assert.equal(await run("planner.stopTimer"), undefined)
      );
      const [question] = cancelled.showWarningMessage;
      assert.match(
        String(question[0]),
        /^The timer on T121 has been running for 16h 18m, since .+\.$/
      );
      assert.deepEqual(question.slice(2), ["Log 16.5h", "Other amount…", "Discard"]);
      assert.equal(api.timer.running?.key, "T121");
      assert.doesNotMatch(line(M2, "T121"), /@act/);

      // Starting another timer asks about this one first; cancelled, nothing changes.
      await answering({ showWarningMessage: [button(undefined)] }, async () =>
        assert.equal(await run("planner.startTimer", "T122"), false)
      );
      assert.equal(api.timer.running?.key, "T121");
      assert.match(line(M2, "T122"), /^- \[ \] /);

      await answering({ showWarningMessage: [button("Log 16.5h")] }, async () =>
        assert.equal(await run("planner.stopTimer"), 16.5)
      );
      assert.match(line(M2, "T121"), /@est:3d @act:16.5h @owner:sam/);
      assert.equal(api.timer.running, undefined);
    });

    it("logs another amount, or discards the time and leaves the task as it is", async () => {
      const api = await getApi();
      api.timer.now = () => START;
      assert.equal(await run("planner.startTimer", "T121"), true);
      api.timer.now = () => START + 9 * HOUR;
      await answering(
        {
          showWarningMessage: [button("Other amount…")],
          showInputBox: [
            ([options]) => {
              const validate = (options as vscode.InputBoxOptions).validateInput!;
              assert.ok(validate("a while"));
              assert.equal(validate("1h30m"), undefined);
              return "2h";
            },
          ],
        },
        async () => assert.equal(await run("planner.stopTimer"), 2)
      );
      assert.match(line(M2, "T121"), /@act:2h/);

      api.timer.now = () => START;
      assert.equal(await run("planner.startTimer", "T122"), true);
      api.timer.now = () => START + 30 * HOUR;
      const shown = await answering({ showWarningMessage: [button("Discard")] }, async () =>
        assert.equal(await run("planner.stopTimer"), 0)
      );
      assert.deepEqual(
        shown.showInformationMessage.map((m) => m[0]),
        ["Planner: timer on T122 discarded; nothing logged."]
      );
      assert.equal(api.timer.running, undefined);
      assert.match(line(M2, "T122"), new RegExp(`^- \\[/\\] .* @started:${TODAY} `));
      assert.doesNotMatch(line(M2, "T122"), /@act/);
    });

    it("asks when the clock was set back, and keeps the task in progress", async () => {
      const api = await getApi();
      api.timer.now = () => START;
      assert.equal(await run("planner.startTimer", "T121"), true);
      const started = line(M2, "T121");
      api.timer.now = () => START - 5 * MIN;
      api.timer.render();
      assert.equal(api.timer.item.text, "$(clock) T121 ?");
      const shown = await answering({ showWarningMessage: [button("Discard")] }, async () =>
        assert.equal(await run("planner.stopTimer"), 0)
      );
      const [question] = shown.showWarningMessage;
      assert.match(
        String(question[0]),
        /^The clock is now earlier than when the timer on T121 started/
      );
      assert.deepEqual(question.slice(2), ["Other amount…", "Discard"]);
      assert.equal(line(M2, "T121"), started);
      assert.equal(api.timer.running, undefined);
    });

    it("does not replace an @act typed as minutes; it keeps running until that is fixed", async () => {
      const api = await getApi();
      const editor = await openPlanFile(M2);
      const pos = await positionOf(M2, "## Notes");
      await editor.edit((b) => b.insert(pos, "- [/] Hand-logged @est:4h @act:90m ^T150\n\n"));
      await waitFor(() => api.state.plan.taskById("T150"), "indexed");
      api.timer.now = () => START;
      assert.equal(await run("planner.startTimer", "T150"), true);
      api.timer.now = () => START + 50 * MIN;
      let shown = await answering({}, async () =>
        assert.equal(await run("planner.stopTimer"), undefined)
      );
      assert.deepEqual(
        shown.showWarningMessage.map((m) => m[0]),
        [
          "Planner: T150: @act:90m is not read as hours; write it as @act:1.5h first, then stop the timer again. It keeps running.",
        ]
      );
      assert.equal(api.timer.running?.key, "T150");
      assert.match(line(M2, "T150"), /@act:90m \^T150$/);

      // Log time says so before asking for the hours.
      shown = await answering({}, async () =>
        assert.equal(await run("planner.logTime", "T150"), undefined)
      );
      assert.deepEqual(
        shown.showWarningMessage.map((m) => m[0]),
        ["Planner: T150: @act:90m is not read as hours; write it as @act:1.5h first."]
      );

      const at = await positionOf(M2, "@act:90m");
      await editor.edit((b) => b.replace(new vscode.Range(at, at.translate(0, 8)), "@act:1.5h"));
      await waitFor(() => api.state.plan.taskById("T150")?.act === 1.5, "fixed");
      assert.equal(await run("planner.stopTimer"), 1);
      assert.match(line(M2, "T150"), /@act:2.5h \^T150$/);
    });

    it("says once when its task is finished elsewhere while it runs", async () => {
      const api = await getApi();
      api.timer.now = () => START;
      assert.equal(await run("planner.startTimer", "T121"), true);
      api.timer.now = () => START + 50 * MIN;
      const notices = (shown: Shown) =>
        shown.showInformationMessage.filter((m) => String(m[0]).startsWith("Planner: T121 is"));
      const shown = await answering({}, async (shown) => {
        assert.equal(await run("planner.setStatus", "T121", "done"), true);
        await waitFor(() => notices(shown).length > 0, "notice");
        // Once: later changes say nothing more.
        const changed = new Promise<void>((resolve) => {
          const sub = api.service.onDidChange(() => {
            sub.dispose();
            resolve();
          });
        });
        const editor = await openPlanFile(M2);
        const at = await positionOf(M2, "## Common");
        await editor.edit((b) => b.insert(at, "Typed.\n\n"));
        await changed;
      });
      assert.deepEqual(notices(shown), [
        [
          "Planner: T121 is done, but its timer is still running (50m).",
          "Stop timer",
          "Keep running",
        ],
      ]);
      assert.equal(api.timer.running?.key, "T121");
    });
  });

  it("reorders a subtask within the owner lane it has from its parent, without writing @owner", async () => {
    const api = await getApi();
    const editor = await openPlanFile(M2);
    const pos = await positionOf(M2, "## Notes");
    await editor.edit((b) =>
      b.insert(
        pos,
        "- [ ] Release checklist @owner:sam ^T150\n  - [ ] Notes @est:1h ^T151\n  - [ ] Slides @est:1h @prio:high ^T152\n\n"
      )
    );
    await waitFor(() => api.state.plan.taskById("T152"), "indexed");
    await run("planner.openKanban");
    const panel = await waitFor(() => api.kanban(), "kanban panel");
    const lanes = { board: "tasks", swimlane: "owner", showCancelled: false } as const;
    await panel.receive({ type: "options", options: { ...lanes, cardMode: "leaves" } });
    await panel.receive({ type: "filter", filter: {} });
    const notices: string[] = [];
    const post = panel.post.bind(panel);
    panel.post = (m: HostToKanban) => {
      if (m.type === "notice") notices.push(m.message);
      post(m);
    };
    try {
      // Dropped below Slides (high) in Sam's lane, where it is: only the priority changes.
      await panel.receive({
        type: "move",
        key: "T151",
        status: "todo",
        lane: "sam",
        above: "T152",
      });
      assert.equal(line(M2, "T151"), "  - [ ] Notes @est:1h @prio:high ^T151");
      // Into Unassigned: it has its owner from its parent, so nothing is written there.
      await waitFor(() => api.state.plan.taskById("T151")?.prio === "high", "index");
      const before = docText(M2);
      await panel.receive({ type: "move", key: "T152", status: "todo", lane: "unassigned" });
      assert.equal(docText(M2), before);
      assert.equal(
        notices.at(-1),
        "T152 has the owner of T150; change the owner there to leave it unassigned."
      );
      // Into another person's lane: it gets an owner of its own.
      await panel.receive({ type: "move", key: "T152", status: "todo", lane: "priya" });
      assert.match(line(M2, "T152"), /@owner:priya/);
    } finally {
      panel.post = post;
      await panel.receive({
        type: "options",
        options: { ...lanes, swimlane: "none", cardMode: "tasks" },
      });
    }
  });

  it("moves today forward while VS Code stays open", async () => {
    const api = await getApi();
    const service = api.service as unknown as { today?: () => string };
    // In step with the date the tests pin (a refresh after pinning it may still be due).
    api.state.checkToday();
    let updates = 0;
    const sub = api.state.onDidUpdate(() => updates++);
    try {
      assert.equal(api.state.checkToday(), false);
      // Midnight passed: no plan change, only the date.
      service.today = () => "2026-12-01";
      assert.equal(api.state.checkToday(), true);
      assert.equal(updates, 1);
      assert.equal(formatDate(api.state.schedule.today), "2026-12-01");
      assert.equal(api.state.checkToday(), false);
    } finally {
      delete service.today;
      api.state.checkToday();
      sub.dispose();
    }
    assert.equal(formatDate(api.state.schedule.today), TODAY);
  });

  it("plans the inbox item chosen, also when inbox.md changed while the milestone was chosen", async () => {
    const api = await getApi();
    const first = (api.inbox.getChildren() as InboxNode[])[0].task;
    assert.match(first.title, /production API keys/);
    let id: string | undefined;
    await answering(
      {
        showQuickPick: [
          async ([items]) => {
            // A line typed above it meanwhile.
            const edit = new vscode.WorkspaceEdit();
            edit.insert(
              planUri("inbox.md"),
              await positionOf("inbox.md", "- [ ] Ask the payment"),
              "- [ ] Typed while choosing #misc\n"
            );
            assert.ok(await vscode.workspace.applyEdit(edit));
            await waitFor(
              () => api.state.plan.inbox.some((t) => t.title === "Typed while choosing"),
              "typed line indexed"
            );
            return (items as Array<Item & { id: string }>).find((i) => i.id === "M2");
          },
          labelled("Common"),
        ],
      },
      async () => {
        id = await run<string>("planner.planIntoMilestone", { file: first.file, line: first.line });
      }
    );
    assert.equal(id, "T408");
    assert.match(docText("inbox.md"), /- \[ \] Typed while choosing #misc\n/);
    assert.doesNotMatch(docText("inbox.md"), /production API keys/);
    assert.match(
      docText(M2),
      /- \[ \] Ask the payment provider for the production API keys #customer \^T408\n/
    );
  });

  describe("team.md", () => {
    it("adds time off to the person, also when a person was added above meanwhile", async () => {
      const api = await getApi();
      await answering(
        {
          showQuickPick: [
            async (args) => {
              const edit = new vscode.WorkspaceEdit();
              edit.insert(
                planUri("team.md"),
                await positionOf("team.md", "## Sam"),
                "## Robin\n\nrole: Tester\n\n"
              );
              assert.ok(await vscode.workspace.applyEdit(edit));
              await waitFor(() => api.state.plan.personById("robin"), "Robin indexed");
              return labelled("$(edit) Other date…")(args);
            },
            pick((i) => i.description === "only this day"),
          ],
          showInputBox: [typed("2026-12-01")],
        },
        async () => assert.equal(await run("planner.addTimeOff", "sam"), true)
      );
      assert.match(section("Sam"), /\noff: 2026-12-01\n/);
      assert.equal(section("Robin"), "## Robin\n\nrole: Tester\n\n");
    });

    it("writes Full time in a capacity change as the person's full-time hours", async () => {
      await answering(
        {
          showQuickPick: [
            field("Capacity changes"),
            action("add"),
            labelled("$(edit) Other date…"),
            ([items]) => {
              const [full, ...rest] = items as Item[];
              // Maria works four days: full time is 4 × 8 hours.
              assert.equal(full.label, "Full time");
              assert.equal(full.description, "32h/week: hours per day × working days");
              assert.ok(!rest.some((i) => i.description?.includes("current")));
              return full;
            },
            action("done"),
            action("save"),
          ],
          showInputBox: [typed("2027-01-01")],
        },
        async () => assert.equal(await run("planner.editPerson", { id: "maria" }), true)
      );
      assert.match(section("Maria"), /\ncapacityFrom: 2027-01-01 32h\/week\n/);
    });

    it("keeps the Add person form when the name or the id is taken", async () => {
      const api = await getApi();
      await answering(
        {
          showInputBox: [
            typed("Robin Lee"),
            ([options]) => {
              // Renamed in the form to a person on the team: refused there.
              const validate = (options as vscode.InputBoxOptions).validateInput!;
              assert.match(String(validate("Sam")), /^A person with the id sam already exists/);
              assert.equal(validate("Robin Leigh"), undefined);
              return "Robin Lee";
            },
            typed("Tester"),
            typed("robin-lee-2"),
          ],
          showQuickPick: [
            field("Name"),
            pick((i) => i.label.endsWith(" Role")),
            async (args) => {
              // Someone adds a Robin Lee meanwhile.
              const edit = new vscode.WorkspaceEdit();
              const team = await vscode.workspace.openTextDocument(planUri("team.md"));
              edit.insert(
                planUri("team.md"),
                team.positionAt(team.getText().length),
                "\n## Robin Lee\n"
              );
              assert.ok(await vscode.workspace.applyEdit(edit));
              await waitFor(() => api.state.plan.personById("robin-lee"), "Robin Lee indexed");
              return action("create")(args);
            },
            ([items, options]) => {
              assert.match(
                String((options as vscode.QuickPickOptions).placeHolder),
                /^The person id "robin-lee" is already in use\. Change the name or the id/
              );
              // Everything typed is still there.
              assert.ok((items as Item[]).some((i) => i.description === "Tester"));
              return field("Id")([items]);
            },
            action("create"),
          ],
        },
        async () => assert.equal(await run("planner.addPerson"), "robin-lee-2")
      );
      assert.match(docText("team.md"), /\n## Robin Lee\n\nid: robin-lee-2\nrole: Tester\n/);
    });
  });
});
