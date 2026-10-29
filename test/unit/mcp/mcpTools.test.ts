import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TODAY } from "../helpers";
import { type McpSession, startServer } from "./server";

let s: McpSession;
const call = (name: string, args: Record<string, unknown> = {}) => s.call(name, args);
const line = (rel: string, id: string) =>
  s
    .file(rel)
    .split("\n")
    .find((l) => l.endsWith(`^${id}`));
const M2 = "milestones/M2-backend.md";

beforeAll(async () => {
  s = await startServer();
}, 60_000);

afterAll(async () => {
  await s?.close();
});

describe("MCP tools on the sample plan", () => {
  it("gives an overview and reads plan files", async () => {
    const o = (await call("get_plan_overview")).json;
    expect(o.exists).toBe(true);
    expect(o.project).toMatchObject({ name: "Customer Portal 2.0", hoursPerDay: 8 });
    expect(o.people.map((p: { id: string }) => p.id)).toEqual([
      "alex",
      "sam",
      "priya",
      "jordan",
      "maria",
    ]);
    expect(o.milestones.find((m: { id: string }) => m.id === "M5")).toMatchObject({
      late: true,
      variance: 3,
    });
    expect(o.nextIds).toEqual({ task: "T408", punch: "P008", milestone: "M6" });
    expect((await call("read_plan_file")).json.files).toContain("team.md");
    expect((await call("read_plan_file", { path: "inbox.md" })).json.text).toContain("# Inbox");
    expect((await call("read_plan_file", { path: "../secret.txt" })).isError).toBe(true);
    // A sibling folder whose name starts with the plan folder's name is outside it too.
    mkdirSync(join(s.workspace, "plan-private"));
    writeFileSync(join(s.workspace, "plan-private", "secrets.md"), "secret");
    for (const path of [
      "../plan-private/secrets.md",
      join(s.workspace, "plan-private/secrets.md"),
      "milestones",
    ])
      expect((await call("read_plan_file", { path })).text).toBe(`No plan file "${path}".`);
    expect((await call("get_plan_format")).json).toContain("build_plan");
  });

  it("changes project settings", async () => {
    const r = (
      await call("update_project", { addHolidays: ["2027-05-05"], removeHolidays: ["2027-04-27"] })
    ).json;
    expect(r.changed[0].after).toEqual([
      "holidays: 2026-12-25, 2026-12-26, 2027-01-01, 2027-05-05",
    ]);
    expect((await call("update_project", { workweek: "someday" })).text).toContain(
      "Invalid work week"
    );
    expect((await call("update_project", { budget: "a lot" })).text).toContain("Invalid budget");
    expect((await call("update_project", { budget: "1,200h" })).text).toContain(
      'Budget "1,200h" can mean 1200h or 1.2h: write the one you mean.'
    );
    expect((await call("update_project", { budget: "1,234h" })).text).toContain(
      'Budget "1,234h" can mean 1234h or 1.234h: write 1234h, or the hours with one or two decimals.'
    );
    const b = (await call("update_project", { budget: "900h" })).json;
    expect(b.changed[0].after).toEqual(["budget: 900h # hours agreed with the customer"]);
    const hours = (await call("get_plan_overview")).json.project.hours;
    expect(hours).toMatchObject({ budget: 900, planned: 820, logged: 82, forecast: 826 });
    expect(hours.overBudget).toBe(0);
    expect(hours.whyOverBudget).toEqual([]);
  });

  it("adds, changes and removes people", async () => {
    const add = (
      await call("add_people", {
        people: [
          {
            name: "Chris Baker",
            role: "Data engineer",
            capacity: "24h/week",
            skills: ["integration"],
          },
        ],
      })
    ).json;
    expect(add.added).toEqual(["chris-baker"]);
    const upd = (
      await call("update_person", {
        id: "Chris Baker",
        addTimeOff: ["2026-12-01..2026-12-04"],
        addOvertime: ["2026-11-02..2026-11-06 +4h/week"],
        addWorkdays: ["2026-11-07 4h"],
      })
    ).json;
    expect(upd.id).toBe("chris-baker");
    expect(s.file("team.md")).toContain(
      "## Chris Baker\n\nid: chris-baker\nrole: Data engineer\ncapacity: 24h/week\nskills: integration\noff: 2026-12-01..2026-12-04\novertime: 2026-11-02..2026-11-06 +4h/week\nworkday: 2026-11-07 4h\n"
    );
    expect(
      (await call("update_person", { id: "chris-baker", addOvertime: ["next week"] })).text
    ).toContain("invalid overtime");
    const people = (await call("list_people")).json;
    expect(people.find((p: { id: string }) => p.id === "chris-baker")).toMatchObject({
      overtime: ["2026-11-02..2026-11-06 +4h/week"],
      workdays: ["2026-11-07 4h"],
    });
    // Give Chris a task, then remove them: the task goes to Jordan.
    await call("update_task", { id: "T402", owner: "Chris" });
    expect(line("milestones/M5-launch.md", "T402")).toContain("@owner:chris-baker");
    const rm = (await call("remove_person", { id: "chris-baker", reassignTo: "jordan" })).json;
    expect(rm).toMatchObject({ removed: "chris-baker", reassigned: ["T402"], to: "jordan" });
    expect(s.file("team.md")).not.toContain("Chris");
    expect(line("milestones/M5-launch.md", "T402")).toContain("@owner:jordan");
  });

  it("creates, changes and deletes milestones and sections", async () => {
    const c = (
      await call("create_milestones", {
        milestones: [
          {
            name: "Documentation",
            target: "2027-04-30",
            depends: ["M5"],
            description: "As-built drawings and manuals.",
            sections: ["As-built", "Manuals"],
          },
        ],
      })
    ).json;
    expect(c.created).toEqual(["M6"]);
    expect(s.file("milestones/M6-documentation.md")).toBe(
      "# M6 – Documentation\n\nid: M6\ntarget: 2027-04-30\nstatus: planned\ndepends: M5\n\nAs-built drawings and manuals.\n\n## As-built\n\n## Manuals\n"
    );
    await call("update_milestone", {
      id: "Documentation",
      status: "active",
      target: "2027-05-07",
      depends: [],
    });
    expect(s.file("milestones/M6-documentation.md")).toContain(
      "target: 2027-05-07\nstatus: active"
    );
    expect(
      (await call("add_sections", { milestone: "M6", sections: ["Manuals", "Training"] })).json
        .added
    ).toEqual(["Training"]);
    const t = (
      await call("create_tasks", {
        milestone: "M6",
        section: "Manuals",
        tasks: [{ title: "Operator manual", estimate: "3d" }],
      })
    ).json;
    const id = t.created[0].id;
    // Making M6 wait for M5 moves its task after the launch: the result says what moves.
    const waits = (await call("update_milestone", { id: "M6", depends: ["M5"] })).json;
    expect(waits.schedule).toMatch(/^M6 now ends .* \(was .*\)\. Moves T\d+ \(\+\d+ d\)\.$/);
    expect(waits.schedule).toContain(id);
    const back = (await call("update_milestone", { id: "M6", depends: [] })).json;
    expect(back.schedule).toContain("M6 now ends");
    expect((await call("update_milestone", { id: "M6", name: "Docs" })).json.schedule).toBe(
      undefined
    );
    // A task elsewhere depends on it (M6 no longer waits for M5, so this is no cycle); deleting M6
    // removes that dependency too.
    await call("update_task", { id: "T407", addDependsOn: [id] });
    expect(line("milestones/M5-launch.md", "T407")).toContain(id);
    expect((await call("delete_milestone", { id: "M6" })).text).toContain("open task");
    const d = (await call("delete_milestone", { id: "M6", force: true })).json;
    expect(d.deleted).toBe("M6");
    expect(existsSync(join(s.planDir, "milestones/M6-documentation.md"))).toBe(false);
    expect(line("milestones/M5-launch.md", "T407")).not.toContain(id);
  });

  it("creates tasks with refs, subtasks, lags, notes and any attribute", async () => {
    const r = (
      await call("create_tasks", {
        milestone: "M2",
        section: "Unit 400 – Packaging",
        tasks: [
          {
            ref: "cm",
            title: "Packaging CMs",
            estimate: "2d",
            owner: "Sam",
            attributes: { eq: "U400" },
            notes: "Same library as checkout.",
          },
          {
            ref: "seq",
            title: "Packaging sequence",
            owner: "sam",
            dependsOn: ["cm+1d", "T121"],
            subtasks: [
              { ref: "seq-a", title: "Infeed", estimate: "1d" },
              { title: "Outfeed", estimate: "1d", dependsOn: ["seq-a"] },
            ],
          },
        ],
      })
    ).json;
    const ids = r.created.map((c: { id: string }) => c.id);
    expect(r.created[0]).toEqual({ ref: "cm", id: ids[0], title: "Packaging CMs" });
    const text = s.file(M2);
    expect(text).toContain(
      `## Unit 400 – Packaging\n\n- [ ] Packaging CMs @est:2d @owner:sam @eq:U400 ^${ids[0]}\n      Same library as checkout.\n- [ ] Packaging sequence @owner:sam @dep:${ids[0]}+1d,T121 ^${ids[1]}\n  - [ ] Infeed @est:1d ^${ids[2]}\n  - [ ] Outfeed @est:1d @dep:${ids[2]} ^${ids[3]}\n`
    );
    const bad = await call("create_tasks", {
      milestone: "M2",
      tasks: [{ title: "x", owner: "nobody", dependsOn: ["ghost"], estimate: "soon" }],
    });
    expect(bad.isError).toBe(true);
    expect(bad.text.split("\n")).toHaveLength(3);
  });

  it("updates dependencies, attributes and notes, and refuses cycles", async () => {
    const r = (
      await call("update_tasks", {
        updates: [
          {
            id: "T122",
            removeDependsOn: ["T121"],
            addDependsOn: ["T120+1d"],
            attributes: { eq: "U000" },
          },
          { id: "T104", notes: ["Use PackTags v3.", "Admin tags first."] },
        ],
      })
    ).json;
    expect(r.updated).toEqual(["T122", "T104"]);
    expect(line(M2, "T122")).toBe(
      "- [ ] Notifications and e-mail service @est:12h @owner:sam @dep:T120+1d @eq:U000 #backend #notifications ^T122"
    );
    expect(s.file(M2)).toContain(
      "Order events schema @est:6h ^T104\n        Use PackTags v3.\n        Admin tags first.\n"
    );
    const before = s.file(M2);
    const cycle = await call("update_task", { id: "T121", dependsOn: ["T110"] });
    expect(cycle.isError).toBe(true);
    expect(cycle.text).toContain("Nothing was written");
    expect(s.file(M2)).toBe(before);
  });

  it("moves, deletes, renames, logs time and assigns ids", async () => {
    expect(
      (await call("move_task", { id: "T115", milestone: "M5", section: "Cleanup" })).isError
    ).toBe(false);
    expect(line(M2, "T115")).toBeUndefined();
    expect(s.file("milestones/M5-launch.md")).toContain(
      "## Cleanup\n\n- [-] Legacy PDF statement export"
    );
    await call("log_time", { id: "T121", time: "1h30m" });
    expect(line(M2, "T121")).toContain("@act:1.5h");
    const rn = (await call("rename_task_id", { id: "T121", newId: "T999" })).json;
    expect(rn).toMatchObject({ from: "T121", to: "T999" });
    expect(line(M2, "T110")).toContain("@dep:T999");
    expect((await call("rename_task_id", { id: "T999", newId: "T110" })).text).toContain("in use");
    const del = (await call("delete_tasks", { ids: ["T999"] })).json;
    expect(del.deleted).toEqual(["T999"]);
    expect(line(M2, "T110")).not.toContain("@dep");
    writeFileSync(join(s.planDir, M2), s.file(M2) + "\n- [ ] Typed by hand @est:2h\n");
    const ids = (await call("assign_ids")).json;
    expect(ids.assigned).toBe(1);
    expect(s.file(M2)).toContain(`- [ ] Typed by hand @est:2h ^${ids.ids[0]}`);
  });

  it("captures, plans and deletes inbox items", async () => {
    await call("capture_inbox", { items: ["Order spare fuses #infrastructure"] });
    const inbox = (await call("list_inbox")).json;
    expect(inbox.at(-1)).toMatchObject({
      item: 4,
      title: "Order spare fuses",
      tags: ["infrastructure"],
    });
    const planned = (await call("plan_inbox_item", { item: 1, milestone: "M1" })).json;
    expect(planned.milestone).toBe("M1");
    expect(s.file("milestones/M1-discovery-design.md")).toContain(
      `Ask the payment provider for the production API keys #customer ^${planned.id}`
    );
    expect((await call("delete_tasks", { ids: ["inbox:1"] })).isError).toBe(false);
    expect(s.file("inbox.md")).not.toContain("design tool");
  });

  it("raises punch items from test steps and runs tests", async () => {
    const tp = (
      await call("create_test_plans", {
        plans: [
          {
            id: "UAT-03",
            title: "FAT – Unit 300 CIP",
            type: "FAT",
            milestone: "M4",
            equipment: "billing",
            cases: [
              {
                title: "Caustic cycle",
                pre: "Tank full",
                steps: ["Start caustic", "Return temperature 80 °C"],
              },
            ],
          },
        ],
      })
    ).json;
    expect(tp.created).toEqual(["UAT-03"]);
    expect(s.file("tests/UAT-03-fat-unit-300-cip.md")).toBe(
      "# FAT – Unit 300 CIP\n\nid: UAT-03\ntype: FAT\nmilestone: M4\neq: billing\n\n## TC-01 Caustic cycle\n\npre: Tank full\n\n- [ ] Start caustic\n- [ ] Return temperature 80 °C\n"
    );
    const added = (
      await call("add_test_cases", {
        test: "UAT-01",
        cases: [{ title: "Reject gate", steps: ["Jam → reject"] }],
      })
    ).json;
    expect(added.added).toEqual(["TC-03"]);
    expect(s.file("tests/UAT-01-checkout.md")).toContain(
      "## TC-03 Reject gate\n\n- [ ] Jam → reject\n\n## Run 2026-10-12"
    );
    await call("record_test_results", {
      results: [
        { test: "UAT-03", case: "TC-01", step: 1, result: "pass" },
        { test: "UAT-03", case: "TC-01", step: 2, result: "fail", note: "72 °C" },
      ],
    });
    const p = (
      await call("add_punch_item", {
        title: "CIP return temperature too low",
        sev: "B",
        owner: "Sam",
        step: { test: "UAT-03", case: "TC-01", step: 2 },
      })
    ).json;
    expect(s.file("tests/UAT-03-fat-unit-300-cip.md")).toContain(
      `@result:fail @note:"72 °C" @punch:${p.created[0]}`
    );
    expect(s.file("punchlist.md")).toContain(
      `CIP return temperature too low @sev:B @owner:sam @from:UAT-03/TC-01 ^${p.created[0]}`
    );
    expect(
      (await call("list_punch_items", { sev: "B" })).json.map((x: { id: string }) => x.id)
    ).toContain(p.created[0]);
    await call("finish_test_run", {
      test: "UAT-03",
      tester: "Maria",
      witness: "Customer key users",
    });
    expect(s.file("tests/UAT-03-fat-unit-300-cip.md")).toContain(
      `## Run ${TODAY}\n\ntester: Maria\nwitness: Customer key users\nresult: 1 pass, 1 fail, 0 n.a., 0 open (2 steps)\nfailed: TC-01\npunch: ${p.created[0]}\n`
    );
    await call("reset_test_results", { test: "UAT-03" });
    expect(s.file("tests/UAT-03-fat-unit-300-cip.md")).toContain(
      `- [ ] Return temperature 80 °C @punch:${p.created[0]}`
    );
  });

  it("saves and compares baselines, and gives the dashboard and Kanban data", async () => {
    const b = (await call("save_baseline", { name: "MCP test" })).json;
    expect(b.id).toBe(`${TODAY}-mcp-test`);
    expect((await call("save_baseline", { name: "MCP test" })).text).toContain("overwrite");
    expect((await call("list_baselines")).json.map((x: { id: string }) => x.id)).toContain(b.id);
    await call("update_task", { id: "T304", estimate: "6d" });
    const cmp = (await call("compare_baseline", { id: b.id })).json;
    expect(cmp.tasks.length).toBeGreaterThan(0);
    const dash = (await call("get_dashboard")).json;
    expect(dash.milestones.length).toBe(5);
    expect(dash.lists.overtime.length).toBeGreaterThan(0);
    const k = (await call("get_kanban", { swimlane: "owner", milestone: "M3" })).json;
    expect(
      k.lanes.find((l: { lane: string }) => l.lane === "Priya").cards.todo.length
    ).toBeGreaterThan(0);
  });

  it("exports reports and calibrates estimates", async () => {
    const out = mkdtempSync(join(tmpdir(), "planner-mcp-out-"));
    const r = (
      await call("export_report", { formats: ["html", "xlsx", "mspdi", "csv"], outDir: out })
    ).json;
    expect(r.files.map((f: { format: string }) => f.format)).toEqual([
      "html",
      "xlsx",
      "mspdi",
      "csv",
    ]);
    expect(readFileSync(r.files[0].path, "utf8")).toContain("<!DOCTYPE html>");
    const cal = (await call("calibrate_estimates", { minSamples: 1 })).json;
    expect(cal.applied).toBe(false);
    expect(Array.isArray(cal.rows)).toBe(true);
  });

  it("lists and promotes TODO comments of the workspace", async () => {
    mkdirSync(join(s.workspace, "src"), { recursive: true });
    writeFileSync(
      join(s.workspace, "src", "FB_Pump.scl"),
      "// TODO: handle dry-run protection\nEND\n"
    );
    const todos = (await call("list_todos", { unlinkedOnly: true })).json;
    expect(todos).toEqual([
      { file: "src/FB_Pump.scl", line: 1, keyword: "TODO", text: "handle dry-run protection" },
    ]);
    const p = (
      await call("promote_todo", {
        file: "src/FB_Pump.scl",
        line: 1,
        milestone: "M2",
        section: "Common",
        owner: "sam",
      })
    ).json;
    expect(readFileSync(join(s.workspace, "src", "FB_Pump.scl"), "utf8")).toBe(
      `// TODO(${p.id}): handle dry-run protection\nEND\n`
    );
    expect(s.file(M2)).toContain(
      `handle dry-run protection @owner:sam @src:src/FB_Pump.scl#L1 ^${p.id}`
    );
  });
});
