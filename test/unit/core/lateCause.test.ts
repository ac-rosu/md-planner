import { describe, expect, it } from "vitest";
import { impliedDeps } from "../../../src/core/consistency";
import { describeLateCause, lateCause } from "../../../src/core/lateCause";
import { newErrors, planErrors } from "../../../src/core/newErrors";
import { schedulePlan } from "../../../src/core/scheduler";
import { validatePlan } from "../../../src/core/validate";
import { md, planFrom } from "../helpers";

const PROJECT = md("# P", "", "start: 2026-10-01", "end: 2027-06-30");
const TEAM = md(
  "# Team",
  "",
  "## Sam",
  "",
  "capacity: 40h/week",
  "",
  "## Alex",
  "",
  "capacity: 40h/week"
);

function plan(m1: string, m2?: string) {
  return planFrom({
    "project.md": PROJECT,
    "team.md": TEAM,
    "milestones/M1.md": m1,
    ...(m2 ? { "milestones/M2.md": m2 } : {}),
  });
}

describe("why a task is late", () => {
  it("follows the chain through milestone dependencies to a wrong fixed start", () => {
    const p = plan(
      md(
        "# M1",
        "",
        "target: 2026-11-30",
        "",
        "- [ ] Plan @est:1d @owner:sam @start:2027-04-19 ^T1",
        "- [ ] Design @est:2d @owner:sam @dep:T1 ^T2"
      ),
      md("# M2", "", "target: 2026-12-18", "depends: M1", "", "- [ ] Build @est:3d @owner:alex ^T3")
    );
    const s = schedulePlan(p, { today: "2026-10-14" });
    const t3 = p.taskById("T3")!;
    expect(s.tasks.get(t3)!.late).toBe(true);
    const cause = lateCause(s, t3)!;
    expect(cause).toMatchObject({ kind: "start", task: p.taskById("T1"), via: ["M1"] });
    expect(describeLateCause(p, t3, cause)).toBe(
      "Held back by the fixed start 2027-04-19 of T1 (via M1)."
    );
    expect(describeLateCause(p, p.taskById("T1")!, lateCause(s, p.taskById("T1")!)!)).toBe(
      "Held back by its own fixed start 2027-04-19."
    );
  });

  it("names an owner who has other work first", () => {
    const p = plan(
      md(
        "# M1",
        "",
        "target: 2026-10-16",
        "",
        "- [ ] Urgent @est:3d @owner:sam @prio:high ^T1",
        "- [ ] Also needed @est:1d @owner:sam ^T2"
      )
    );
    const s = schedulePlan(p, { today: "2026-10-14" });
    const t2 = p.taskById("T2")!;
    const cause = lateCause(s, t2)!;
    expect(cause).toMatchObject({ kind: "busy", task: t2, resource: "sam", via: [] });
    expect(describeLateCause(p, t2, cause)).toBe("Held back by Sam having other work first.");
    // A task that can start right away has no cause.
    expect(lateCause(s, p.taskById("T1")!)).toBeUndefined();
  });
});

describe("implied dependencies", () => {
  it("lists dependencies another one in the list already covers, as a hint", () => {
    const p = plan(
      md(
        "# M1",
        "",
        "- [ ] Robots ^T1",
        "  - [ ] Welding @est:1h ^T2",
        "- [ ] Setup @est:1h ^T3",
        "- [ ] Commission @est:1h @dep:T3 ^T4",
        "- [ ] Accept @est:1h @dep:T1,T2,T3,T4 ^T5",
        "- [ ] Lagged @est:1h @dep:T4,T3+2d ^T6"
      )
    );
    expect(impliedDeps(p, p.taskById("T5")!)).toEqual([
      { id: "T2", why: "T1 includes it" },
      { id: "T3", why: "T4 waits for it" },
    ]);
    expect(impliedDeps(p, p.taskById("T6")!)).toEqual([]);
    const hint = validatePlan(p).find((i) => i.code === "implied-dep")!;
    expect(hint).toMatchObject({ severity: "hint", data: { key: "dep", implied: "T2,T3" } });
  });

  it("keeps dependencies that a milestone dependency also covers", () => {
    const p = plan(
      md("# M1", "", "- [ ] A @est:1h ^T1"),
      md("# M2", "", "depends: M1", "", "- [ ] B @est:1h @dep:T1 ^T2")
    );
    expect(impliedDeps(p, p.taskById("T2")!)).toEqual([]);
  });
});

describe("new errors", () => {
  it("finds the errors a change adds, not those that were there or moved", () => {
    const before = plan(md("# M1", "", "- [ ] A @est:1h @dep:T9 ^T1", "- [ ] B @est:1h ^T2"));
    const moved = plan(md("# M1", "", "- [ ] B @est:1h ^T2", "- [ ] A @est:1h @dep:T9 ^T1"));
    expect(newErrors(planErrors(before), planErrors(moved))).toEqual([]);
    const cyclic = plan(
      md("# M1", "", "- [ ] A @est:1h @dep:T9 ^T1", "- [ ] B @est:1h @dep:T3 ^T2"),
      md("# M2", "", "depends: M1", "", "- [ ] C @est:1h ^T3")
    );
    expect(newErrors(planErrors(before), planErrors(cyclic))).toEqual([
      "Circular dependency: T2 → T3.",
    ]);
  });
});
