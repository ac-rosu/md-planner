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
    // A child depending on its own parent is a cycle, reported with its own explanation.
    expect(
      codes({ "milestones/M1.md": md("# M1", "", "- [ ] p ^T1", "  - [ ] c @est:1h @dep:T1 ^T2") })
    ).toEqual(["error:family-dep:3"]);
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

  it("reports a cycle through other dependencies of tasks that also depend on their own subtask", () => {
    const text = md(
      "# M1",
      "",
      "- [ ] A @dep:T2,T3 ^T1",
      "  - [ ] Part of A @est:1h ^T2",
      "- [ ] B @dep:T4,T1 ^T3",
      "  - [ ] Part of B @est:1h ^T4"
    );
    expect(codes({ "milestones/M1.md": text })).toEqual([
      "error:family-dep:2",
      "error:family-dep:4",
      "error:circular-dep:2",
      "error:circular-dep:4",
    ]);
    const cycle = validatePlan(planFrom({ "milestones/M1.md": text })).find(
      (i) => i.code === "circular-dep"
    );
    expect(cycle?.message).toBe("Circular dependency: T2 → T4. These tasks are not scheduled.");
    // A parent waits for its own subtask, which waits for a sibling: only the sibling dependency
    // is a circular one, the parent's is explained on its own.
    expect(
      codes({
        "milestones/M1.md": md(
          "# M1",
          "",
          "- [ ] Parent @dep:T2 ^T1",
          "  - [ ] First @est:1h @dep:T3 ^T2",
          "  - [ ] Second @est:1h ^T3"
        ),
      })
    ).toEqual(["error:family-dep:2", "error:circular-dep:3"]);
  });

  it("reports a parent's dependency only for the cycle it is part of", () => {
    const plan = planFrom({
      "milestones/M1.md": md(
        "# M1",
        "",
        "- [ ] Parent @dep:T4 ^T1",
        "  - [ ] One @est:1h ^T2",
        "  - [ ] Two @est:1h @dep:T5 ^T3",
        "- [ ] Waits for one @est:1h @dep:T2 ^T4",
        "- [ ] Waits for two @est:1h @dep:T3 ^T5"
      ),
    });
    const cycles = validatePlan(plan).filter((i) => i.code === "circular-dep");
    expect(cycles.map((i) => `${i.range.start.line}: ${i.message}`).sort()).toEqual([
      "2: Circular dependency: T2 → T4. These tasks are not scheduled.",
      "4: Circular dependency: T3 → T5. These tasks are not scheduled.",
      "5: Circular dependency: T2 → T4. These tasks are not scheduled.",
      "6: Circular dependency: T3 → T5. These tasks are not scheduled.",
    ]);
  });

  it("does not report a family dependency the graph ignores (cancelled work)", () => {
    const dropped = {
      "milestones/M1.md": md(
        "# M1",
        "",
        "- [ ] Parent @dep:T2 ^T1",
        "  - [-] Dropped part ^T2",
        "  - [ ] Open part @est:1h ^T3"
      ),
    };
    expect(codes(dropped)).toEqual(["info:cancelled-dep:2"]);
    expect(buildDepGraph(planFrom(dropped)).cycles).toEqual([]);
    const ignored = [
      // The declaring task is cancelled, under a cancelled parent, or in a cancelled milestone.
      md("# M1", "", "- [-] Dropped @dep:T1 ^T1"),
      md("# M1", "", "- [-] Dropped parent ^T1", "  - [ ] Child @est:1h @dep:T1 ^T2"),
      md("# M1", "", "status: cancelled", "", "- [ ] A @dep:T2 ^T1", "  - [ ] Part @est:1h ^T2"),
      // The subtask is part of a cancelled subtask.
      md(
        "# M1",
        "",
        "- [ ] A @dep:T3 ^T1",
        "  - [-] Dropped ^T2",
        "    - [ ] Moot @est:1h ^T3",
        "  - [ ] Open @est:1h ^T4"
      ),
    ];
    for (const text of ignored) {
      const plan = planFrom({ "team.md": TEAM, "milestones/M1.md": text });
      expect(validatePlan(plan).filter((i) => i.severity === "error")).toEqual([]);
      expect(buildDepGraph(plan).cycles).toEqual([]);
    }
    // A finished task's dependencies are in the graph too: reported exactly when it has the cycle.
    const done = planFrom({
      "team.md": TEAM,
      "milestones/M1.md": md(
        "# M1",
        "",
        "- [x] Done parent @done:2026-10-01 @dep:T2 ^T1",
        "  - [x] Part @est:1h @done:2026-10-01 ^T2",
        "- [ ] Next @est:1h @dep:T1 ^T3"
      ),
    });
    expect(validatePlan(done).some((i) => i.code === "family-dep")).toBe(
      buildDepGraph(done).cycles.length > 0
    );
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
          "  - [x] done child @done:2026-10-01 ^T3",
          "- [-] cancelled ^T4"
        ),
      })
    ).toEqual(["info:missing-estimate:3"]);
  });

  it("does not ask for estimates of work that is not scheduled because it is cancelled", () => {
    // The open child of the cancelled parent gets its own note (cancelled-parent-open-subtasks).
    expect(
      codes({
        "milestones/M1.md": md("# M1", "", "- [-] Dropped parent ^T1", "  - [ ] Child ^T2"),
        "milestones/M2.md": md("# M2", "", "status: cancelled", "", "- [ ] Task ^T3"),
      }).filter((c) => c.includes("missing-estimate"))
    ).toEqual([]);
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

  it("the sample project only has expected informational diagnostics, and its budget warning", () => {
    const plan = loadSample().plan;
    const issues = validatePlan(plan).filter(
      (i) => i.severity === "error" || i.severity === "warning"
    );
    // The sample is 26 h over its budget on purpose, to show the budget on the dashboard.
    expect(issues.map((i) => `${i.file}:${i.code}`)).toEqual(["project.md:over-budget"]);
  });
});
