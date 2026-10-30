// Plans far larger than usual: diagnostics, causes, the burn-up and the team load grow with the
// size of the plan, not with its square.
import { describe, expect, it } from "vitest";
import { teamLoad } from "../../../src/core/load";
import { describeLateCause, lateCause } from "../../../src/core/lateCause";
import { burnUp, milestoneBurnUps } from "../../../src/core/metrics";
import { scheduleDiagnostics } from "../../../src/core/scheduleDiagnostics";
import { type Schedule, schedulePlan } from "../../../src/core/scheduler";
import { validatePlan } from "../../../src/core/validate";
import { buildDashboardModel } from "../../../src/core/views/dashboard";
import { LARGE_PLAN_TODAY, largePlanFiles } from "../../fixtures/largePlan";
import { md, planFrom, timeLimit } from "../helpers";

const PROJECT = md("# P", "", "start: 2026-10-01", "end: 2027-06-30");
const TEAM = md(
  "# Team",
  "",
  "## Sam",
  "",
  "capacity: 40h/week",
  "",
  "## Jordan",
  "",
  "capacity: 0h/week"
);
const TODAY = "2026-10-14";

/** The best of three wall-clock times in ms: one slow run on a busy machine does not fail. */
function fastest(fn: () => unknown): number {
  let best = Infinity;
  for (let run = 0; run < 3; run++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

describe("a dependency loop through 10,000 tasks", () => {
  const n = 10_000;
  const tasks = Array.from(
    { length: n },
    (_, i) => `- [ ] Task ${i + 1} @est:1h @owner:sam @dep:T${i === 0 ? n : i} ^T${i + 1}`
  );
  const plan = planFrom({
    "project.md": PROJECT,
    "team.md": TEAM,
    "milestones/M1.md": md("# M1", "", ...tasks),
  });

  it("names its first tasks and how many more on each dependency, quickly", () => {
    let issues: ReturnType<typeof validatePlan> = [];
    // Was 1.4 s and 1.6 GB: every message listed all 10,000 ids, and so did its dedupe key.
    expect(fastest(() => (issues = validatePlan(plan)))).toBeLessThan(timeLimit(250));
    const cycles = issues.filter((i) => i.code === "circular-dep");
    expect(cycles).toHaveLength(n);
    expect(cycles[0].message).toMatch(
      /^Circular dependency: (T\d+ → ){6}… and 9994 more\. These tasks are not scheduled\.$/
    );
  });

  it("names a short loop in full", () => {
    const p = planFrom({
      "project.md": PROJECT,
      "team.md": TEAM,
      "milestones/M1.md": md(
        "# M1",
        "",
        ...Array.from(
          { length: 8 },
          (_, i) => `- [ ] T @est:1h @dep:T${i === 0 ? 8 : i} ^T${i + 1}`
        )
      ),
    });
    const message = validatePlan(p).find((i) => i.code === "circular-dep")!.message;
    expect(message.match(/T\d/g)).toHaveLength(8);
    expect(message).not.toContain("more");
  });
});

describe("a long chain of late tasks behind one fixed start", () => {
  it("works out every cause in linear time", () => {
    const n = 8000;
    const steps = Array.from(
      { length: n - 1 },
      (_, i) => `- [ ] Step ${i + 2} @est:1h @owner:sam @dep:T${i + 1} @due:2026-11-01 ^T${i + 2}`
    );
    const plan = planFrom({
      "project.md": md("# P", "", "start: 2026-10-01", "end: 2030-06-30"),
      "team.md": TEAM,
      "milestones/M1.md": md(
        "# M1",
        "",
        "- [ ] Start @est:1h @owner:sam @start:2027-03-01 @due:2026-11-01 ^T1",
        ...steps
      ),
    });
    const causes = (s: Schedule) => {
      for (const ts of s.tasks.values()) if (ts.late) lateCause(s, ts.task);
    };
    // Was 2.8 s: every task walked the chain back to T1. Each run on a new schedule.
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const fresh = schedulePlan(plan, { today: TODAY });
      const t0 = performance.now();
      causes(fresh);
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(timeLimit(100));
    const s = schedulePlan(plan, { today: TODAY });
    const last = plan.taskById(`T${n}`)!;
    const cause = lateCause(s, last)!;
    expect(cause).toMatchObject({ kind: "start", task: plan.taskById("T1") });
    expect(describeLateCause(plan, last, cause)).toBe(
      "Held back by the fixed start 2027-03-01 of T1 (via T7999 → T7998 → T7997 → …)."
    );
    // The first four steps are kept: enough to show three and that more follow.
    expect(cause.via).toEqual(["T7999", "T7998", "T7997", "T7996"]);
    expect(lateCause(s, plan.taskById("T3")!)!.via).toEqual(["T2"]);
  });
});

describe("the burn-up of a 10,000-task plan", () => {
  const plan = planFrom(largePlanFiles({ milestones: 100 }));
  const schedule = schedulePlan(plan, { today: LARGE_PLAN_TODAY });

  it("sweeps the weeks once for the project and for every milestone", () => {
    // Was about 100 ms for the project and as much again for the milestones: weeks × tasks.
    expect(fastest(() => burnUp(plan, schedule))).toBeLessThan(timeLimit(20));
    // Was 158 ms.
    expect(fastest(() => buildDashboardModel(plan, schedule))).toBeLessThan(timeLimit(120));
    const ids = plan.milestones.map((m) => m.id);
    expect(fastest(() => milestoneBurnUps(plan, schedule, ids))).toBeLessThan(timeLimit(30));
    expect(milestoneBurnUps(plan, schedule, ids).M7).toEqual(burnUp(plan, schedule, "M7"));
  });
});

describe("a milestone with 20,000 tasks nobody can do", () => {
  it("lists them once in its incomplete forecast", () => {
    const n = 20_000;
    const tasks = Array.from(
      { length: n },
      (_, i) => `- [ ] Task ${i + 1} @est:1h @owner:jordan ^T${i + 1}`
    );
    const plan = planFrom({
      "project.md": PROJECT,
      "team.md": TEAM,
      "milestones/M1.md": md("# M1", "", ...tasks),
    });
    const s = schedulePlan(plan, { today: TODAY });
    let issues: ReturnType<typeof scheduleDiagnostics> = [];
    // Was 256 ms: the list was copied for every task.
    expect(fastest(() => (issues = scheduleDiagnostics(plan, s)))).toBeLessThan(timeLimit(80));
    expect(issues.find((i) => i.code === "incomplete-forecast")?.message).toBe(
      "M1 cannot finish: 20000 tasks cannot be scheduled (T1, T2, T3, T4, T5 …)."
    );
  });
});

describe("the team load of a large team with long work", () => {
  it("goes through the allocations once, not once per person", () => {
    const people = Array.from({ length: 100 }, (_, i) => `p${i}`);
    const plan = planFrom({
      "project.md": PROJECT,
      "team.md": md("# Team", "", ...people.flatMap((p) => [`## ${p}`, "", `id: ${p}`, ""])),
      "milestones/M1.md": md(
        "# M1",
        "",
        ...Array.from(
          { length: 2000 },
          (_, i) => `- [ ] Task ${i + 1} @est:50w @owner:${people[i % 100]} ^T${i + 1}`
        )
      ),
    });
    const demand = schedulePlan(plan, { today: TODAY, mode: "demand" });
    expect(demand.allocations.length).toBeGreaterThan(400_000);
    const from = demand.start;
    const to = demand.finish!;
    const rows = teamLoad(plan, demand, from, to);
    expect(rows).toHaveLength(100);
    expect(rows[0].weeks.reduce((s, w) => s + w.hours, 0)).toBe(20 * 50 * 40);
    // Each run on a new schedule: the allocations are grouped once per schedule.
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const fresh = schedulePlan(plan, { today: TODAY, mode: "demand" });
      const t0 = performance.now();
      teamLoad(plan, fresh, from, to);
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(timeLimit(150));
  });
});
