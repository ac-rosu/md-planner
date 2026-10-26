import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main, parseArgs, table } from "../../../src/cli/index";
import { scheduleToJson } from "../../../src/core/scheduleJson";
import { schedulePlan } from "../../../src/core/scheduler";
import { loadSample, SAMPLE_PLAN, TODAY } from "../helpers";

async function run(...argv: string[]) {
  let out = "";
  let err = "";
  const code = await main(argv, { out: (t) => (out += t), err: (t) => (err += t) });
  return { code, out, err };
}

describe("cli", () => {
  it("parses flags with values, =values and booleans", () => {
    const a = parseArgs(["schedule", "--plan", "p", "--today=2026-10-14", "--json"]);
    expect(a.command).toBe("schedule");
    expect(a.flags.get("plan")).toBe("p");
    expect(a.flags.get("today")).toBe("2026-10-14");
    expect(a.flags.get("json")).toBe(true);
  });

  it("validates the sample: no errors, the late M5 and over-budget warnings; --strict fails", async () => {
    const r = await run("validate", "--plan", SAMPLE_PLAN, "--today", TODAY);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/M5-launch\.md:24:\d+: warning late-task/);
    expect(r.out).toMatch(/project\.md:8:\d+: warning over-budget: Forecast 826 h is 26 h over/);
    expect(r.out).toMatch(/11 files, 50 tasks: 0 error\(s\), 2 warning\(s\)/);
    expect((await run("validate", "--plan", SAMPLE_PLAN, "--today", TODAY, "--strict")).code).toBe(
      1
    );
    const json = JSON.parse(
      (await run("validate", "--plan", SAMPLE_PLAN, "--today", TODAY, "--json")).out
    );
    expect(json).toMatchObject({ errors: 0, warnings: 2 });
  });

  it("passes a plan whose dependency on a cancelled subtask is ignored", async () => {
    const planDir = join(mkdtempSync(join(tmpdir(), "planner-cli-")), "plan");
    mkdirSync(join(planDir, "milestones"), { recursive: true });
    writeFileSync(join(planDir, "project.md"), "# P\n\nstart: 2026-10-01\n");
    writeFileSync(
      join(planDir, "milestones/M1.md"),
      "# M1\n\n- [ ] Parent @dep:T2 ^T1\n  - [-] Dropped part ^T2\n  - [ ] Open part @est:1h ^T3\n"
    );
    const r = await run("validate", "--plan", planDir, "--today", TODAY);
    expect(r.out).toMatch(/M1\.md:3:\d+: info cancelled-dep: T2 is cancelled/);
    expect(r.out).toMatch(/ 0 error\(s\)/);
    expect(r.code).toBe(0);
  });

  it("prints the schedule as a table or JSON identical to the core", async () => {
    const r = await run("schedule", "--plan", SAMPLE_PLAN, "--today", TODAY);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/M5 Launch\s+2027-03-26\s+2027-03-31\s+\+3 d \(late\)/);
    expect(r.out).toMatch(/Critical path: T304 → T305/);
    const json = JSON.parse(
      (await run("schedule", "--plan", SAMPLE_PLAN, "--today", TODAY, "--json")).out
    );
    const plan = loadSample().plan;
    expect(json).toEqual(
      JSON.parse(JSON.stringify(scheduleToJson(plan, schedulePlan(plan, { today: TODAY }))))
    );
  });

  it("reports usage errors with exit code 2", async () => {
    expect((await run("frobnicate", "--plan", SAMPLE_PLAN)).code).toBe(2);
    expect((await run("validate", "--plan", "/no/such/dir")).code).toBe(2);
    expect((await run("validate", "--plan", SAMPLE_PLAN, "--today", "tomorrow")).code).toBe(2);
    expect((await run("help")).out).toMatch(/Usage: planner/);
  });

  it("formats aligned tables", () => {
    expect(
      table(
        ["A", "Bee"],
        [
          ["x", "y"],
          ["long", ""],
        ]
      )
    ).toBe("A     Bee\n----  ---\nx     y\nlong\n");
  });
});
