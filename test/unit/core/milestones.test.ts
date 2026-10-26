import { describe, expect, it } from "vitest";
import {
  describeUnfinished,
  isFloatingMilestone,
  unfinishedMilestoneDeps,
} from "../../../src/core/queries";
import { scheduleDiagnostics } from "../../../src/core/scheduleDiagnostics";
import { schedulePlan } from "../../../src/core/scheduler";
import { validatePlan } from "../../../src/core/validate";
import { buildGanttModel } from "../../../src/core/views/gantt";
import { startsWork } from "../../../src/core/writer";
import { defaultMilestoneDepends } from "../../../src/core/writer/entities";
import { md, planFrom } from "../helpers";

const PROJECT = md("# P", "", "start: 2026-10-01", "end: 2027-06-30");
const TEAM = md("# Team", "", "## Sam", "", "capacity: 40h/week", "", "## Alex");
const TODAY = "2026-10-14";

const M1 = md(
  "# M1",
  "",
  "status: active",
  "",
  "- [x] Kick-off @est:1d @owner:sam @done:2026-10-05 ^T1",
  "- [ ] Design @est:2d @owner:sam ^T2"
);

function plan(m2: string, m3?: string) {
  return planFrom({
    "project.md": PROJECT,
    "team.md": TEAM,
    "milestones/M1.md": M1,
    "milestones/M2.md": m2,
    ...(m3 ? { "milestones/M3.md": m3 } : {}),
  });
}

describe("milestones that wait for others", () => {
  it("lists the unfinished milestones a milestone depends on", () => {
    const p = plan(md("# M2", "", "depends: M1", "", "- [ ] Build @est:1d @owner:sam ^T3"));
    const waiting = unfinishedMilestoneDeps(p, "M2");
    expect(waiting.map((w) => [w.id, w.open.map((t) => t.id)])).toEqual([["M1", ["T2"]]]);
    expect(describeUnfinished(waiting)).toBe("M1 (1 open task: T2)");
    expect(unfinishedMilestoneDeps(p, "M1")).toEqual([]);
  });

  it("knows when a status change starts work", () => {
    const p = plan(md("# M2", "", "- [ ] A ^T3", "- [/] B @started:2026-10-02 ^T4", "- [!] C ^T5"));
    const t = (id: string) => p.taskById(id)!;
    expect(startsWork(t("T3"), "doing")).toBe(true);
    expect(startsWork(t("T3"), "done")).toBe(true);
    expect(startsWork(t("T3"), "blocked")).toBe(false);
    expect(startsWork(t("T4"), "done")).toBe(false);
    expect(startsWork(t("T5"), "doing")).toBe(true);
  });

  it("points out work started (and a milestone made active) before what it waits for is done", () => {
    const issues = validatePlan(
      plan(
        md(
          "# M2",
          "",
          "status: active",
          "depends: M1",
          "",
          "- [/] Build @est:1d @owner:sam @started:2026-10-12 ^T3",
          "- [ ] Test @est:1d @owner:sam ^T4"
        )
      )
    ).filter((i) => i.code.includes("early"));
    expect(issues.map((i) => [i.code, i.file, i.range.start.line])).toEqual([
      ["started-early", "milestones/M2.md", 5],
      ["milestone-started-early", "milestones/M2.md", 2],
    ]);
    expect(issues[0].message).toBe(
      "Started while M1 (1 open task: T2) is not finished. M2 depends on it, so the rest of this work is scheduled after it."
    );
  });

  it("points out a milestone nothing ties to the one before it", () => {
    const floating = plan(
      md("# M2", "", "depends: M1", "", "- [ ] Build @est:2d @owner:sam ^T3"),
      md("# M3", "", "- [ ] Docs @est:1d @owner:alex ^T4")
    );
    const s = schedulePlan(floating, { today: TODAY });
    const issues = scheduleDiagnostics(floating, s).filter((i) => i.code === "floating-milestone");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ file: "milestones/M3.md", data: { previous: "M2" } });
    expect(issues[0].message).toMatch(
      /^M3 does not depend on an earlier milestone, so its work starts 2026-10-\d\d, before M2 finishes \(2026-10-\d\d\)\. Add depends: M2 if it should wait\.$/
    );
    // A task-level dependency on an earlier milestone ties it in.
    const tied = plan(
      md("# M2", "", "depends: M1", "", "- [ ] Build @est:2d @owner:sam ^T3"),
      md("# M3", "", "- [ ] Docs @est:1d @owner:alex @dep:T3 ^T4")
    );
    expect(
      scheduleDiagnostics(tied, schedulePlan(tied, { today: TODAY })).some(
        (i) => i.code === "floating-milestone"
      )
    ).toBe(false);
  });

  it("does not ask a milestone to wait for one that waits for it", () => {
    /** Whether M2 gets the info (and its quick fix "Add depends: M1"). */
    const floating = (files: Record<string, string>) => {
      const p = planFrom({ "project.md": PROJECT, "team.md": TEAM, ...files });
      const shown = scheduleDiagnostics(p, schedulePlan(p, { today: TODAY })).some(
        (i) => i.code === "floating-milestone" && i.file === "milestones/M2.md"
      );
      // The quick fix asks the same question before it offers depends: M1.
      expect(isFloatingMilestone(p, p.milestoneById("M2")!)).toBe(shown);
      return shown;
    };
    const m2 = md("# M2", "", "- [ ] Platform @est:2d @owner:alex ^T3");
    // M1 waits for M2 (depends:, a task @dep, or through another milestone): depends: M1 would
    // be a cycle.
    expect(
      floating({
        "milestones/M1.md": md(
          "# M1",
          "",
          "depends: M2",
          "",
          "- [ ] Design @est:2d @owner:sam ^T1"
        ),
        "milestones/M2.md": m2,
      })
    ).toBe(false);
    expect(
      floating({
        "milestones/M1.md": md("# M1", "", "- [ ] Design @est:2d @owner:sam @dep:T3 ^T1"),
        "milestones/M2.md": m2,
      })
    ).toBe(false);
    expect(
      floating({
        "milestones/M1.md": md(
          "# M1",
          "",
          "depends: M3",
          "",
          "- [ ] Design @est:2d @owner:sam ^T1"
        ),
        "milestones/M2.md": m2,
        "milestones/M3.md": md("# M3", "", "- [ ] Spike @est:1d @owner:sam @dep:T3 ^T4"),
      })
    ).toBe(false);
    // A later milestone waiting for M2 says nothing about M1: M2 still starts before M1 is done.
    expect(
      floating({
        "milestones/M1.md": md("# M1", "", "- [ ] Design @est:2d @owner:sam ^T1"),
        "milestones/M2.md": m2,
        "milestones/M3.md": md("# M3", "", "depends: M2", "", "- [ ] Spike @est:1d @owner:sam ^T4"),
      })
    ).toBe(true);
  });

  it("leaves a milestone alone when a milestone further back waits for it", () => {
    // M1 needs M3's platform first, and M2 has nothing to do with either: depends: M2 on M3 would
    // make M1 wait for M2 too. Only M2 floats.
    const floating = (m1: string, more: Record<string, string> = {}) => {
      const p = planFrom({
        "project.md": PROJECT,
        "team.md": TEAM,
        "milestones/M1.md": m1,
        "milestones/M2.md": md("# M2", "", "- [ ] Middle @est:10d @owner:sam ^T5"),
        "milestones/M3.md": md("# M3", "", "- [ ] Platform @est:2d @owner:alex ^T3"),
        ...more,
      });
      expect(isFloatingMilestone(p, p.milestoneById("M3")!)).toBe(false);
      return scheduleDiagnostics(p, schedulePlan(p, { today: TODAY }))
        .filter((i) => i.code === "floating-milestone")
        .map((i) => i.file);
    };
    expect(
      floating(md("# M1", "", "depends: M3", "", "- [ ] Design @est:5d @owner:sam ^T1"))
    ).toEqual(["milestones/M2.md"]);
    expect(floating(md("# M1", "", "- [ ] Design @est:5d @owner:sam @dep:T3 ^T1"))).toEqual([
      "milestones/M2.md",
    ]);
    // Also by way of a later milestone.
    expect(
      floating(md("# M1", "", "depends: M4", "", "- [ ] Design @est:5d @owner:sam ^T1"), {
        "milestones/M4.md": md("# M4", "", "- [ ] Rollout @est:1d @owner:alex @dep:T3 ^T4"),
      })
    ).toEqual(["milestones/M2.md"]);
  });

  it("gives a new milestone the last milestone as its dependency", () => {
    const p = plan(md("# M2", "", "status: cancelled", "", "- [ ] X ^T3"));
    expect(defaultMilestoneDepends(p)).toEqual(["M1"]);
    expect(defaultMilestoneDepends(planFrom({ "project.md": PROJECT }))).toEqual([]);
  });
});

describe("Gantt order", () => {
  it("orders rows by scheduled start at every level when asked, files untouched", () => {
    const p = plan(
      md(
        "# M2",
        "",
        "depends: M1",
        "",
        "## Late section",
        "",
        "- [ ] Third @est:1d @owner:sam @dep:T4 ^T3",
        "- [ ] Second @est:1d @owner:sam @dep:T5 ^T4",
        "",
        "## Early section",
        "",
        "- [ ] First @est:1d @owner:sam ^T5"
      )
    );
    const s = schedulePlan(p, { today: TODAY });
    const titles = (order: "file" | "schedule") =>
      buildGanttModel(p, s, { grouping: "milestone", order })
        .rows.filter((r) => r.milestone === "M2" && r.kind !== "milestone")
        .map((r) => r.title);
    expect(titles("file")).toEqual(["Late section", "Third", "Second", "Early section", "First"]);
    expect(titles("schedule")).toEqual([
      "Early section",
      "First",
      "Late section",
      "Second",
      "Third",
    ]);
  });
});
