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
import { budgetBar, buildDashboardModel } from "../../../src/core/views/dashboard";
import { validatePlan } from "../../../src/core/validate";
import { loadSample, md, planFrom, TODAY } from "../helpers";

const project = (...props: string[]) =>
  md("# P", "", "start: 2026-10-05", "hoursPerDay: 8", ...props);
const TEAM = md("# Team", "", "## Ann", "", "capacity: 40h/week");
const SAM = md("# Team", "", "## Sam", "", "capacity: 40h/week");

describe("project budget", () => {
  it("reads hours, days, weeks and plain numbers", () => {
    expect(parseBudget("1200h", 8)).toBe(1200);
    expect(parseBudget("150d", 8)).toBe(1200);
    expect(parseBudget("30w", 8)).toBe(1200);
    expect(parseBudget("1200", 8)).toBe(1200);
    expect(parseBudget("0h", 8)).toBeUndefined();
    expect(parseBudget("lots", 8)).toBeUndefined();
    const plan = planFrom({ "project.md": project("budget: lots") });
    expect(plan.project.budget).toBeUndefined();
    expect(plan.issues.map((i) => i.code)).toContain("invalid-value");
    expect(planFrom({ "project.md": project("budget: 100d # agreed") }).project.budget).toBe(800);
  });

  it("reads a decimal comma, and thousands separators only where they cannot mean decimals", () => {
    const read = (...texts: string[]) => texts.map((t) => parseBudget(t, 8));
    expect(read("12,5h", "12.5h", "12,25", "1,5d", "0,5w", "0,125w")).toEqual([
      12.5, 12.5, 12.25, 12, 20, 5,
    ]);
    expect(read("1,200,000h", "1.200.000", "1,200.5h", "1.200,5h", "12,000.75")).toEqual([
      1_200_000, 1_200_000, 1200.5, 1200.5, 12000.75,
    ]);
    // One separator before three digits is 1200 to some and 1.2 to others: not guessed.
    expect(read("1,200", "1,200h", "1.200h", "12,000d", "125.500")).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(read("1,2,3", "1,20,000", "1.200,5,5", "1,200.000.5", ",5", "5,", "1 200h")).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    const plan = planFrom({ "project.md": project("budget: 1,200h") });
    expect(plan.project.budget).toBeUndefined();
    expect(plan.issues.find((i) => i.code === "invalid-value")?.message).toBe(
      'Budget "1,200h" can mean 1200h or 1.2h: write the one you mean.'
    );
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

  it("counts only the logged hours of cancelled work, in cancelled milestones too", () => {
    const files = {
      "project.md": project("budget: 100h"),
      "team.md": SAM,
      "milestones/M1.md": md("# M1", "", "id: M1", "", "- [ ] Build @est:80h @owner:sam ^T1"),
      "milestones/M2.md": md(
        "# M2",
        "",
        "id: M2",
        "status: cancelled",
        "",
        "- [ ] Dropped @est:50h @owner:sam ^T2"
      ),
    };
    const plan = planFrom(files);
    const s = budgetSummary(plan);
    expect(s).toMatchObject({ planned: 80, spent: 0, remaining: 80, forecast: 80, cancelled: 0 });
    expect(overBudgetReasons(s)).toEqual([]);
    expect(budgetIssues(plan)).toEqual([]);
    // Hours already logged there were spent: they stay in the forecast, and the reasons say so.
    const logged = planFrom({
      ...files,
      "project.md": project("budget: 90h"),
      "milestones/M2.md": md(
        "# M2",
        "",
        "id: M2",
        "status: cancelled",
        "",
        "- [/] Dropped @est:50h @act:12h @owner:sam ^T2",
        "  - [ ] Part @est:10h @act:2h ^T3"
      ),
    });
    const l = budgetSummary(logged);
    expect(l).toMatchObject({ planned: 80, spent: 14, remaining: 80, forecast: 94, cancelled: 14 });
    expect(l.unestimated).toEqual([]);
    expect(l.overruns).toEqual([]);
    expect(l.milestones.map((m) => m.id)).toEqual(["M1"]);
    expect(overBudgetReasons(l)).toEqual([
      "The estimates add up to 80 h, within the budget.",
      "Cancelled tasks add the 14 h logged on them.",
    ]);
  });

  it("counts hours logged on a parent once, inside its estimate", () => {
    const plan = planFrom({
      "project.md": project("budget: 35h"),
      "team.md": SAM,
      "milestones/M1.md": md(
        "# M1",
        "",
        "id: M1",
        "",
        "- [/] Feature @est:40h @act:10h @owner:sam ^T1",
        "  - [ ] Backend ^T2",
        "  - [ ] Frontend ^T3"
      ),
    });
    // The subtasks share what the 10 h logged on the parent leave of its 40 h: 15 h each.
    const s = budgetSummary(plan);
    expect(s).toMatchObject({ planned: 40, spent: 10, remaining: 30, forecast: 40 });
    expect(s.milestones).toMatchObject([{ id: "M1", planned: 40, spent: 10, forecast: 40 }]);
    expect(s.overruns).toEqual([]);
    expect(overBudgetReasons(s)[0]).toBe("The estimates add up to 40 h, 5 h over the budget.");
    expect(budgetIssues(plan)[0].message).toMatch(/^Forecast 40 h is 5 h over the budget of 35 h/);
  });

  it("reports hours logged on a parent beyond its estimate as an overrun of the parent", () => {
    const plan = planFrom({
      "project.md": project("budget: 100h"),
      "team.md": SAM,
      "milestones/M1.md": md(
        "# M1",
        "",
        "id: M1",
        "",
        // No estimate of its own: its subtasks' 20 h are all of it, so its 5 h come on top.
        "- [/] Feature @act:5h @owner:sam ^T1",
        "  - [ ] Backend @est:10h ^T2",
        "  - [ ] Frontend @est:10h ^T3",
        // Its 40 h leave 10 h after the subtasks' 30 h: 4 of its 14 h logged are over.
        "- [/] Reports @est:40h @act:14h @owner:sam ^T4",
        "  - [ ] Charts @est:30h ^T5",
        "  - [ ] Export ^T6"
      ),
    });
    const s = budgetSummary(plan);
    expect(s).toMatchObject({ planned: 60, spent: 19, remaining: 50, forecast: 69 });
    // Each against the hours planned for all of it.
    expect(s.overruns.map((o) => [o.task.id, o.hours, o.planned])).toEqual([
      ["T1", 5, 20],
      ["T4", 4, 40],
    ]);
    // Export has no estimate: what its parent's estimate would give it is used up.
    expect(s.unestimated.map((t) => t.id)).toEqual(["T6"]);
    const d = buildDashboardModel(plan, schedulePlan(plan, { today: "2026-10-05" }));
    expect(d.budget.overruns.map((o) => o.detail)).toEqual([
      "+5h over 20h · Sam",
      "+4h over 40h · Sam",
    ]);
  });

  it("takes hours logged on a parent out of what its subtasks save first", () => {
    const plan = planFrom({
      "project.md": project("budget: 30h"),
      "team.md": SAM,
      "milestones/M1.md": md(
        "# M1",
        "",
        "id: M1",
        "",
        // 4 h on the parent and 15 h on each subtask: 34 h of its 40 h.
        "- [x] Feature @est:40h @act:4h @owner:sam @done:2026-10-02 ^T1",
        "  - [x] Backend @est:20h @act:15h @done:2026-10-02 ^T2",
        "  - [x] Frontend @est:20h @act:15h @done:2026-10-02 ^T3",
        // 14 h on the parent and 15 h on each subtask: 44 h of its 40 h.
        "- [x] Reports @est:40h @act:14h @owner:sam @done:2026-10-02 ^T4",
        "  - [x] Charts @est:20h @act:15h @done:2026-10-02 ^T5",
        "  - [x] Export @est:20h @act:15h @done:2026-10-02 ^T6"
      ),
    });
    const s = budgetSummary(plan);
    expect(s).toMatchObject({ planned: 80, spent: 78, forecast: 78, savings: 6 });
    expect(s.overruns.map((o) => [o.task.id, o.hours, o.planned])).toEqual([["T4", 4, 40]]);
    expect(overBudgetReasons(s)).toEqual([
      "The estimates add up to 80 h, 50 h over the budget.",
      "Tasks taking longer than estimated add 4 h: T4 +4 h.",
      "Tasks done in less than their estimate save 6 h.",
    ]);
  });

  it("counts hours logged on work without an estimate apart, not as taking longer", () => {
    const plan = planFrom({
      "project.md": project("budget: 4h"),
      "team.md": SAM,
      "milestones/M1.md": md(
        "# M1",
        "",
        "id: M1",
        "",
        "- [/] Feature @act:5h @owner:sam ^T1",
        "  - [ ] Backend ^T2",
        "  - [ ] Frontend ^T3",
        "- [/] Spike @act:5h @owner:sam ^T4"
      ),
    });
    const s = budgetSummary(plan);
    expect(s).toMatchObject({ planned: 0, spent: 10, forecast: 10, unplanned: 10 });
    expect(s.overruns).toEqual([]);
    expect(overBudgetReasons(s)).toEqual([
      "The estimates add up to 0 h, within the budget.",
      "Tasks without an estimate add the 10 h logged on them.",
      "3 open task(s) have no estimate yet, so the forecast will grow: T2, T3, T4.",
    ]);
  });

  it("splits the forecast into logged hours, work done without logged hours and the rest", () => {
    const plan = planFrom({
      "project.md": project("budget: 100h"),
      "team.md": SAM,
      "milestones/M1.md": md(
        "# M1",
        "",
        "id: M1",
        "",
        "- [x] Done, logged @est:10h @act:12h @owner:sam @done:2026-10-02 ^T1",
        "- [x] Done, not logged @est:20h @owner:sam @done:2026-10-02 ^T2",
        "- [/] Half done @est:10h @progress:50% @owner:sam ^T3",
        "- [ ] Open @est:8h @owner:sam ^T4"
      ),
    });
    const s = budgetSummary(plan);
    expect(s).toMatchObject({ spent: 12, unlogged: 25, remaining: 13, forecast: 50 });
    expect(s.spent + s.unlogged + s.remaining).toBe(s.forecast);
    expect(s.milestones[0]).toMatchObject({ spent: 12, unlogged: 25, remaining: 13, forecast: 50 });
    // The dashboard's meter: the remaining part is the work left, not the forecast minus the logged.
    const d = buildDashboardModel(plan, schedulePlan(plan, { today: "2026-10-05" }));
    expect(d.budget).toMatchObject({ spent: 12, unlogged: 25, remaining: 13, forecast: 50 });
    expect(d.budget.bar).toEqual([
      { kind: "logged", from: 0, to: 12 },
      { kind: "unlogged", from: 12, to: 37 },
      { kind: "remaining", from: 37, to: 50 },
    ]);
  });

  it("draws the part of the meter past the budget as the overrun", () => {
    const b = { planned: 48, spent: 12, unlogged: 25, remaining: 13, forecast: 50 };
    expect(budgetBar({ ...b, budget: 30 })).toEqual([
      { kind: "logged", from: 0, to: 12 },
      { kind: "unlogged", from: 12, to: 30 },
      { kind: "overrun", from: 30, to: 50 },
    ]);
    expect(budgetBar({ ...b, budget: 10 })).toEqual([
      { kind: "logged", from: 0, to: 10 },
      { kind: "overrun", from: 10, to: 50 },
    ]);
    expect(budgetBar({ ...b, spent: 0, unlogged: 0, remaining: 50 })).toEqual([
      { kind: "remaining", from: 0, to: 50 },
    ]);
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

  /** The blocked tasks of M1 (target Fri 30 Oct) as on `today`; Alex works until Fri 16 Oct. */
  const impact = (today: string, ...tasks: string[]) => {
    const p = planFrom({
      "project.md": project(),
      "team.md": md(
        "# Team",
        "",
        "## Alex",
        "",
        "capacity: 40h/week",
        "capacityFrom: 2026-10-19 0h/week",
        "",
        "## Sam",
        "",
        "capacity: 40h/week"
      ),
      "milestones/M1.md": md("# M1", "", "id: M1", "target: 2026-10-30", "", ...tasks),
    });
    const s = schedulePlan(p, { today });
    return blockedImpact(p, s).map((b) => ({
      ...b,
      unscheduled: s.tasks.get(b.task)?.unscheduled,
    }));
  };

  it("have to leave their owner time to do the work before the owner's hours end", () => {
    const tasks = [
      "- [!] Keys @est:16h @owner:alex @blocked:keys ^T1",
      "- [!] Parts @est:8h @owner:sam @blocked:parts ^T2",
    ];
    const [keys, parts] = impact("2026-10-05", ...tasks);
    // Alex's last working day is Fri 16 Oct; the 16 h take Thu 15 and Fri 16: blocked until Wed 14.
    expect(keys).toMatchObject({ until: "2026-10-14", late: false });
    expect(describeBlockedImpact(keys)).toBe(
      "can stay blocked until 2026-10-14 (Alex has no working hours from 2026-10-19 on)"
    );
    // Sam's hours do not end: only the milestone target counts.
    expect(parts.until).toBe("2026-10-29");
    expect(parts.ownerHoursEnd).toBeUndefined();
    // On Thu 15 the work still fits, but only when it is unblocked now.
    const [now] = impact("2026-10-15", ...tasks);
    expect(now).toMatchObject({ late: true, ownerHoursEnd: { tooLate: false } });
    expect(describeBlockedImpact(now)).toBe(
      "must be unblocked now: Alex has no working hours from 2026-10-19 on"
    );
    // From Fri 16 on it no longer fits: the schedule leaves it out (no start, no slack).
    for (const today of ["2026-10-16", "2026-10-19", "2026-10-20"]) {
      const [late] = impact(today, ...tasks);
      expect(late).toMatchObject({ late: true, unscheduled: "horizon" });
      expect(describeBlockedImpact(late)).toBe(
        "already too late: Alex has no working hours from 2026-10-19 on"
      );
    }
  });

  it("are too late when their owner cannot fit the work in before the hours end", () => {
    // Keys waits for Sam's 72 h, done on Thu 15; Alex has only Fri 16 left for its 16 h.
    const [waits] = impact(
      "2026-10-05",
      "- [ ] Prep @est:72h @owner:sam ^T0",
      "- [!] Keys @est:16h @owner:alex @dep:T0 @blocked:keys ^T1"
    );
    // Alex's other 72 h go first and leave 8 h.
    const [busy] = impact(
      "2026-10-05",
      "- [ ] Other @est:72h @owner:alex ^T0",
      "- [!] Keys @est:16h @owner:alex @blocked:keys ^T1"
    );
    for (const b of [waits, busy]) {
      expect(b).toMatchObject({ late: true, ownerHoursEnd: { tooLate: true } });
      expect(describeBlockedImpact(b)).toBe(
        "already too late: Alex has no working hours from 2026-10-19 on"
      );
    }
  });

  it("are too late when their owner's work that waits for them no longer fits", () => {
    const fit = (hours: number) =>
      impact(
        "2026-10-05",
        "- [!] Keys @est:16h @owner:alex @blocked:keys ^T1",
        `- [ ] Fit @est:${hours}h @owner:alex @dep:T1 ^T2`
      )[0];
    // Alex has 80 h left: Keys can wait as long as its 16 h and Fit's still fit in.
    expect(fit(48).until).toBe("2026-10-06");
    expect(fit(56).until).toBe("2026-10-05");
    expect(fit(64)).toMatchObject({ late: true, ownerHoursEnd: { tooLate: false } });
    // 16 h and 72 h do not fit even with Keys unblocked now: the schedule leaves Fit out.
    const late = fit(72);
    expect(late).toMatchObject({ late: true, ownerHoursEnd: { tooLate: true } });
    expect(describeBlockedImpact(late)).toBe(
      "1 task (72 h) waits for it · already too late: Alex has no working hours from 2026-10-19 on"
    );
  });

  it("leave room for their owner's work that cannot go earlier", () => {
    const until = (...tasks: string[]) =>
      impact("2026-10-05", "- [!] Keys @est:16h @owner:alex @blocked:keys ^T1", ...tasks)[0].until;
    // Review is fixed on Thu 15 and Fri 16, Install can only start on Wed 14 (after Sam's Prep),
    // and Fit waits for Keys: each leaves Keys to start on Tue 13 at the latest.
    expect(until("- [ ] Review @est:16h @owner:alex @start:2026-10-15 ^T2")).toBe("2026-10-12");
    expect(
      until("- [ ] Prep @est:56h @owner:sam ^T2", "- [ ] Install @est:16h @owner:alex @dep:T2 ^T3")
    ).toBe("2026-10-12");
    expect(until("- [ ] Fit @est:16h @owner:alex @dep:T1 ^T2")).toBe("2026-10-12");
    // Work that can go first leaves Thu 15 and Fri 16 for Keys, even when it fills Alex's hours.
    expect(
      until("- [ ] Design @est:32h @owner:alex ^T2", "- [ ] Build @est:32h @owner:alex @dep:T2 ^T3")
    ).toBe("2026-10-14");
  });

  it("leave room for their owner's work that also waits for others or a fixed start", () => {
    const until = (...tasks: string[]) =>
      impact(
        "2026-10-05",
        "- [!] Keys @est:16h @owner:alex @blocked:keys ^T1",
        "- [ ] Other @est:40h @owner:alex @prio:high ^T2",
        "- [ ] Draft @est:8h @owner:alex @prio:low ^T3",
        ...tasks
      )[0].until;
    // Final follows Alex's Draft, but however early Draft goes, Final cannot start before Wed 14:
    // Sam's Prep is done on Tue 13 (on Mon 12 with a day's lag, or as a part of Phase), or Final
    // is fixed on Wed 14. Its 16 h then leave Keys to start on Tue 13 at the latest.
    expect(
      until("- [ ] Prep @est:56h @owner:sam ^T4", "- [ ] Final @est:16h @owner:alex @dep:T3,T4 ^T5")
    ).toBe("2026-10-12");
    expect(
      until(
        "- [ ] Prep @est:48h @owner:sam ^T4",
        "- [ ] Final @est:16h @owner:alex @dep:T3,T4+1d ^T5"
      )
    ).toBe("2026-10-12");
    expect(
      until(
        "- [ ] Phase @owner:sam ^T6",
        "  - [ ] Prep @est:56h ^T4",
        "- [ ] Final @est:16h @owner:alex @dep:T3,T6 ^T5"
      )
    ).toBe("2026-10-12");
    expect(until("- [ ] Final @est:16h @owner:alex @dep:T3 @start:2026-10-14 ^T5")).toBe(
      "2026-10-12"
    );
  });

  it("with subtasks leave their owner time for all of the work together", () => {
    const [b] = impact(
      "2026-10-05",
      "- [!] Integration @owner:alex @blocked:keys ^T1",
      "  - [ ] Part A @est:16h ^T2",
      "  - [ ] Part B @est:16h ^T3"
    );
    // Both parts wait for it and need Alex: 32 h take Tue 13 to Fri 16, so blocked until Mon 12.
    expect(b).toMatchObject({ hours: 32, until: "2026-10-12", late: false });
    expect(describeBlockedImpact(b)).toBe(
      "can stay blocked until 2026-10-12 (Alex has no working hours from 2026-10-19 on)"
    );
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

  it("say they delay the end date when it is missed already, also when their owner's hours end", () => {
    // Keys is due Tue 13 but takes Alex until Fri 16, their last working day: 3 days late, on a
    // Monday as on a Tuesday. Unblocking it now no longer keeps the date.
    for (const [today, hours, until] of [
      ["2026-10-12", 40, "2026-10-09"],
      ["2026-10-13", 32, "2026-10-12"],
    ] as const) {
      const [b] = impact(
        today,
        `- [!] Keys @est:${hours}h @owner:alex @blocked:keys @due:2026-10-13 ^T1`
      );
      expect(b).toMatchObject({ late: true, until, unscheduled: undefined });
      expect(b.ownerHoursEnd).toBeUndefined();
      expect(describeBlockedImpact(b)).toBe(
        "already delaying the end date: every day blocked moves it"
      );
    }
  });
});
