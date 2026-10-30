// Projects entered after the fact: done work with only the hours logged, done tasks without
// @started, work typed in as under way, and a mistyped year in a status date.
import { describe, expect, it } from "vitest";
import { parseDate, weekStart } from "../../../src/core/dates";
import { weekLoadAt } from "../../../src/core/load";
import { attentionLists, burnUp, projectProgress } from "../../../src/core/metrics";
import { milestoneStats } from "../../../src/core/queries";
import { progressOf } from "../../../src/core/rollup";
import { schedulePlan } from "../../../src/core/scheduler";
import { validatePlan } from "../../../src/core/validate";
import { buildDashboardModel } from "../../../src/core/views/dashboard";
import { md, planFrom } from "../helpers";

const PROJECT = md("# P", "", "start: 2026-06-01", "end: 2026-12-31");
const TEAM = md("# Team", "", "## Bob", "", "capacity: 40h/week");
const TODAY = "2026-10-14";
const d = (iso: string) => parseDate(iso)!;

function plan(...tasks: string[]) {
  return planFrom({
    "project.md": PROJECT,
    "team.md": TEAM,
    "milestones/M1.md": md("# M1", "", ...tasks),
  });
}

describe("done work with only the hours logged", () => {
  // 8 done tasks: 2 estimated, 6 with only @act (180h), and 40h still to do.
  const p = plan(
    "- [x] Survey @est:8h @act:10h @owner:bob @started:2026-06-01 @done:2026-06-02 ^T1",
    "- [x] Design @est:8h @act:8h @owner:bob @started:2026-06-03 @done:2026-06-03 ^T2",
    ...[20, 40, 30, 30, 40, 20].map(
      (h, i) =>
        `- [x] Part ${i + 1} @act:${h}h @owner:bob @started:2026-07-0${i + 1} @done:2026-07-0${i + 1} ^T${i + 3}`
    ),
    "- [ ] Rest @est:40h @owner:bob ^T9"
  );
  const s = schedulePlan(p, { today: TODAY });
  const expected = (8 + 8 + 180) / (8 + 8 + 180 + 40);

  it("counts their logged hours in progress, as the budget does", () => {
    expect(milestoneStats(p.milestones[0]).progress).toBeCloseTo(expected, 10);
    expect(projectProgress(p)).toBeCloseTo(expected, 10);
    expect(s.milestones.get("M1")!.progress).toBeCloseTo(expected, 10);
    expect(buildDashboardModel(p, s).progress).toBeCloseTo(expected, 10);
  });

  it("counts them in the burn-up's scope and done line", () => {
    const b = burnUp(p, s);
    expect(b.scope).toBe(236);
    const thisWeek = b.points.find((x) => x.week === weekStart(d(TODAY)))!;
    expect(thisWeek.done).toBe(196);
    expect(b.points.at(-1)!.forecast).toBe(236);
  });

  it("keeps an estimate over the hours logged, and a parent's weighting by its subtasks", () => {
    const q = plan(
      "- [/] Feature @owner:bob ^T1",
      "  - [x] Backend @act:30h ^T2",
      "  - [ ] Frontend @est:10h ^T3",
      "- [x] Estimated @est:8h @act:12h @owner:bob @done:2026-07-01 ^T4"
    );
    expect(progressOf(q.taskById("T1")!)).toBeCloseTo(30 / 40, 10);
    expect(burnUp(q, schedulePlan(q, { today: TODAY })).scope).toBe(48);
  });
});

describe("a done task without @started", () => {
  it("spreads its hours back from @done over the owner's working days", () => {
    const p = plan("- [x] Interface @act:6d @owner:bob @done:2026-07-03 ^T3");
    const s = schedulePlan(p, { today: TODAY });
    const t3 = p.taskById("T3")!;
    expect(
      s.allocations.filter((a) => a.task === t3).map((a) => [a.day - d("2026-06-26"), a.hours])
    ).toEqual([
      [0, 8], // Friday 26 June
      [3, 8],
      [4, 8],
      [5, 8],
      [6, 8],
      [7, 8], // Friday 3 July
    ]);
    expect(weekLoadAt(s, "bob", d("2026-07-03")).hours).toBe(40);
    expect(weekLoadAt(s, "bob", d("2026-06-26")).hours).toBe(8);
    // Its place on the timeline is still the day it was done.
    expect(s.tasks.get(t3)).toMatchObject({ start: d("2026-07-03"), finish: d("2026-07-03") });
  });

  it("keeps a task that fits in its day, and one with @started, as they were", () => {
    const p = plan(
      "- [x] Small @act:5h @owner:bob @done:2026-07-03 ^T1",
      "- [x] Week @act:20h @owner:bob @started:2026-07-06 @done:2026-07-10 ^T2"
    );
    const s = schedulePlan(p, { today: TODAY });
    const of = (id: string) =>
      s.allocations.filter((a) => a.task === p.taskById(id)).map((a) => a.hours);
    expect(of("T1")).toEqual([5]);
    expect(of("T2")).toEqual([4, 4, 4, 4, 4]);
  });
});

describe("work typed in as under way", () => {
  it("is not listed as starting this week, with or without @started", () => {
    const p = plan(
      "- [/] Typed as in progress @est:1d @owner:bob ^T1",
      "- [?] Typed as in review @est:1d @owner:bob ^T2",
      "- [ ] Next up @est:1d @owner:bob ^T3"
    );
    const s = schedulePlan(p, { today: TODAY });
    expect(attentionLists(p, s).startingThisWeek.map((t) => t.id)).toEqual(["T3"]);
  });
});

describe("a mistyped year in a status date", () => {
  const typo = plan(
    "- [x] Setup @est:2d @act:4h @owner:bob @started:1026-07-01 @done:2026-07-03 ^T1",
    "  - [x] Server @owner:bob @done:2026-07-03 ^T2",
    "- [x] Licence @est:1d @owner:bob @started:2026-06-01 @done:1026-06-02 ^T3",
    "- [ ] Rollout @est:2d @owner:bob ^T4"
  );
  const s = schedulePlan(typo, { today: TODAY });
  /** The weeks of the chart of a plan without the typos: the project period. */
  const weeks = (() => {
    const p = plan("- [x] Licence @est:1d @owner:bob @done:2026-06-02 ^T3", "- [ ] Rollout ^T4");
    return burnUp(p, schedulePlan(p, { today: TODAY })).points.map((x) => x.week);
  })();

  it("starts the burn-up at the project start: earlier dates count there", () => {
    const b = burnUp(typo, s);
    expect(b.points[0].week).toBe(weekStart(d("2026-06-01")));
    expect(b.points.map((x) => x.week)).toEqual(weeks);
    // The 4h logged on T1 and the 8h of T3 are done from the first week on.
    expect(b.points[0].done).toBe(12);
    expect(buildDashboardModel(typo, s).burnUp.milestones.M1.points).toHaveLength(weeks.length);
  });

  it("warns, with the year that fits", () => {
    const far = validatePlan(typo).filter((i) => i.code === "date-outside-project");
    expect(far.map((i) => [i.range.start.line, i.severity, i.message, i.data])).toEqual([
      [
        2,
        "warning",
        "@started 1026-07-01 is more than a year before the project start 2026-06-01. Is the year right?",
        { key: "started", suggestion: "2026-07-01" },
      ],
      [
        4,
        "warning",
        "@done 1026-06-02 is more than a year before the project start 2026-06-01. Is the year right?",
        { key: "done", suggestion: "2026-06-02" },
      ],
    ]);
  });

  it("does not let a @done far in the future stretch the chart either", () => {
    const p = plan(
      "- [x] Licence @est:1d @owner:bob @started:2026-06-01 @done:3026-06-02 ^T1",
      "- [ ] Rollout @est:2d @owner:bob ^T2"
    );
    const b = burnUp(p, schedulePlan(p, { today: TODAY }));
    expect(b.points.map((x) => x.week)).toEqual(weeks);
    // Marked done: counted today.
    expect(b.points.find((x) => x.week === weekStart(d(TODAY)))!.done).toBe(8);
    const far = validatePlan(p).find((i) => i.code === "date-outside-project")!;
    expect(far.message).toBe(
      "@done 3026-06-02 is more than a year after the project end 2026-12-31. Is the year right?"
    );
    expect(far.data).toEqual({ key: "done", suggestion: "2026-06-02" });
  });

  it("looks back ten years at most without a project start", () => {
    const p = planFrom({
      "project.md": md("# P"),
      "team.md": TEAM,
      "milestones/M1.md": md(
        "# M1",
        "",
        "- [x] Old @est:1d @owner:bob @done:1026-06-02 ^T1",
        "- [ ] Rollout @est:2d @owner:bob ^T2"
      ),
    });
    const b = burnUp(p, schedulePlan(p, { today: TODAY }));
    expect(b.points.length).toBeLessThan(530);
    expect(b.points[0].done).toBe(8);
  });

  it("leaves dates within a year of the project period alone", () => {
    const p = plan(
      "- [x] Early @est:1d @owner:bob @started:2025-07-01 @done:2025-07-02 ^T1",
      "- [ ] Rollout @est:2d @owner:bob ^T2"
    );
    expect(validatePlan(p).filter((i) => i.code === "date-outside-project")).toEqual([]);
  });
});

describe("a done task without @done", () => {
  it("says where the burn-up counts it", () => {
    const p = plan("- [x] Setup @est:1d @owner:bob ^T1");
    expect(validatePlan(p).find((i) => i.code === "missing-done")?.message).toBe(
      "Done without @done: the task has no place on the timeline, and the burn-up counts it as done from the project start 2026-06-01. Add the date it was finished."
    );
    const b = burnUp(p, schedulePlan(p, { today: TODAY }));
    expect(b.points[0]).toMatchObject({ week: weekStart(d("2026-06-01")), done: 8 });
  });
});
