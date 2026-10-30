// The status report of a project entered after the fact: finished milestones are no risk, and a
// mistyped year does not blow the burn-up up.
import { describe, expect, it } from "vitest";
import { schedulePlan } from "../../../src/core/scheduler";
import { computeRisks, REPORT_SECTIONS, renderStatusReport } from "../../../src/export/html/report";
import { md, planFrom } from "../helpers";

const TODAY = "2026-10-14";
const TEAM = md("# Team", "", "## Bob", "", "capacity: 40h/week");

describe("status report risks", () => {
  it("leaves out a milestone whose work is all done, however late it finished", () => {
    const p = planFrom({
      "project.md": md("# P", "", "start: 2026-06-01", "end: 2027-03-31"),
      "team.md": TEAM,
      "milestones/M1.md": md(
        "# M1 – Pilot",
        "",
        "target: 2026-07-01",
        "",
        "- [x] Build @est:2d @owner:bob @started:2026-07-06 @done:2026-07-10 ^T1",
        "- [-] Dropped @est:1d @owner:bob ^T2"
      ),
      "milestones/M2.md": md(
        "# M2 – Rollout",
        "",
        "target: 2026-10-15",
        "",
        "- [ ] Roll out @est:2w @owner:bob ^T3"
      ),
    });
    const s = schedulePlan(p, { today: TODAY });
    expect(s.milestones.get("M1")!.late).toBe(true);
    const risks = computeRisks(p, s);
    expect(risks.some((r) => r.includes("M1 – Pilot"))).toBe(false);
    expect(risks.some((r) => r.includes("<b>M2 – Rollout</b> is forecast"))).toBe(true);
  });
});

describe("status report of a plan with a mistyped year", () => {
  it("draws the burn-up over the project period only", () => {
    const p = planFrom({
      "project.md": md("# P", "", "start: 2026-06-01", "end: 2026-12-31"),
      "team.md": TEAM,
      "milestones/M1.md": md(
        "# M1",
        "",
        "- [x] Setup @est:2d @act:4h @owner:bob @started:1026-07-01 @done:2026-07-03 ^T1",
        "  - [x] Server @owner:bob @done:2026-07-03 ^T2",
        "- [ ] Rollout @est:2d @owner:bob ^T3"
      ),
    });
    const html = renderStatusReport(p, schedulePlan(p, { today: TODAY }), {
      sections: REPORT_SECTIONS.map((x) => x.id),
      periodDays: 14,
      ganttWeeks: 8,
    });
    expect(html.length).toBeLessThan(60_000);
  });
});
