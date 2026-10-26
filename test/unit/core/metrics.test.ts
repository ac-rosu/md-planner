import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  baselineFileName,
  baselineLookup,
  baselineSlug,
  baselineText,
  createBaseline,
  latestBaseline,
  milestoneTrends,
  parseBaseline,
} from "../../../src/core/baseline";
import { formatDate, parseDate, weekStart } from "../../../src/core/dates";
import {
  attentionLists,
  burnUp,
  describeAccuracy,
  estimateAccuracy,
  punchStats,
  testStats,
} from "../../../src/core/metrics";
import { schedulePlan } from "../../../src/core/scheduler";
import { addActual, formatElapsed, parseLoggedTime, roundMinutes } from "../../../src/core/time";
import { burnUpGeometry, niceMax } from "../../../src/core/views/charts";
import { buildDashboardModel } from "../../../src/core/views/dashboard";
import { buildResourcesModel, overloadedWeeks } from "../../../src/core/views/resources";
import { loadSample, md, planFrom, SAMPLE_PLAN, TODAY } from "../helpers";

const plan = loadSample().plan;
const schedule = schedulePlan(plan, { today: TODAY });

describe("estimate accuracy", () => {
  it("compares estimates with actuals of done tasks per person and tag", () => {
    const acc = estimateAccuracy(plan);
    expect(acc.overall).toMatchObject({ n: 8, est: 66, act: 72 });
    const byPerson = Object.fromEntries(acc.byPerson.map((r) => [r.key, r]));
    expect(byPerson.alex).toMatchObject({ n: 4, est: 28, act: 32 });
    expect(byPerson.jordan).toMatchObject({ n: 2, est: 24, act: 27 });
    expect(byPerson.sam).toMatchObject({ n: 2, est: 14, act: 13 });
    const byTag = Object.fromEntries(acc.byTag.map((r) => [r.key, r]));
    expect(byTag.integration).toMatchObject({ n: 1, est: 16, act: 20, ratio: 1.25 });
    expect(byTag.checkout).toMatchObject({ n: 1, est: 6, act: 7 }); // inherited from the parent
    expect(describeAccuracy(byTag.integration, "#integration tasks")).toBe(
      "#integration tasks: underestimated by 25% (n = 1)"
    );
    expect(describeAccuracy(byPerson.sam, "Sam")).toBe("Sam: overestimated by 7% (n = 2)");
    expect(describeAccuracy({ key: "x", n: 0, est: 0, act: 0, ratio: 0 }, "X")).toMatch(
      /no completed tasks/
    );
  });
});

describe("burn-up", () => {
  it("counts done hours to today and forecasts from the schedule to the full scope", () => {
    const b = burnUp(plan, schedule);
    const scope = plan.tasks
      .filter((t) => t.children.length === 0 && t.status !== "cancelled")
      .reduce((s, t) => s + (t.est ?? 0), 0);
    expect(b.scope).toBe(scope);
    const thisWeek = b.points.find((p) => p.week === weekStart(parseDate(TODAY)!))!;
    expect(thisWeek.done).toBe(66);
    expect(thisWeek.forecast).toBeGreaterThanOrEqual(66);
    expect(b.points.at(-1)!.forecast).toBe(scope);
    expect(b.points.at(-1)!.done).toBeUndefined();
    expect(b.points[0].forecast).toBeUndefined();
    const m1 = burnUp(plan, schedule, "M1");
    expect(m1.scope).toBe(94);
  });

  it("counts hours logged on a parent within its estimate, like the budget does", () => {
    // Its unestimated subtasks share only the 30h left, so the 10h logged are planned and done.
    const p = planFrom({
      "project.md": md("# P", "", "start: 2026-10-01", "end: 2027-03-31"),
      "team.md": md("# Team", "", "## Sam", "", "capacity: 40h/week"),
      "milestones/M1.md": md(
        "# M1",
        "",
        "- [/] Feature @est:40h @act:10h @owner:sam @started:2026-10-01 ^T1",
        "  - [ ] Backend ^T2",
        "  - [ ] Frontend ^T3"
      ),
    });
    const b = burnUp(p, schedulePlan(p, { today: "2026-10-05" }));
    expect(b.scope).toBe(40);
    expect(b.points.find((x) => x.week === weekStart(parseDate("2026-10-05")!))!.done).toBe(10);
    expect(b.points.at(-1)!.forecast).toBe(40);
    // A done parent without @started: in the week it was done, not this week.
    const done = planFrom({
      "project.md": md("# P", "", "start: 2026-09-01", "end: 2027-03-31"),
      "team.md": md("# Team", "", "## Sam", "", "capacity: 40h/week"),
      "milestones/M1.md": md(
        "# M1",
        "",
        "- [x] Feature @est:40h @act:10h @owner:sam @done:2026-09-11 ^T1",
        "  - [x] Backend @est:15h @act:15h @started:2026-09-01 @done:2026-09-04 ^T2",
        "  - [x] Frontend @est:15h @act:15h @started:2026-09-07 @done:2026-09-11 ^T3",
        "- [ ] Next @est:40h @owner:sam ^T4"
      ),
    });
    const d = burnUp(done, schedulePlan(done, { today: "2026-10-26" }));
    expect(d.points.find((x) => x.week === weekStart(parseDate("2026-09-07")!))!.done).toBe(40);
  });

  it("produces chart geometry with ticks and a today line", () => {
    const g = burnUpGeometry(burnUp(plan, schedule), 640, 240);
    expect(g.done).toMatch(/^M[\d.]+,[\d.]+(L[\d.]+,[\d.]+)*$/);
    expect(g.forecast.startsWith("M")).toBe(true);
    expect(g.todayX).toBeGreaterThan(g.plot.left);
    expect(g.xTicks[0].label).toBe("Oct 2026");
    expect(g.yTicks.at(-1)!.label).toBe(`${g.max}h`);
    expect([niceMax(7), niceMax(180), niceMax(1001)]).toEqual([10, 200, 2000]);
  });
});

describe("attention lists, tests and punch items", () => {
  it("lists blocked, starting this week, unassigned and unestimated work", () => {
    const l = attentionLists(plan, schedule);
    expect(l.overdue).toEqual([]);
    expect(l.blocked.map((t) => t.id)).toEqual(["T106"]);
    expect(l.startingThisWeek.map((t) => t.id)).toEqual(["T009", "T010", "T301", "T011"]);
    expect(l.unassigned.map((t) => t.id)).toEqual(["T112", "T209"]);
    expect(l.unestimated).toEqual([]);
    const later = attentionLists(plan, schedulePlan(plan, { today: "2026-11-02" }));
    expect(later.overdue.length).toBeGreaterThan(0);
  });

  it("summarises test plans and the punch list", () => {
    expect(testStats(plan.testById("UAT-01")!)).toMatchObject({
      steps: 4,
      pass: 1,
      fail: 1,
      na: 0,
      open: 2,
      cases: 2,
      runs: 1,
      lastRun: "2026-10-12",
    });
    expect(punchStats(plan, TODAY)).toEqual({
      open: 4,
      closed: 1,
      bySeverity: { A: 1, B: 2, C: 1, none: 0 },
      overdue: 0,
    });
    expect(punchStats(plan, "2026-11-01").overdue).toBe(1);
  });
});

describe("baselines", () => {
  const sample = parseBaseline(
    readFileSync(join(SAMPLE_PLAN, "baselines/2026-10-07-kickoff.json"), "utf8")
  );

  it("snapshots planned start, finish and hours and round-trips through JSON", () => {
    const b = createBaseline(plan, schedule, "After FDS review");
    expect(baselineFileName(b)).toBe("2026-10-14-after-fds-review.json");
    expect(b.tasks.T107).toMatchObject({ start: "2026-11-12", finish: "2026-11-20", hours: 40 });
    expect(b.tasks.T102).toMatchObject({ hours: 12 });
    expect(b.milestones.M5).toMatchObject({ target: "2027-03-26", forecast: "2027-03-31" });
    expect(parseBaseline(baselineText(b))).toEqual(b);
    expect(() => parseBaseline("{}", "x.json")).toThrow(/not a planner baseline/);
    expect(() => parseBaseline("nope", "x.json")).toThrow(/not valid JSON/);
    expect(baselineSlug("Ünïcode & Co!")).toBe("unicode-co");
  });

  it("feeds the Gantt overlay and the milestone trend", () => {
    const lookup = baselineLookup(sample);
    expect(lookup.task("T107")).toEqual({
      start: parseDate(sample.tasks.T107.start!),
      finish: parseDate(sample.tasks.T107.finish!),
    });
    expect(lookup.task("milestone:M1")?.finish).toBe(parseDate(sample.milestones.M1.forecast!));
    const trends = milestoneTrends(plan, schedule, sample);
    // M1 slipped since the kickoff; M2 and M5 are pinned by fixed starts (T105, T304).
    expect(trends.get("M1")!.slip).toBeGreaterThan(0);
    expect(trends.get("M2")!.slip).toBe(0);
    expect(trends.get("M5")!.slip).toBe(0);
    expect(
      latestBaseline([
        { date: "2026-10-07", name: "b" },
        { date: "2026-10-14", name: "a" },
      ])?.name
    ).toBe("a");
  });
});

describe("time tracking", () => {
  it("rounds up and parses logged time", () => {
    expect([
      roundMinutes(1, 15),
      roundMinutes(15, 15),
      roundMinutes(16, 15),
      roundMinutes(0, 15),
      roundMinutes(50, 15),
    ]).toEqual([15, 15, 30, 0, 60]);
    expect(["1.5", "1.5h", "90m", "1h30m", "1h30", "1:30"].map(parseLoggedTime)).toEqual([
      1.5, 1.5, 1.5, 1.5, 1.5, 1.5,
    ]);
    expect(["0", "-1", "abc", ""].map(parseLoggedTime)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(addActual(5, 1.25)).toBe("6.25h");
    expect(addActual(undefined, 2)).toBe("2h");
    expect(formatElapsed(65 * 60_000)).toBe("1:05");
  });
});

describe("resource heatmap", () => {
  it("shows no overload in the capacity-constrained schedule", () => {
    expect(overloadedWeeks(buildResourcesModel(plan, schedule)).size).toBe(0);
  });

  it("shows the sample's raw overload in the correct ISO weeks in demand mode", () => {
    const demand = buildResourcesModel(plan, schedulePlan(plan, { today: TODAY, mode: "demand" }));
    expect(Object.fromEntries(overloadedWeeks(demand))).toEqual({
      alex: ["2026-W44"],
      sam: ["2026-W43", "2026-W44"],
      priya: ["2026-W43"],
      maria: ["2027-W12"],
    });
    const sam = demand.rows.find((r) => r.id === "sam")!.cells.find((c) => c.week === "2026-W43")!;
    expect(sam).toMatchObject({ hours: 58, capacity: 40, level: "over" });
    expect(sam.tasks.map((t) => t.key)).toEqual(["T121", "T113", "T122", "T104"]);
  });

  it("hatches time off and marks the current week", () => {
    const m = buildResourcesModel(plan, schedule);
    const cell = (id: string, week: string) =>
      m.rows.find((r) => r.id === id)!.cells.find((c) => c.week === week)!;
    expect(cell("alex", "2026-W52").off).toBe("part");
    expect(cell("alex", "2026-W53").off).toBe("full");
    expect(cell("sam", "2026-W47")).toMatchObject({ off: "part", capacity: 8 });
    expect(cell("maria", "2026-W42").capacity).toBe(16);
    expect(m.todayWeek).toBe("2026-W42");
    expect(m.weeks[0].label).toMatch(/^W\d\d$/);
    expect(formatDate(m.weeks[0].start)).toBe("2026-09-28");
  });
});

describe("dashboard model", () => {
  it("collects milestone cards with baseline trend, KPIs and lists", () => {
    const baseline = parseBaseline(
      readFileSync(join(SAMPLE_PLAN, "baselines/2026-10-07-kickoff.json"), "utf8")
    );
    const d = buildDashboardModel(plan, schedule, baseline);
    expect(d.milestones.map((m) => m.id)).toEqual(["M1", "M2", "M3", "M4", "M5"]);
    expect(d.milestones[4]).toMatchObject({
      late: true,
      variance: 3,
      forecast: "2027-03-31",
      trend: { baseline: "kickoff", slip: 0 },
    });
    expect(d.forecastFinish).toBe("2027-03-31");
    expect(d.endVariance).toBe(0);
    expect(d.lists.blocked[0]).toMatchObject({
      id: "T106",
      detail:
        "waiting for the payment provider API keys · Priya · can stay blocked until 2026-12-14",
    });
    expect(d.criticalPath[0].id).toBe("T304");
    expect(d.tests.map((t) => t.id)).toEqual(["UAT-01", "UAT-02"]);
    expect(d.baseline).toBe("kickoff");
    expect(d.personNames.alex).toBe("Alex");
  });

  it("reads an empty @blocked as no reason", () => {
    const p = planFrom({
      "project.md": md("# P", "", "start: 2026-10-05"),
      "team.md": md("# Team", "", "## Sam", "", "capacity: 40h/week"),
      "milestones/M1.md": md(
        "# M1",
        "",
        "id: M1",
        "",
        "- [!] Keys @est:8h @owner:sam @blocked: ^T1",
        '- [!] Sign-off @est:4h @owner:sam @blocked:"" ^T2',
        '- [!] Review @est:4h @owner:sam @blocked:"  " ^T3',
        '- [!] Access @est:4h @owner:sam @blocked:" waiting for VPN access " ^T4'
      ),
    });
    expect(p.tasks.map((t) => t.blocked)).toEqual([
      undefined,
      undefined,
      undefined,
      "waiting for VPN access",
    ]);
    const d = buildDashboardModel(p, schedulePlan(p, { today: "2026-10-05" }));
    expect(d.lists.blocked.map((i) => i.detail.split(" · ")[0])).toEqual([
      "no reason given",
      "no reason given",
      "no reason given",
      "waiting for VPN access",
    ]);
  });
});
