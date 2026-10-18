import { describe, expect, it } from "vitest";
import { Calendar } from "../../../src/core/calendar";
import { formatDate, parseDate as d } from "../../../src/core/dates";
import { describeOvertime, taskOvertime, weekLoadAt } from "../../../src/core/load";
import { buildGanttModel } from "../../../src/core/views/gantt";
import { buildKanbanModel } from "../../../src/core/views/kanban";
import { parseOvertime, parseWorkday } from "../../../src/core/resolve";
import { schedulePlan } from "../../../src/core/scheduler";
import { daysOffSuggestions } from "../../../src/core/dates";
import { buildDashboardModel } from "../../../src/core/views/dashboard";
import { buildResourcesModel, plannedOvertime } from "../../../src/core/views/resources";
import { loadSample, md, planFrom, TODAY } from "../helpers";

// Mon 2026-10-05 start; Wed 2026-10-14 is a holiday; Sat 2026-10-10 is a weekend day.
const PROJECT = md(
  "# P",
  "",
  "start: 2026-10-05",
  "workweek: mon-fri",
  "hoursPerDay: 8",
  "holidays: 2026-10-14"
);

function team(ann: string[] = [], bob: string[] = []) {
  return md(
    "# Team",
    "",
    "## Ann",
    "",
    "capacity: 40h/week",
    ...ann,
    "",
    "## Bob",
    "",
    "capacity: 4h/day",
    ...bob
  );
}

function plan(ann: string[] = [], bob: string[] = [], tasks: string[] = []) {
  return planFrom({
    "project.md": PROJECT,
    "team.md": team(ann, bob),
    "milestones/M1.md": md("# M1", "", "id: M1", "", ...tasks),
  });
}

function dates(p: ReturnType<typeof plan>, id: string) {
  const ts = schedulePlan(p, { today: "2026-10-05" }).byKey.get(id)!;
  return [formatDate(ts.start!), formatDate(ts.finish!)];
}

describe("overtime and extra working days", () => {
  it("parses overtime and workday values", () => {
    expect(parseOvertime("2026-11-02..2026-11-27 +8h/week")).toEqual({
      from: d("2026-11-02"),
      to: d("2026-11-27"),
      hours: 8,
      per: "week",
    });
    expect(parseOvertime("2026-11-05 2h/day")).toEqual({
      from: d("2026-11-05"),
      to: d("2026-11-05"),
      hours: 2,
      per: "day",
    });
    expect(parseOvertime("2026-11-05")).toBeUndefined();
    expect(parseOvertime("2026-11-05 +0h/day")).toBeUndefined();
    expect(parseOvertime("2026-11-27..2026-11-02 +8h/week")).toBeUndefined();
    expect(parseWorkday("2026-11-07", 8)).toEqual({ from: d("2026-11-07"), to: d("2026-11-07") });
    expect(parseWorkday("2026-11-07..2026-11-08 0.5d", 8)).toEqual({
      from: d("2026-11-07"),
      to: d("2026-11-08"),
      hours: 4,
    });
    expect(parseWorkday("2026-11-07 30h", 8)).toBeUndefined();
    expect(parseWorkday("saturday", 8)).toBeUndefined();
  });

  it("reads them from team.md and reports invalid and useless entries", () => {
    const p = plan(
      [
        "overtime: 2026-10-05..2026-10-09 +10h/week",
        "overtime: next week",
        "overtime: 2026-10-10..2026-10-11 +2h/day",
        "workday: 2026-10-10 6h",
        "workday: 2026-10-06",
        "workday: someday",
        "off: 2026-10-17",
        "workday: 2026-10-17",
      ],
      []
    );
    const ann = p.personById("ann")!;
    expect(ann.overtime).toHaveLength(2);
    expect(ann.workdays).toHaveLength(3);
    const issues = p.issues.filter((i) => i.file === "team.md").map((i) => [i.code, i.severity]);
    expect(issues).toEqual([
      ["invalid-value", "error"],
      ["overtime-no-working-days", "warning"],
      ["workday-not-needed", "warning"],
      ["invalid-value", "error"],
      ["workday-during-time-off", "warning"],
    ]);
  });

  it("adds overtime on working days and the hours of extra working days", () => {
    const p = plan(
      [
        "overtime: 2026-10-05..2026-10-09 +10h/week",
        "workday: 2026-10-10",
        "workday: 2026-10-14 6h",
      ],
      [
        "overtime: 2026-10-05..2026-10-16 +2h/day",
        "workday: 2026-10-11",
        "off: 2026-10-18",
        "workday: 2026-10-18",
      ]
    );
    const cal = new Calendar(p.project, p.people);
    expect(cal.capacity("ann", d("2026-10-05")!)).toBe(10); // 8 + 10/5
    expect(cal.normalCapacity("ann", d("2026-10-05")!)).toBe(8);
    expect(cal.overtimeCapacity("ann", d("2026-10-05")!)).toBe(2);
    expect(cal.capacity("ann", d("2026-10-12")!)).toBe(8); // after the period
    expect(cal.capacity("ann", d("2026-10-10")!)).toBe(8); // Saturday: a normal day's hours
    expect(cal.normalCapacity("ann", d("2026-10-10")!)).toBe(0);
    expect(cal.capacity("ann", d("2026-10-11")!)).toBe(0); // Sunday
    expect(cal.capacity("ann", d("2026-10-14")!)).toBe(6); // works the holiday
    expect(cal.capacity("bob", d("2026-10-06")!)).toBe(6); // 4h/day + 2h/day
    expect(cal.capacity("bob", d("2026-10-11")!)).toBe(4); // Sunday at 4h/day
    expect(cal.capacity("bob", d("2026-10-18")!)).toBe(0); // time off wins
  });

  it("schedules into overtime and extra working days", () => {
    const task = ["- [ ] Big job @est:48h @owner:ann ^T1"];
    expect(dates(plan([], [], task), "T1")).toEqual(["2026-10-05", "2026-10-12"]);
    expect(dates(plan(["workday: 2026-10-10"], [], task), "T1")).toEqual([
      "2026-10-05",
      "2026-10-10",
    ]);
    expect(dates(plan(["overtime: 2026-10-05..2026-10-09 +8h/week"], [], task), "T1")).toEqual([
      "2026-10-05",
      "2026-10-09",
    ]);
  });

  it("hands over on the next day the new owner works", () => {
    const tasks = [
      "- [ ] First @est:40h @owner:ann ^T1",
      "- [ ] Second @est:4h @owner:bob @dep:T1 ^T2",
    ];
    expect(dates(plan([], [], tasks), "T2")).toEqual(["2026-10-12", "2026-10-12"]);
    expect(dates(plan([], ["workday: 2026-10-10"], tasks), "T2")).toEqual([
      "2026-10-10",
      "2026-10-10",
    ]);
  });

  it("counts the scheduled overtime per week", () => {
    const p = plan(
      ["overtime: 2026-10-05..2026-10-09 +10h/week", "workday: 2026-10-10 4h"],
      [],
      ["- [ ] Big job @est:52h @owner:ann ^T1"]
    );
    const s = schedulePlan(p, { today: "2026-10-05" });
    const w = weekLoadAt(s, "ann", d("2026-10-05")!);
    expect(w.hours).toBe(52);
    expect(w.capacity).toBe(54);
    expect(w.normal).toBe(40);
    expect(w.overtimeCapacity).toBe(14);
    expect(w.overtime).toBe(12);
  });

  it("spreads the hours of done tasks over the days the person worked", () => {
    const p = plan(
      ["workday: 2026-10-10", "off: 2026-10-09"],
      [],
      ["- [x] Done job @act:10h @owner:ann @started:2026-10-05 @done:2026-10-11 ^T1"]
    );
    const s = schedulePlan(p, { today: "2026-10-12" });
    const days = s.allocations.filter((a) => a.key === "T1").map((a) => formatDate(a.day));
    expect(days).toEqual(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-10"]);
    expect(s.allocations.find((a) => a.key === "T1")!.hours).toBe(2);
  });
});

describe("overtime in the sample project", () => {
  const plan = loadSample().plan;
  const schedule = schedulePlan(plan, { today: TODAY });

  it("marks the team load cells and sums the planned overtime", () => {
    const model = buildResourcesModel(plan, schedule);
    const sam = model.rows.find((r) => r.id === "sam")!;
    expect(sam.cells.find((c) => c.week === "2026-W45")).toMatchObject({
      hours: 48,
      capacity: 48,
      normal: 40,
      overtimeCapacity: 8,
      overtime: 8,
      extraDays: [],
    });
    const maria = model.rows.find((r) => r.id === "maria")!;
    expect(maria.cells.find((c) => c.week === "2026-W48")).toMatchObject({
      normal: 16,
      overtimeCapacity: 4,
      overtime: 4,
      extraDays: ["2026-11-27"],
    });
    expect(plannedOvertime(model)).toEqual([
      {
        id: "sam",
        name: "Sam",
        hours: 11.2,
        weeks: [
          { week: "2026-W45", hours: 8 },
          { week: "2026-W46", hours: 3.2 },
        ],
      },
      { id: "maria", name: "Maria", hours: 4, weeks: [{ week: "2026-W48", hours: 4 }] },
    ]);
  });

  it("shows the planned overtime on the dashboard", () => {
    expect(buildDashboardModel(plan, schedule).overtime).toEqual({
      hours: 15.2,
      byPerson: [
        { name: "Sam", hours: 11.2, weeks: ["2026-W45", "2026-W46"] },
        { name: "Maria", hours: 4, weeks: ["2026-W48"] },
      ],
    });
  });

  it("suggests weekend days and holidays as extra working days", () => {
    const s = daysOffSuggestions(d("2026-12-24")!, plan.project.workweek, plan.project.holidays, {
      limit: 5,
    });
    expect(s).toEqual([
      { label: "Friday 25 Dec (holiday)", date: "2026-12-25" },
      { label: "Saturday 26 Dec (holiday)", date: "2026-12-26" },
      { label: "Sunday 27 Dec", date: "2026-12-27" },
      { label: "Friday 1 Jan (holiday)", date: "2027-01-01" },
      { label: "Saturday 2 Jan", date: "2027-01-02" },
    ]);
  });

  it("attributes the overtime to the tasks that got the last hours of each day", () => {
    const o = taskOvertime(schedule);
    const summary = [...o].map(([key, t]) => [key, Math.round(t.hours * 10) / 10]);
    expect(summary).toEqual([
      ["T114", 4.8],
      ["T206", 4.8],
      ["T105", 1.6],
      ["T303", 4],
    ]);
    expect(o.get("T114")!.days.map((d) => formatDate(d.day))).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
    ]);
    expect(describeOvertime(o.get("T114")!, formatDate)).toBe(
      "4.8 h overtime on 2026-11-02, 2026-11-03, 2026-11-04"
    );
    expect(describeOvertime(o.get("T303")!, formatDate)).toBe(
      "4 h on extra working day 2026-11-27"
    );
  });

  it("marks the overtime on Gantt bars, roll-ups, cards and the team load details", () => {
    const gantt = buildGanttModel(plan, schedule, { grouping: "milestone" });
    const row = (key: string) => gantt.rows.find((r) => r.key === key)!;
    expect(row("T114")).toMatchObject({ overtime: 4.8 });
    expect(row("T114").overtimeDays!.map(formatDate)).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
    ]);
    expect(row("T114").tooltip.at(-1)).toBe("4.8 h overtime on 2026-11-02, 2026-11-03, 2026-11-04");
    expect(row("milestone:M2").overtime).toBe(6.4);
    expect(row("milestone:M2").tooltip.at(-1)).toBe("Includes 6.4 h of overtime: T105, T114");
    expect(row("milestone:M3").overtime).toBe(4.8);
    expect(row("T101").overtime).toBeUndefined();
    const kanban = buildKanbanModel(plan, schedule, {
      board: "tasks",
      swimlane: "none",
      showCancelled: false,
      cardMode: "tasks",
    });
    const cards = kanban.lanes.flatMap((l) => Object.values(l.cards).flat());
    expect(cards.find((c) => c.key === "T206")!.overtime).toBe(4.8);
    expect(cards.find((c) => c.key === "T121")!.overtime).toBeUndefined();
    const heat = buildResourcesModel(plan, schedule);
    const w45 = heat.rows.find((r) => r.id === "sam")!.cells.find((c) => c.week === "2026-W45")!;
    expect(w45.tasks.filter((t) => t.overtime).map((t) => [t.id, t.overtime])).toEqual([
      ["T114", 4.8],
      ["T206", 3.2],
    ]);
    expect(buildDashboardModel(plan, schedule).lists.overtime.map((i) => [i.id, i.detail])).toEqual(
      [
        ["T114", "4.8 h · Sam · W45"],
        ["T206", "4.8 h · Sam · W45, W46"],
        ["T105", "1.6 h · Sam · W46"],
        ["T303", "4 h · Maria · W48"],
      ]
    );
  });
});
