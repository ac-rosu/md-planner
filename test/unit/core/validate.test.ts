import { describe, expect, it } from "vitest";
import { buildDepGraph } from "../../../src/core/graph";
import { TEST_TYPES } from "../../../src/core/model";
import { validatePlan } from "../../../src/core/validate";
import { loadSample, md, planFrom } from "../helpers";

const TEAM = md("# Team", "", "## Sam", "", "capacity: 40h/week");

function codes(files: Record<string, string>, options = {}) {
  const plan = planFrom({ "team.md": TEAM, ...files });
  return validatePlan(plan, options).map((i) => `${i.severity}:${i.code}:${i.range.start.line}`);
}

describe("diagnostics", () => {
  it("reports unknown owners and dependencies with quick-fix data", () => {
    const plan = planFrom({
      "team.md": TEAM,
      "milestones/M1.md": md(
        "# M1",
        "",
        "- [ ] a @est:1h @owner:bob @dep:T1,T99+2d ^T2",
        "- [ ] b @est:1h ^T1"
      ),
    });
    const issues = validatePlan(plan);
    const owner = issues.find((i) => i.code === "unknown-owner")!;
    expect(owner).toMatchObject({ severity: "warning", data: { owner: "bob" } });
    const dep = issues.find((i) => i.code === "unknown-dep")!;
    expect(dep.data).toEqual({ depId: "T99" });
    const line = plan.file("milestones/M1.md")!.lines.line(2);
    expect(line.slice(dep.range.start.character, dep.range.end.character)).toBe("T99");
  });

  it("detects circular dependencies, including through parents and milestones", () => {
    expect(
      codes({
        "milestones/M1.md": md(
          "# M1",
          "",
          "- [ ] a @est:1h @dep:T2 ^T1",
          "- [ ] b @est:1h @dep:T1 ^T2",
          "- [ ] c @est:1h @dep:T2 ^T3"
        ),
      })
    ).toEqual(["error:circular-dep:2", "error:circular-dep:3"]);
    // A child depending on its own parent is a cycle.
    expect(
      codes({ "milestones/M1.md": md("# M1", "", "- [ ] p ^T1", "  - [ ] c @est:1h @dep:T1 ^T2") })
    ).toContain("error:circular-dep:3");
    // Milestone-level cycle.
    const m = codes({
      "milestones/M1.md": md("# M1", "", "depends: M2", "", "- [ ] a @est:1h ^T1"),
      "milestones/M2.md": md("# M2", "", "depends: M1", "", "- [ ] b @est:1h ^T2"),
    });
    expect(m.filter((c) => c.includes("circular"))).toEqual([
      "error:circular-dep:2",
      "error:circular-dep:2",
    ]);
  });

  it("puts tasks in a cycle (and only those) into the graph's cyclic set", () => {
    const plan = planFrom({
      "milestones/M1.md": md(
        "# M1",
        "",
        "- [ ] a @dep:T2 ^T1",
        "- [ ] b @dep:T1 ^T2",
        "- [ ] c @dep:T2 ^T3"
      ),
    });
    const g = buildDepGraph(plan);
    expect([...g.cyclic].map((t) => t.id).sort()).toEqual(["T1", "T2"]);
  });

  it("reports duplicate ids on every occurrence", () => {
    expect(
      codes({
        "milestones/M1.md": md("# M1", "", "- [ ] a @est:1h ^T1"),
        "milestones/M2.md": md("# M2", "", "- [ ] b @est:1h ^T1"),
      })
    ).toEqual(["error:duplicate-id:2", "error:duplicate-id:2"]);
  });

  it("reports leaf tasks without estimate as info, parents excluded", () => {
    expect(
      codes({
        "milestones/M1.md": md(
          "# M1",
          "",
          "- [ ] parent ^T1",
          "  - [ ] child ^T2",
          "  - [x] done child ^T3",
          "- [-] cancelled ^T4"
        ),
      })
    ).toEqual(["info:missing-estimate:3"]);
  });

  it("reports invalid dates and durations from parsing", () => {
    expect(
      codes({
        "milestones/M1.md": md(
          "# M1",
          "",
          "target: 2026-02-31",
          "",
          "- [ ] a @est:2days @due:2026-13-01 ^T1"
        ),
      })
    ).toEqual([
      "error:invalid-date:2",
      "error:invalid-duration:4",
      "error:invalid-date:4",
      "info:missing-estimate:4",
    ]);
  });

  it("checks milestone, test plan and punch cross references", () => {
    const out = codes({
      "milestones/M1.md": md("# M1", "", "depends: M9", "", "- [ ] a @est:1h @test:NOPE ^T1"),
      "tests/T.md": md(
        "# T",
        "",
        "id: T1",
        "milestone: M7",
        "type: XYZ",
        "",
        "## TC-01 Case",
        "",
        "- [x] step @result:fail @punch:P404"
      ),
      "punchlist.md": md(
        "# Punch",
        "",
        "- [ ] p @sev:A @from:T1/TC-09 ^P001",
        "- [ ] q @sev:D @from:NOPE ^P002"
      ),
    });
    expect(out).toEqual([
      "error:invalid-value:3",
      "warning:unknown-test:4",
      "error:unknown-milestone:2",
      "warning:unknown-milestone:3",
      "warning:invalid-value:4",
      "warning:unknown-punch:8",
      "warning:unknown-test:2",
      "warning:unknown-test:3",
    ]);
  });

  it("accepts every test plan type, acceptance included", () => {
    for (const type of TEST_TYPES)
      expect(codes({ "tests/T.md": md("# T", "", "id: T1", `type: ${type}`) })).toEqual([]);
  });

  it("can report missing ids as hints", () => {
    expect(
      codes({ "milestones/M1.md": md("# M1", "", "- [ ] a @est:1h") }, { missingIds: true })
    ).toEqual(["hint:missing-id:2"]);
  });

  it("the sample project only has expected informational diagnostics", () => {
    const plan = loadSample().plan;
    const issues = validatePlan(plan).filter(
      (i) => i.severity === "error" || i.severity === "warning"
    );
    expect(issues).toEqual([]);
  });
});
