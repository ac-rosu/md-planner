import { describe, expect, it } from "vitest";
import {
  blockedImpact,
  budgetIssues,
  budgetSummary,
  describeBlockedImpact,
  overBudgetReasons,
} from "../../../src/core/budget";
import { burnUp } from "../../../src/core/metrics";
import { parseBudget } from "../../../src/core/resolve";
import { schedulePlan } from "../../../src/core/scheduler";
import { burnUpGeometry } from "../../../src/core/views/charts";
import { buildDashboardModel } from "../../../src/core/views/dashboard";
import { validatePlan } from "../../../src/core/validate";
import { loadSample, md, planFrom, TODAY } from "../helpers";

const project = (...props: string[]) =>
  md("# P", "", "start: 2026-10-05", "hoursPerDay: 8", ...props);
const TEAM = md("# Team", "", "## Ann", "", "capacity: 40h/week");

describe("project budget", () => {
  it("reads hours, days, weeks and plain numbers", () => {
    expect(parseBudget("1200h", 8)).toBe(1200);
    expect(parseBudget("150d", 8)).toBe(1200);
    expect(parseBudget("30w", 8)).toBe(1200);
    expect(parseBudget("1,200", 8)).toBe(1200);
    expect(parseBudget("0h", 8)).toBeUndefined();
    expect(parseBudget("lots", 8)).toBeUndefined();
    const plan = planFrom({ "project.md": project("budget: lots") });
    expect(plan.project.budget).toBeUndefined();
    expect(plan.issues.map((i) => i.code)).toContain("invalid-value");
    expect(planFrom({ "project.md": project("budget: 100d # agreed") }).project.budget).toBe(800);
  });

  it("adds up planned, logged, remaining and forecast hours, per milestone too", () => {
    const plan = planFrom({
      "project.md": project("budget: 60h"),
      "team.md": TEAM,
      "milestones/M1.md": md(
        "# M1",
        "",
        "id: M1",
        "",
        "- [x] Over @est:10h @act:14h @owner:ann ^T1",
        "- [x] Under @est:10h @act:7h @owner:ann ^T2",
        "- [x] No actuals @est:5h @owner:ann ^T3",
        "- [/] Half done @est:10h @act:8h @owner:ann ^T4",
        "- [/] Progress @est:10h @progress:50% @owner:ann ^T5"
      ),
      "milestones/M2.md": md(
        "# M2",
        "",
        "id: M2",
        "",
        "- [-] Dropped @est:20h @act:3h @owner:ann ^T6",
        "- [!] Waiting @est:6h @act:9h @owner:ann @blocked:keys ^T7",
        "- [ ] Not estimated @owner:ann ^T8"
      ),
    });
    const s = budgetSummary(plan);
    // Planned: every estimate but the cancelled task. Logged: every @act, the cancelled one too.
    expect(s.planned).toBe(51);
    expect(s.spent).toBe(41);
    // Remaining: T4 2h, T5 5h, T7 0h (already over), T8 0h.
    expect(s.remaining).toBe(7);
    // Forecast: 14 + 7 + 5 + (8 + 2) + (5 + 5) + 3 (cancelled, logged) + 9 = 58.
    expect(s.forecast).toBe(58);
    expect(s.overruns.map((o) => [o.task.id, o.hours])).toEqual([
      ["T1", 4],
      ["T7", 3],
    ]);
    expect(s.savings).toBe(3);
    expect(s.unestimated.map((t) => t.id)).toEqual(["T8"]);
    expect(s.milestones.map((m) => [m.id, m.planned, m.spent, m.forecast])).toEqual([
      ["M1", 45, 29, 46],
      ["M2", 6, 12, 12],
    ]);
    // Within the budget: no reasons, no warning.
    expect(overBudgetReasons(s)).toEqual([]);
    expect(budgetIssues(plan)).toEqual([]);
  });

  it("says why the forecast is over the budget, and warns on the budget line", () => {
    const plan = planFrom({
      "project.md": project("budget: 20h"),
      "team.md": TEAM,
      "milestones/M1.md": md(
        "# M1",
        "",
        "id: M1",
        "",
        "- [x] Over @est:10h @act:14h @owner:ann ^T1",
        "- [!] Waiting @est:6h @act:9h @owner:ann @blocked:keys ^T7",
        "- [ ] Not estimated @owner:ann ^T8"
      ),
    });
    const s = budgetSummary(plan);
    expect(overBudgetReasons(s)).toEqual([
      "The estimates add up to 16 h, within the budget.",
      "Tasks taking longer than estimated add 7 h: T1 +4 h, T7 +3 h (blocked).",
      "1 open task(s) have no estimate yet, so the forecast will grow: T8.",
    ]);
    const [issue] = budgetIssues(plan);
    expect(issue).toMatchObject({ file: "project.md", severity: "warning", code: "over-budget" });
    expect(issue.message).toMatch(/^Forecast 23 h is 3 h over the budget of 20 h\. The estimates/);
    expect(issue.range.start.line).toBe(4);
    expect(validatePlan(plan).map((i) => i.code)).toContain("over-budget");
  });

  it("draws the budget as a line on the burn-up", () => {
    const plan = loadSample().plan;
    const schedule = schedulePlan(plan, { today: TODAY });
    const plain = burnUpGeometry(burnUp(plan, schedule));
    expect(plain.budgetY).toBeUndefined();
    const g = burnUpGeometry({ ...burnUp(plan, schedule), budget: 1100 });
    expect(g.max).toBeGreaterThanOrEqual(1100);
    expect(g.budgetY).toBeGreaterThan(g.plot.top);
    expect(g.budgetY).toBeLessThan(g.plot.bottom);
  });

  it("shows the budget against the plan on the dashboard of the sample", () => {
    const plan = loadSample().plan;
    const d = buildDashboardModel(plan, schedulePlan(plan, { today: TODAY }));
    expect(d.budget).toMatchObject({ budget: 800, planned: 820, spent: 82, forecast: 826 });
    expect(d.budget.reasons[0]).toBe("The estimates add up to 820 h, 20 h over the budget.");
    expect(d.budget.overruns[0]).toMatchObject({ id: "T004", detail: "+4h over 16h · Jordan" });
    expect(d.burnUp.project.budget).toBe(800);
  });
});

describe("blocked tasks", () => {
  const plan = planFrom({
    "project.md": project(),
    "team.md": md(
      "# Team",
      "",
      "## Ann",
      "",
      "capacity: 40h/week",
      "",
      "## Bob",
      "",
      "capacity: 40h/week"
    ),
    "milestones/M1.md": md(
      "# M1",
      "",
      "id: M1",
      "target: 2026-10-30",
      "",
      "- [!] Keys @est:8h @owner:ann @blocked:waiting for keys ^T1",
      "- [ ] Build @est:16h @owner:bob @dep:T1 ^T2",
      "- [ ] Test @est:8h @owner:bob @dep:T2 ^T3",
      "- [!] Side @est:8h @owner:ann @blocked:waiting for a decision ^T4"
    ),
  });
  const schedule = schedulePlan(plan, { today: "2026-10-05" });

  it("say what waits for them and how long they can stay blocked", () => {
    const [keys, side] = blockedImpact(plan, schedule);
    expect(keys.task.id).toBe("T1");
    expect(keys.waiting.map((t) => t.id)).toEqual(["T2", "T3"]);
    expect(keys.waitingHours).toBe(24);
    // Back from Fri 30 Oct: T3 on Fri 30, T2 on Wed 28 and Thu 29, so T1 must be done on Tue 27:
    // it can stay blocked until Mon 26 Oct.
    expect(keys.until).toBe("2026-10-26");
    expect(keys.critical).toBe(true);
    expect(describeBlockedImpact(keys)).toBe(
      "2 tasks (24 h) wait for it · can stay blocked until 2026-10-26 (critical path: after that the end date moves)"
    );
    expect(side.waiting).toEqual([]);
    expect(describeBlockedImpact(side)).toMatch(/^can stay blocked until 2026-10-2\d$/);
  });

  it("are delaying the plan when they have no slack left", () => {
    const tight = planFrom({
      "project.md": project(),
      "team.md": TEAM,
      "milestones/M1.md": md(
        "# M1",
        "",
        "id: M1",
        "target: 2026-10-06",
        "",
        "- [!] Keys @est:16h @owner:ann @blocked:keys ^T1"
      ),
    });
    const [b] = blockedImpact(tight, schedulePlan(tight, { today: "2026-10-05" }));
    expect(b.critical).toBe(true);
    expect(b.late).toBe(true);
    expect(describeBlockedImpact(b)).toBe(
      "already delaying the end date: every day blocked moves it"
    );
  });
});
