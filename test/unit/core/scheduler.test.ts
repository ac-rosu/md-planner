import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatDate, parseDate } from "../../../src/core/dates";
import { weekLoadAt } from "../../../src/core/load";
import { scheduleDiagnostics } from "../../../src/core/scheduleDiagnostics";
import { scheduleJsonText } from "../../../src/core/scheduleJson";
import { schedulePlan, type ScheduleOptions } from "../../../src/core/scheduler";
import { buildDashboardModel } from "../../../src/core/views/dashboard";
import { FIXTURES, loadSample, md, planFrom, timeLimit, TODAY } from "../helpers";

// Mon 2026-10-05 start; Wed 2026-10-14 is a holiday.
const PROJECT = md(
  "# P",
  "",
  "start: 2026-10-05",
  "workweek: mon-fri",
  "hoursPerDay: 8",
  "holidays: 2026-10-14"
);
const TEAM = md(
  "# Team",
  "",
  "## Ann",
  "",
  "capacity: 40h/week",
  "",
  "## Bob",
  "",
  "capacity: 20h/week # part-time",
  "",
  "## Cy",
  "",
  "capacity: 40h/week",
  "off: 2026-10-07..2026-10-08"
);

function run(
  tasks: string[],
  options: Partial<ScheduleOptions> = {},
  extra: Record<string, string> = {}
) {
  const plan = planFrom({
    "project.md": PROJECT,
    "team.md": TEAM,
    "milestones/M1.md": md("# M1", "", "id: M1", "", ...tasks),
    ...extra,
  });
  const s = schedulePlan(plan, { today: "2026-10-05", ...options });
  const get = (id: string) => {
    const ts = s.byKey.get(id);
    if (!ts) throw new Error(`no schedule for ${id}`);
    return ts;
  };
  const dates = (id: string) => {
    const ts = get(id);
    return [
      ts.start === undefined ? undefined : formatDate(ts.start),
      ts.finish === undefined ? undefined : formatDate(ts.finish),
    ];
  };
  return { plan, s, get, dates };
}

describe("scheduler basics", () => {
  it("chains finish-to-start; same person may continue the same day", () => {
    const a = run(["- [ ] a @est:8h @owner:ann ^T1", "- [ ] b @est:8h @owner:ann @dep:T1 ^T2"]);
    expect(a.dates("T1")).toEqual(["2026-10-05", "2026-10-05"]);
    expect(a.dates("T2")).toEqual(["2026-10-06", "2026-10-06"]);
    const b = run(["- [ ] a @est:4h @owner:ann ^T1", "- [ ] b @est:4h @owner:ann @dep:T1 ^T2"]);
    expect(b.dates("T2")).toEqual(["2026-10-05", "2026-10-05"]);
    // Another person waits until the next working day.
    const c = run(["- [ ] a @est:4h @owner:ann ^T1", "- [ ] b @est:4h @owner:cy @dep:T1 ^T2"]);
    expect(c.dates("T2")).toEqual(["2026-10-06", "2026-10-06"]);
  });

  it("skips holidays and weekends", () => {
    const { dates } = run(["- [ ] a @est:24h @owner:ann @start:2026-10-12 ^T1"]);
    expect(dates("T1")).toEqual(["2026-10-12", "2026-10-15"]);
  });

  it("respects time off", () => {
    const { dates, s } = run(["- [ ] a @est:24h @owner:cy ^T1"]);
    expect(dates("T1")).toEqual(["2026-10-05", "2026-10-09"]);
    expect(s.load.get("cy")?.get(parseDate("2026-10-07")!)).toBeUndefined();
  });

  it("uses part-time capacity", () => {
    const { dates, s } = run(["- [ ] a @est:12h @owner:bob ^T1"]);
    expect(dates("T1")).toEqual(["2026-10-05", "2026-10-07"]);
    expect(s.load.get("bob")?.get(parseDate("2026-10-05")!)).toBe(4);
  });

  it("applies lag in working days (hours round up to days)", () => {
    const days = run([
      "- [ ] a @est:8h @owner:ann ^T1",
      "- [ ] b @est:4h @owner:bob @dep:T1+2d ^T2",
    ]);
    expect(days.dates("T2")).toEqual(["2026-10-08", "2026-10-08"]);
    const hours = run([
      "- [ ] a @est:8h @owner:ann ^T1",
      "- [ ] b @est:4h @owner:bob @dep:T1+4h ^T2",
    ]);
    expect(hours.dates("T2")).toEqual(["2026-10-07", "2026-10-07"]);
    // Lag over a weekend and a holiday.
    const wk = run([
      "- [ ] a @est:8h @owner:ann @start:2026-10-09 ^T1",
      "- [ ] b @est:4h @owner:ann @dep:T1+2d ^T2",
    ]);
    expect(wk.dates("T2")).toEqual(["2026-10-15", "2026-10-15"]);
  });

  it("honours fixed starts and schedules them first", () => {
    const { dates } = run([
      "- [ ] urgent @est:8h @owner:ann @prio:high ^T1",
      "- [ ] fixed @est:8h @owner:ann @start:2026-10-05 ^T2",
      "- [ ] later @est:8h @owner:ann @start:2026-10-07 ^T3",
    ]);
    expect(dates("T2")).toEqual(["2026-10-05", "2026-10-05"]);
    expect(dates("T1")).toEqual(["2026-10-06", "2026-10-06"]);
    expect(dates("T3")).toEqual(["2026-10-07", "2026-10-07"]);
  });

  it("orders by priority, then the latest possible finish, then file order", () => {
    const p = run([
      "- [ ] low @est:8h @owner:ann @prio:low ^T1",
      "- [ ] high @est:8h @owner:ann @prio:high ^T2",
      "- [ ] med @est:8h @owner:ann ^T3",
    ]);
    expect([p.dates("T2")[0], p.dates("T3")[0], p.dates("T1")[0]]).toEqual([
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
    ]);
    const slack = run([
      "- [ ] relaxed @est:8h @owner:ann @due:2026-12-01 ^T1",
      "- [ ] tight @est:8h @owner:ann @due:2026-10-06 ^T2",
      "- [ ] none @est:8h @owner:ann ^T3",
    ]);
    expect([slack.dates("T2")[0], slack.dates("T1")[0], slack.dates("T3")[0]]).toEqual([
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
    ]);
  });

  it("does the work that others wait for first", () => {
    // The review has no deadline of its own, but Ann's build waits for it and is due on Monday.
    const { dates, get } = run([
      "- [ ] long job @est:24h @owner:bob @due:2026-10-16 ^T1",
      "- [ ] review @est:4h @owner:bob ^T2",
      "- [ ] build @est:40h @owner:ann @dep:T2 @due:2026-10-12 ^T3",
    ]);
    expect(dates("T2")).toEqual(["2026-10-05", "2026-10-05"]);
    expect(dates("T3")).toEqual(["2026-10-06", "2026-10-12"]);
    expect(get("T3").late).toBe(false);
    expect(dates("T1")).toEqual(["2026-10-06", "2026-10-13"]);
  });

  it("does first the work that a later milestone waits for", () => {
    // M3 depends on M2 and its build is due on Friday: Sam does M2 before the other work.
    const { dates, get } = run(
      ["- [ ] other work @est:20h @owner:sam ^T1"],
      {},
      {
        "team.md": md(
          "# Team",
          "",
          "## Alex",
          "",
          "capacity: 40h/week",
          "",
          "## Sam",
          "",
          "capacity: 20h/week"
        ),
        "milestones/M2.md": md(
          "# M2",
          "",
          "id: M2",
          "",
          "- [ ] spec @est:8h @owner:sam ^T2",
          "- [ ] review @est:4h @owner:sam ^T3"
        ),
        "milestones/M3.md": md(
          "# M3",
          "",
          "id: M3",
          "depends: M2",
          "",
          "- [ ] build @est:16h @owner:alex @due:2026-10-09 ^T4"
        ),
      }
    );
    expect(dates("T2")).toEqual(["2026-10-05", "2026-10-06"]);
    expect(dates("T3")).toEqual(["2026-10-07", "2026-10-07"]);
    expect(dates("T4")).toEqual(["2026-10-08", "2026-10-09"]);
    expect(get("T4").late).toBe(false);
    expect(dates("T1")[0]).toBe("2026-10-08");
    // The slack runs through the milestone dependency too.
    expect([get("T2").slack, get("T3").slack, get("T4").slack]).toEqual([1, 0, 0]);
  });

  it("does first what a leaving person needs before their last day", () => {
    const team = md(
      "# Team",
      "",
      "## Ann",
      "",
      "capacity: 40h/week",
      "",
      "## Bob",
      "",
      "capacity: 40h/week",
      "capacityFrom: 2026-10-10 0h/week"
    );
    const { dates, get } = run(
      [
        "- [ ] other work @est:16h @owner:ann @due:2026-10-09 ^T1",
        "- [ ] spec @est:8h @owner:ann ^T2",
        "- [ ] implement @est:24h @owner:bob @dep:T2 ^T3",
      ],
      {},
      { "team.md": team }
    );
    expect(dates("T2")).toEqual(["2026-10-05", "2026-10-05"]);
    expect(dates("T3")).toEqual(["2026-10-06", "2026-10-08"]);
    expect(get("T3").unscheduled).toBeUndefined();
    expect(dates("T1")).toEqual(["2026-10-06", "2026-10-07"]);
  });

  it("does the work that others wait for first also without any deadline", () => {
    // Ann's API is what Cy waits for; the docs above it in the file wait for nobody.
    const { dates } = run([
      "- [ ] docs @est:8h @owner:ann ^T1",
      "- [ ] api @est:8h @owner:ann ^T2",
      "- [ ] ui @est:16h @owner:cy @dep:T2 ^T3",
    ]);
    expect(dates("T2")).toEqual(["2026-10-05", "2026-10-05"]);
    expect(dates("T1")).toEqual(["2026-10-06", "2026-10-06"]);
    expect(dates("T3")).toEqual(["2026-10-06", "2026-10-09"]);
  });

  it("keeps the milestone order for work without deadlines", () => {
    // More work waits behind M2's first task, but M1 comes first.
    const { dates } = run(
      ["- [ ] m1 head @est:8h @owner:ann ^T1", "- [ ] m1 next @est:8h @owner:bob @dep:T1 ^T2"],
      {},
      {
        "milestones/M2.md": md(
          "# M2",
          "",
          "id: M2",
          "",
          "- [ ] m2 head @est:8h @owner:ann ^T3",
          "- [ ] m2 a @est:16h @owner:bob @dep:T3 ^T4",
          "- [ ] m2 b @est:16h @owner:bob @dep:T4 ^T5"
        ),
      }
    );
    expect(dates("T1")).toEqual(["2026-10-05", "2026-10-05"]);
    expect(dates("T3")).toEqual(["2026-10-06", "2026-10-06"]);
  });

  it("does not reshuffle the work when the first milestone gets a target", () => {
    const m1 = (...target: string[]) =>
      md(
        "# M1",
        "",
        "id: M1",
        ...target,
        "",
        "- [ ] docs @est:8h @owner:ann ^T1",
        "- [ ] api @est:8h @owner:ann ^T2",
        "- [ ] ui @est:16h @owner:cy @dep:T2 ^T3"
      );
    const m2 = md(
      "# M2",
      "",
      "id: M2",
      "",
      "- [ ] spec @est:8h @owner:ann ^T4",
      "- [ ] build @est:16h @owner:cy @dep:T4 ^T5"
    );
    const without = run([], {}, { "milestones/M1.md": m1(), "milestones/M2.md": m2 });
    const withTarget = run(
      [],
      {},
      { "milestones/M1.md": m1("target: 2026-11-30"), "milestones/M2.md": m2 }
    );
    for (const id of ["T1", "T2", "T3", "T4", "T5"])
      expect(withTarget.dates(id), id).toEqual(without.dates(id));
  });

  it("does first, among equal deadlines, the work a milestone without one waits for", () => {
    const { dates } = run(
      [],
      {},
      {
        "milestones/M1.md": md(
          "# M1",
          "",
          "id: M1",
          "target: 2026-10-30",
          "",
          "- [ ] a @est:8h @owner:ann ^T1",
          "- [ ] b @est:8h @owner:ann ^T2"
        ),
        "milestones/M2.md": md("# M2", "", "id: M2", "", "- [ ] c @est:16h @owner:cy @dep:T2 ^T3"),
      }
    );
    expect(dates("T2")).toEqual(["2026-10-05", "2026-10-05"]);
    expect(dates("T1")).toEqual(["2026-10-06", "2026-10-06"]);
  });

  it("does not move a task ahead of the person's other work because it got longer", () => {
    // Same deadline: file order decides, whatever the estimates (making a bar longer in the Gantt
    // must not move its start).
    const short = run([
      "- [ ] first @est:8h @owner:ann @due:2026-10-30 ^T1",
      "- [ ] second @est:8h @owner:ann @due:2026-10-30 ^T2",
    ]);
    const long = run([
      "- [ ] first @est:8h @owner:ann @due:2026-10-30 ^T1",
      "- [ ] second @est:40h @owner:ann @due:2026-10-30 ^T2",
    ]);
    expect(short.dates("T2")[0]).toBe("2026-10-06");
    expect(long.dates("T2")[0]).toBe("2026-10-06");
    expect(long.dates("T1")).toEqual(["2026-10-05", "2026-10-05"]);
  });

  it("keeps a started task going instead of switching between equal tasks", () => {
    const { dates } = run([
      "- [ ] first @est:16h @owner:ann @due:2026-10-16 ^T1",
      "- [ ] second @est:16h @owner:ann @due:2026-10-16 ^T2",
    ]);
    expect(dates("T1")).toEqual(["2026-10-05", "2026-10-06"]);
    expect(dates("T2")).toEqual(["2026-10-07", "2026-10-08"]);
  });

  it("leaves cycles (and their dependents) unscheduled", () => {
    const { get, dates } = run([
      "- [ ] a @est:8h @owner:ann @dep:T2 ^T1",
      "- [ ] b @est:8h @owner:ann @dep:T1 ^T2",
      "- [ ] c @est:8h @owner:ann @dep:T1 ^T3",
      "- [ ] d @est:8h @owner:ann ^T4",
    ]);
    expect(get("T1").unscheduled).toBe("cycle");
    expect(get("T2").unscheduled).toBe("cycle");
    expect(get("T3").unscheduled).toBe("blocked-by-cycle");
    expect(dates("T4")).toEqual(["2026-10-05", "2026-10-05"]);
  });

  it("blocks work that waits on a cycle through a milestone dependency, transitively", () => {
    const { get, dates } = run(
      ["- [ ] a @est:8h @owner:ann @dep:T2 ^T1", "- [ ] b @est:8h @owner:ann @dep:T1 ^T2"],
      {},
      {
        "milestones/M2.md": md(
          "# M2",
          "",
          "id: M2",
          "depends: M1",
          "",
          "- [ ] c @est:8h @owner:bob ^T3",
          "- [ ] d @est:8h @owner:bob @dep:T3 ^T4"
        ),
        "milestones/M3.md": md(
          "# M3",
          "",
          "id: M3",
          "",
          "- [ ] e @est:8h @owner:cy @dep:T4 ^T5",
          "- [ ] f @est:8h @owner:cy ^T6"
        ),
      }
    );
    for (const id of ["T3", "T4", "T5"]) expect(get(id).unscheduled, id).toBe("blocked-by-cycle");
    expect(dates("T6")).toEqual(["2026-10-05", "2026-10-05"]);
  });

  it("handles very deep dependency chains", () => {
    const tasks = Array.from(
      { length: 5000 },
      (_, i) => `- [ ] s${i} @est:1h @owner:ann${i ? ` @dep:T${i}` : ""} ^T${i + 1}`
    );
    const { get } = run(tasks);
    expect(get("T5000").finish).toBeDefined();
    expect(get("T5000").unscheduled).toBeUndefined();
  });

  it("handles very deep chains of tasks without estimates", () => {
    // Each one finishes the day it is ready and at once releases the next one.
    const tasks = Array.from(
      { length: 10000 },
      (_, i) => `- [ ] s${i}${i ? ` @dep:T${i}` : ""} ^T${i + 1}`
    );
    const { dates } = run(tasks);
    expect(dates("T10000")).toEqual(["2026-10-05", "2026-10-05"]);
  });

  it("spreads a task larger than one week over weeks", () => {
    const { dates, s } = run(["- [ ] big @est:60h @owner:ann ^T1"]);
    expect(dates("T1")).toEqual(["2026-10-05", "2026-10-15"]);
    expect(s.allocations.filter((a) => a.key === "T1").map((a) => a.hours)).toEqual([
      8, 8, 8, 8, 8, 8, 8, 4,
    ]);
    expect(weekLoadAt(s, "ann", parseDate("2026-10-12")!)).toMatchObject({
      week: "2026-W42",
      hours: 20,
      capacity: 32,
    });
  });

  it("runs unassigned tasks in a shared pool with configurable capacity", () => {
    const tasks = ["- [ ] a @est:8h ^T1", "- [ ] b @est:8h ^T2"];
    const shared = run(tasks);
    expect(shared.dates("T1")).toEqual(["2026-10-05", "2026-10-05"]);
    expect(shared.dates("T2")).toEqual(["2026-10-06", "2026-10-06"]);
    expect(shared.get("T1")).toMatchObject({ resource: "unassigned", unassigned: true });
    const big = run(tasks, { unassignedCapacity: 80 });
    expect(big.dates("T2")).toEqual(["2026-10-05", "2026-10-05"]);
    // Unknown owners also go to the pool and are flagged.
    const unknown = run(["- [ ] a @est:8h @owner:zed ^T1"]);
    expect(unknown.get("T1")).toMatchObject({
      resource: "unassigned",
      unknownOwner: true,
      unassigned: false,
    });
  });

  it("fixes done tasks in the past and continues from today", () => {
    const { get, dates, s } = run([
      "- [x] done @est:16h @act:20h @owner:ann @started:2026-09-28 @done:2026-10-01 ^T1",
      "- [ ] next @est:8h @owner:ann @dep:T1 ^T2",
      "- [x] undated @est:8h @owner:ann ^T3",
      "- [ ] after undated @est:8h @owner:bob @dep:T3 ^T4",
    ]);
    expect(get("T1").done).toBe(true);
    expect(dates("T1")).toEqual(["2026-09-28", "2026-10-01"]);
    expect(s.allocations.filter((a) => a.key === "T1").map((a) => a.hours)).toEqual([5, 5, 5, 5]);
    expect(dates("T2")).toEqual(["2026-10-05", "2026-10-05"]);
    expect(dates("T4")).toEqual(["2026-10-05", "2026-10-06"]);
  });

  it("schedules only the remaining work of tasks in progress and keeps their real start", () => {
    const { get, dates } = run([
      "- [/] wip @est:16h @act:8h @owner:ann @started:2026-10-01 ^T1",
      "- [/] pct @est:10h @progress:50% @owner:bob ^T2",
    ]);
    expect(dates("T1")).toEqual(["2026-10-01", "2026-10-05"]);
    expect(get("T1").scheduledHours).toBe(8);
    expect(get("T2").scheduledHours).toBe(5);
  });

  it("starts at today when today is after the project start, and on a working day", () => {
    const later = run(["- [ ] a @est:8h @owner:ann ^T1"], { today: "2026-10-07" });
    expect(later.dates("T1")).toEqual(["2026-10-07", "2026-10-07"]);
    const weekend = run(["- [ ] a @est:8h @owner:ann ^T1"], { today: "2026-10-10" });
    expect(weekend.dates("T1")).toEqual(["2026-10-12", "2026-10-12"]);
  });

  it("expands dependencies on parents and milestones to all leaves", () => {
    const parent = run([
      "- [ ] parent @owner:ann ^P1",
      "  - [ ] a @est:8h ^T1",
      "  - [ ] b @est:8h ^T2",
      "- [ ] c @est:4h @owner:bob @dep:P1 ^T3",
    ]);
    expect(parent.dates("T3")).toEqual(["2026-10-07", "2026-10-07"]);
    expect(parent.s.parents.get(parent.plan.taskById("P1")!)).toMatchObject({
      start: parseDate("2026-10-05"),
      finish: parseDate("2026-10-06"),
      hours: 16,
    });
    const ms = run(
      ["- [ ] a @est:8h @owner:ann ^T1"],
      {},
      {
        "milestones/M2.md": md(
          "# M2",
          "",
          "id: M2",
          "depends: M1",
          "",
          "- [ ] b @est:4h @owner:bob ^T2"
        ),
      }
    );
    expect(ms.dates("T2")).toEqual(["2026-10-06", "2026-10-06"]);
  });

  it("finishes zero-hour (unestimated) tasks on their ready day and flags them", () => {
    const { get, dates } = run([
      "- [ ] a @est:8h @owner:ann ^T1",
      "- [ ] review @owner:ann @dep:T1 ^T2",
    ]);
    expect(dates("T2")).toEqual(["2026-10-05", "2026-10-05"]);
    expect(get("T2").unestimated).toBe(true);
  });

  it("ignores cancelled tasks and cancelled milestones", () => {
    const { s, plan } = run(
      ["- [-] gone @est:80h @owner:ann ^T1", "- [ ] b @est:8h @owner:ann @dep:T1 ^T2"],
      {},
      {
        "milestones/M2.md": md(
          "# M2",
          "",
          "id: M2",
          "status: cancelled",
          "",
          "- [ ] x @est:8h @owner:ann ^T3"
        ),
      }
    );
    expect(s.byKey.has("T1")).toBe(false);
    expect(s.byKey.has("T3")).toBe(false);
    expect(formatDate(s.byKey.get("T2")!.start!)).toBe("2026-10-05");
    expect(s.milestones.get("M2")?.late).toBe(false);
    expect(plan.tasks).toHaveLength(3);
  });

  it("reports tasks that never get capacity", () => {
    const { get, plan, s } = run(
      ["- [ ] a @est:8h @owner:zero ^T1"],
      { horizonDays: 30 },
      {
        "team.md": md("# Team", "", "## Zero", "", "capacity: 0h/week"),
      }
    );
    expect(get("T1").unscheduled).toBe("horizon");
    const issues = scheduleDiagnostics(plan, s);
    expect(issues.map((i) => i.code)).toEqual(["unschedulable", "incomplete-forecast"]);
    // The milestone does not look on time: its forecast would leave the task out.
    expect(issues[1].message).toBe("M1 cannot finish: 1 task cannot be scheduled (T1).");
  });

  it("demand mode ignores capacity and shows overload", () => {
    const tasks = ["- [ ] a @est:16h @owner:ann ^T1", "- [ ] b @est:16h @owner:ann ^T2"];
    const cap = run(tasks);
    expect(cap.dates("T2")).toEqual(["2026-10-07", "2026-10-08"]);
    const dem = run(tasks, { mode: "demand" });
    expect(dem.dates("T1")).toEqual(["2026-10-05", "2026-10-06"]);
    expect(dem.dates("T2")).toEqual(["2026-10-05", "2026-10-06"]);
    expect(dem.s.load.get("ann")?.get(parseDate("2026-10-05")!)).toBe(16);
  });

  it("is deterministic", () => {
    const tasks = Array.from(
      { length: 30 },
      (_, i) =>
        `- [ ] t${i} @est:${(i % 5) + 1}h @owner:${["ann", "bob", "cy"][i % 3]}${i > 2 ? ` @dep:T${i - 3}` : ""} ^T${i}`
    );
    const a = run(tasks);
    const b = run(tasks);
    expect(scheduleJsonText(a.plan, a.s)).toBe(scheduleJsonText(b.plan, b.s));
  });
});

describe("critical path, slack and milestones", () => {
  it("computes slack against deadlines and the latest milestone target", () => {
    const chain = run(
      ["- [ ] a @est:8h @owner:ann ^T1", "- [ ] b @est:8h @owner:ann @dep:T1 ^T2"],
      {},
      {
        "milestones/M1.md": md(
          "# M1",
          "",
          "id: M1",
          "target: 2026-10-09",
          "",
          "- [ ] a @est:8h @owner:ann ^T1",
          "- [ ] b @est:8h @owner:ann @dep:T1 ^T2"
        ),
      }
    );
    expect(chain.get("T2").slack).toBe(3);
    expect(chain.get("T1").slack).toBe(3);
    expect(chain.s.criticalPath.map((t) => t.id)).toEqual(["T1", "T2"]);

    const withTight = run(
      [],
      {},
      {
        "milestones/M1.md": md(
          "# M1",
          "",
          "id: M1",
          "target: 2026-10-09",
          "",
          "- [ ] a @est:8h @owner:ann ^T1",
          "- [ ] b @est:8h @owner:ann @dep:T1 ^T2",
          "- [ ] c @est:4h @owner:bob @due:2026-10-05 ^T3"
        ),
      }
    );
    expect(withTight.get("T3").slack).toBe(0);
    expect(withTight.s.criticalPath.map((t) => t.id)).toEqual(["T3"]);
  });

  it("gives negative slack, late flags and variance when a target is missed", () => {
    const late = run(
      [],
      {},
      {
        "milestones/M1.md": md(
          "# M1",
          "",
          "id: M1",
          "target: 2026-10-05",
          "",
          "- [ ] a @est:16h @owner:ann ^T1"
        ),
      }
    );
    expect(late.get("T1").late).toBe(true);
    expect(late.get("T1").slack).toBe(-1);
    expect(late.s.milestones.get("M1")).toMatchObject({
      late: true,
      variance: 1,
      forecast: parseDate("2026-10-06"),
    });
    const diags = scheduleDiagnostics(late.plan, late.s);
    expect(diags.map((d) => [d.code, d.message])).toEqual([
      [
        "late-task",
        "Scheduled to finish 2026-10-06, after the M1 target 2026-10-05 (1 working day late).",
      ],
    ]);
  });

  it("counts a finish after a deadline on a weekend or holiday as late by working days", () => {
    // M1 and the project end on Saturday 10 October.
    const weekend = (hours: number) =>
      run(
        [],
        {},
        {
          "project.md": PROJECT + "end: 2026-10-10\n",
          "milestones/M1.md": md(
            "# M1",
            "",
            "id: M1",
            "target: 2026-10-10",
            "",
            `- [ ] a @est:${hours}h @owner:ann ^T1`
          ),
        }
      );
    // Done on Monday 12: one working day late, not none.
    const late = weekend(48);
    expect(late.get("T1")).toMatchObject({
      late: true,
      slack: -1,
      finish: parseDate("2026-10-12"),
    });
    expect(late.s.milestones.get("M1")).toMatchObject({ late: true, variance: 1 });
    expect(buildDashboardModel(late.plan, late.s)).toMatchObject({
      forecastFinish: "2026-10-12",
      endVariance: 1,
      milestones: [{ id: "M1", late: true, variance: 1 }],
    });
    expect(scheduleDiagnostics(late.plan, late.s).map((d) => d.message)).toEqual([
      "Scheduled to finish 2026-10-12, after the M1 target 2026-10-10 (1 working day late).",
    ]);
    // Done on Friday 9, the last working day before: on time, not a day ahead.
    const onTime = weekend(40);
    expect(onTime.s.milestones.get("M1")).toMatchObject({ late: false, variance: 0 });
    expect(buildDashboardModel(onTime.plan, onTime.s).endVariance).toBe(0);
    // Due on the Wednesday holiday and done on Thursday 15: one working day late.
    const holiday = run(["- [ ] a @est:64h @owner:ann @due:2026-10-14 ^T1"]);
    expect(holiday.dates("T1")).toEqual(["2026-10-05", "2026-10-15"]);
    expect(scheduleDiagnostics(holiday.plan, holiday.s).map((d) => d.message)).toEqual([
      "Scheduled to finish 2026-10-15, after @due 2026-10-14 (1 working day late).",
    ]);
    // Due on Friday 9 and done on Saturday 10, an extra working day: the finish day counts.
    const extra = run(
      ["- [ ] a @est:48h @owner:ann @due:2026-10-09 ^T1"],
      {},
      { "team.md": md("# Team", "", "## Ann", "", "capacity: 40h/week", "workday: 2026-10-10") }
    );
    expect(extra.dates("T1")).toEqual(["2026-10-05", "2026-10-10"]);
    expect(scheduleDiagnostics(extra.plan, extra.s).map((d) => d.message)).toEqual([
      "Scheduled to finish 2026-10-10, after @due 2026-10-09 (1 working day late).",
    ]);
  });

  it("rolls up sections and milestones", () => {
    const { s, plan } = run(
      [],
      {},
      {
        "milestones/M1.md": md(
          "# M1",
          "",
          "id: M1",
          "",
          "## A",
          "",
          "- [x] done @est:8h @owner:ann @started:2026-10-01 @done:2026-10-01 ^T1",
          "- [ ] open @est:8h @owner:ann ^T2"
        ),
      }
    );
    const section = plan.milestones[0].sections[0];
    expect(s.sections.get(section)).toMatchObject({
      start: parseDate("2026-10-01"),
      finish: parseDate("2026-10-05"),
      hours: 16,
      progress: 0.5,
    });
    expect(s.milestones.get("M1")).toMatchObject({
      forecast: parseDate("2026-10-05"),
      progress: 0.5,
    });
  });
});

describe("sample project", () => {
  it("matches the golden schedule", () => {
    const plan = loadSample().plan;
    const text = scheduleJsonText(plan, schedulePlan(plan, { today: TODAY }));
    const golden = join(FIXTURES, "golden/portal-schedule.json");
    if (process.env.UPDATE_GOLDEN || !existsSync(golden)) writeFileSync(golden, text);
    expect(text).toBe(readFileSync(golden, "utf8"));
  });

  it("schedules every open task with sensible dates", () => {
    const plan = loadSample().plan;
    const s = schedulePlan(plan, { today: TODAY });
    for (const ts of s.tasks.values()) {
      expect(ts.unscheduled, ts.key).toBeUndefined();
      expect(ts.finish, ts.key).toBeDefined();
      if (!ts.done)
        expect(ts.start! >= parseDate(TODAY)! || ts.task.started !== undefined, ts.key).toBe(true);
    }
    // Fixed start respected; dependencies respected.
    expect(formatDate(s.byKey.get("T105")!.start!)).toBe("2026-11-10");
    for (const ts of s.tasks.values()) {
      for (const d of ts.task.deps) {
        const pred = s.byKey.get(d.id);
        if (pred && ts.start !== undefined && pred.finish !== undefined && !ts.done) {
          expect(ts.start >= pred.finish, `${ts.key} after ${d.id}`).toBe(true);
        }
      }
    }
  });
});

describe("performance", () => {
  it("schedules 2,000 tasks in under 200 ms", () => {
    const people = ["ann", "bob", "cy"];
    const files: Record<string, string> = { "project.md": PROJECT, "team.md": TEAM };
    let n = 0;
    for (let m = 1; m <= 20; m++) {
      const lines = [`# M${m}`, "", `id: M${m}`, `target: 2027-0${(m % 9) + 1}-15`, ""];
      for (let s = 0; s < 5; s++) {
        lines.push(`## Section ${s}`, "");
        for (let i = 0; i < 20; i++) {
          n++;
          const dep = n > 5 && i % 3 === 0 ? ` @dep:T${n - 5}` : "";
          const prio = i % 7 === 0 ? " @prio:high" : "";
          lines.push(
            `- [ ] Task ${n} @est:${(n % 12) + 2}h @owner:${people[n % 3]}${dep}${prio} #t${n % 4} ^T${n}`
          );
        }
        lines.push("");
      }
      files[`milestones/M${m}.md`] = lines.join("\n");
    }
    const plan = planFrom(files);
    expect(plan.tasks).toHaveLength(2000);
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const s = schedulePlan(plan, { today: "2026-10-05" });
      times.push(performance.now() - t0);
      expect([...s.tasks.values()].every((ts) => ts.finish !== undefined)).toBe(true);
    }
    const best = Math.min(...times);
    console.log(`schedule of 2,000 tasks: best of 3 = ${best.toFixed(1)} ms`);
    expect(best).toBeLessThan(timeLimit(200));
  });
});
