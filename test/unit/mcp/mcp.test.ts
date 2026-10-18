// MCP server integration tests: the bundled server runs as a child process over stdio and is
// driven by the MCP SDK client against a temporary copy of the sample plan.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasServerEntry, mergeMcpJson, serverEntry } from "../../../src/mcp/config";
import { COMMAND_COVERAGE, VIEW_COVERAGE } from "../../../src/mcp/coverage";
import { changedLines } from "../../../src/mcp/tools";
import { parseServerArgs } from "../../../src/mcp/server";
import { ROOT, TODAY } from "../helpers";
import { type McpSession, startServer } from "./server";

let session: McpSession;
let planDir: string;
const call = (name: string, args: Record<string, unknown> = {}) => session.call(name, args);
const file = (rel: string) => readFileSync(join(planDir, rel), "utf8");

beforeAll(async () => {
  session = await startServer();
  planDir = session.planDir;
}, 60_000);

afterAll(async () => {
  await session?.close();
});

describe("MCP server", () => {
  it("covers every command of the extension with tools", async () => {
    const tools = new Set((await session.client.listTools()).tools.map((t) => t.name));
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const commands: string[] = manifest.contributes.commands.map(
      (c: { command: string }) => c.command
    );
    expect(commands.filter((c) => !(c in COMMAND_COVERAGE))).toEqual([]);
    expect(Object.keys(COMMAND_COVERAGE).filter((c) => !commands.includes(c))).toEqual([]);
    const named = [
      ...Object.values(COMMAND_COVERAGE).flatMap((c) => ("tools" in c ? c.tools : [])),
      ...Object.values(VIEW_COVERAGE).flat(),
    ];
    expect([...new Set(named)].filter((t) => !tools.has(t))).toEqual([]);
    expect(tools.size).toBeGreaterThanOrEqual(50);
    const prompts = (await session.client.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toContain("plan_from_text");
  });

  it("list_tasks filters by owner, status, tag and date range", async () => {
    const priya = (await call("list_tasks", { owner: "priya" })).json;
    expect(priya.tasks.map((t: { id: string }) => t.id)).toContain("T106");
    expect(priya.tasks.every((t: { owner: string }) => t.owner === "priya")).toBe(true);
    const blocked = (await call("list_tasks", { status: ["blocked"] })).json;
    expect(blocked.tasks.map((t: { id: string }) => t.id)).toEqual(["T106"]);
    const window = (
      await call("list_tasks", { from: "2026-11-10", to: "2026-11-11", tag: "checkout" })
    ).json;
    expect(window.tasks.map((t: { id: string }) => t.id)).toEqual(["T105"]);
    expect(window.tasks[0]).toMatchObject({
      scheduledStart: "2026-11-10",
      scheduledFinish: "2026-11-11",
      estimate: 16,
      owner: "sam",
    });
    expect((await call("list_tasks", { from: "tomorrow" })).isError).toBe(true);
  });

  it("get_task returns notes, dependencies, dependents and subtasks", async () => {
    const t = (await call("get_task", { id: "T102" })).json;
    expect(t).toMatchObject({
      id: "T102",
      status: "doing",
      owner: "sam",
      milestoneTitle: "M2 – Backend",
    });
    expect(t.subtasks.map((s: { id: string }) => s.id)).toEqual(["T103", "T104"]);
    expect(t.dependencies).toEqual([
      { id: "T101", lagHours: 0, title: "Data model & API contract", status: "done" },
    ]);
    expect(t.dependents.map((d: { id: string }) => d.id)).toEqual(["T107"]);
    expect((await call("get_task", { id: "T104" })).json.notes[0]).toBe(
      "Notes indented under a task are its description."
    );
    expect((await call("get_task", { id: "T999" })).text).toBe('Unknown task id "T999".');
  });

  it("get_schedule, get_team_load and get_estimate_stats come from the shared core", async () => {
    const s = (await call("get_schedule")).json;
    expect(s.milestones.find((m: { id: string }) => m.id === "M5")).toMatchObject({
      late: true,
      forecast: "2027-03-31",
    });
    expect(s.criticalPath[0]).toBe("T304");
    const m2 = (await call("get_schedule", { milestone: "M2" })).json;
    expect(m2.milestones).toHaveLength(1);
    const load = (
      await call("get_team_load", { mode: "demand", from: "2026-10-19", to: "2026-11-01" })
    ).json;
    const sam = load.people.find((p: { id: string }) => p.id === "sam");
    expect(sam.weeks.map((w: { week: string; over: boolean }) => [w.week, w.over])).toEqual([
      ["2026-W43", true],
      ["2026-W44", true],
    ]);
    const planned = (await call("get_team_load", { from: "2026-11-02", to: "2026-11-08" })).json;
    expect(planned.people.find((p: { id: string }) => p.id === "sam").weeks[0]).toMatchObject({
      week: "2026-W45",
      hours: 48,
      capacity: 48,
      overtimeCapacity: 8,
      overtime: 8,
    });
    const stats = (await call("get_estimate_stats")).json;
    expect(stats.overall).toMatchObject({ n: 8, est: 66, act: 72 });
    expect(stats.summary).toContain("#integration tasks: underestimated by 25% (n = 1)");
  });

  it("list_tests and validate_plan", async () => {
    const tests = (await call("list_tests", { id: "UAT-01" })).json;
    expect(tests[0].counts).toMatchObject({ steps: 4, pass: 1, fail: 1, open: 2 });
    expect(tests[0].cases[0].steps[1]).toEqual({
      step: 2,
      text: "Pay with a test card → confirmation within 2 s",
      result: "fail",
      note: "confirmation after 3.5 s",
      punch: "P007",
    });
    const v = (await call("validate_plan")).json;
    expect(v.errors).toBe(0);
    expect(v.issues.some((i: { code: string }) => i.code === "late-task")).toBe(true);
  });

  it("update_task writes a minimal edit and returns the changed line", async () => {
    const before = file("milestones/M2-backend.md");
    const r = (
      await call("update_task", {
        id: "T104",
        status: "doing",
        owner: "priya",
        addTags: ["backend"],
      })
    ).json;
    expect(r.changed).toEqual([
      {
        file: "milestones/M2-backend.md",
        line: 22,
        before: ["  - [ ] Order events schema @est:6h ^T104"],
        after: [
          `  - [/] Order events schema @est:6h @owner:priya @started:${TODAY} #backend ^T104`,
        ],
      },
    ]);
    const after = file("milestones/M2-backend.md");
    expect(after.split("\n").filter((l, i) => l !== before.split("\n")[i])).toHaveLength(1);
    const bad = await call("update_task", { id: "T104", owner: "bob" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('T104: unknown owner "bob"');
    const cleared = (await call("update_task", { id: "T104", owner: "" })).json;
    expect(cleared.changed[0].after[0]).not.toContain("@owner");
  });

  it("create_tasks adds tasks with new ids in a section or under a parent", async () => {
    const r = (
      await call("create_tasks", {
        milestone: "M2",
        section: "Checkout",
        tasks: [
          {
            title: "Refund handling",
            estimate: "6h",
            owner: "sam",
            dependsOn: ["T107"],
            tags: ["checkout"],
          },
          {
            title: "Refund confirmation dialog",
            estimate: "4h",
            owner: "priya",
            dependsOn: ["T408"],
          },
        ],
      })
    ).json;
    expect(r.created.map((c: { id: string }) => c.id)).toEqual(["T408", "T409"]);
    expect(r.changed[0].after).toEqual([
      "- [ ] Refund handling @est:6h @owner:sam @dep:T107 #checkout ^T408",
      "- [ ] Refund confirmation dialog @est:4h @owner:priya @dep:T408 ^T409",
    ]);
    const sub = (
      await call("create_tasks", {
        milestone: "M2",
        parent: "T102",
        tasks: [{ title: "Payment events", estimate: "2h" }],
      })
    ).json;
    expect(sub.changed[0].after).toEqual(["  - [ ] Payment events @est:2h ^T410"]);
    expect((await call("create_tasks", { milestone: "M9", tasks: [{ title: "x" }] })).isError).toBe(
      true
    );
    expect(
      (await call("create_tasks", { milestone: "M2", tasks: [{ title: "x", estimate: "soon" }] }))
        .text
    ).toContain('invalid estimate "soon"');
  });

  it("record_test_result and add_punch_item edit the test plan and punch list", async () => {
    const r = (
      await call("record_test_result", { test: "UAT-01", case: "TC-01", step: 3, result: "pass" })
    ).json;
    expect(r.changed[0].after).toEqual(["- [x] Order appears in the order history @result:pass"]);
    expect(
      (
        await call("record_test_result", {
          test: "UAT-01",
          case: "TC-02",
          step: 5,
          result: "pass",
        })
      ).isError
    ).toBe(true);
    const p = (
      await call("add_punch_item", {
        title: "Stop button LED stays on",
        sev: "C",
        owner: "priya",
        from: "UAT-01/TC-01",
      })
    ).json;
    expect(p.created).toEqual(["P008"]);
    expect(
      file("punchlist.md").endsWith(
        "- [ ] Stop button LED stays on @sev:C @owner:priya @from:UAT-01/TC-01 ^P008\n"
      )
    ).toBe(true);
  });
});

describe("MCP helpers", () => {
  it("reports changed line ranges", () => {
    expect(changedLines("f", "a\nb\nc\n", "a\nB\nc\n")).toEqual({
      file: "f",
      line: 2,
      before: ["b"],
      after: ["B"],
    });
    expect(changedLines("f", "a\nc\n", "a\nb\nc\n")).toEqual({
      file: "f",
      line: 2,
      before: [],
      after: ["b"],
    });
    expect(changedLines("f", "a", "a")).toBeUndefined();
  });

  it("parses server arguments and environment", () => {
    expect(parseServerArgs(["--plan", "/x/plan", "--today", "2026-10-14"], {}).today).toBe(
      "2026-10-14"
    );
    // Paths are made absolute for the platform (on Windows "/y/plan" becomes "<drive>:\y\plan").
    expect(parseServerArgs([], { PLANNER_PLAN_DIR: "/y/plan" }).planDir).toBe(resolve("/y/plan"));
    expect(parseServerArgs(["--plan", "/w/docs/plan", "--workspace", "/w"], {})).toMatchObject({
      planDir: resolve("/w/docs/plan"),
      workspaceDir: resolve("/w"),
    });
    expect(parseServerArgs([], { PLANNER_WORKSPACE: "/v" }).workspaceDir).toBe(resolve("/v"));
    expect(serverEntry("/node", "/s.js", "/w/docs/plan", "/w").args).toEqual([
      "/s.js",
      "--plan",
      "/w/docs/plan",
      "--workspace",
      "/w",
    ]);
    expect(serverEntry("/node", "/s.js", "/w/plan").args).toEqual(["/s.js", "--plan", "/w/plan"]);
  });

  it("merges the server into .mcp.json without touching other servers", () => {
    const entry = {
      command: "/usr/bin/node",
      args: ["/s.js", "--plan", "/p"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
    const merged = JSON.parse(
      mergeMcpJson('{"mcpServers":{"other":{"command":"x"}},"note":1}', entry)
    );
    expect(merged).toEqual({
      mcpServers: { other: { command: "x" }, "md-planner": { type: "stdio", ...entry } },
      note: 1,
    });
    expect(JSON.parse(mergeMcpJson(undefined, entry)).mcpServers["md-planner"].args).toEqual(
      entry.args
    );
    expect(() => mergeMcpJson("{nope", entry)).toThrow(/not valid JSON/);
    expect(hasServerEntry(mergeMcpJson(undefined, entry))).toBe(true);
    for (const text of [undefined, "", "{nope", "null", '{"mcpServers":{"other":{}}}'])
      expect(hasServerEntry(text)).toBe(false);
  });
});
