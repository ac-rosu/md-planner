import { describe, expect, it, vi } from "vitest";
import { formatDate, parseDate } from "../../../src/core/dates";
import {
  describeMove,
  describeMoved,
  describeParentEstimates,
  describeResize,
  describeScheduleChange,
  dragDay,
  movedTasks,
  moveReasons,
  parentEstimates,
  type Resize,
  resizeTo,
  scheduleAfter,
  sharedIdReason,
} from "../../../src/core/drag";
import { PlanIndex } from "../../../src/core/index";
import { type Plan } from "../../../src/core/resolve";
import { estimateHours } from "../../../src/core/rollup";
import type * as Scheduler from "../../../src/core/scheduler";
import { type Schedule, schedulePlan, type ScheduleOptions } from "../../../src/core/scheduler";
import { applyEdits } from "../../../src/core/text";
import { changeMilestone } from "../../../src/core/writer/entities";
import { LARGE_PLAN_TODAY, largePlanFiles } from "../../fixtures/largePlan";
import { md, planFrom, task } from "../helpers";

// Every schedule is counted, so a resize stays at a few of them.
const counts = vi.hoisted(() => ({ schedules: 0 }));
vi.mock("../../../src/core/scheduler", async (original) => {
  const m = await original<typeof Scheduler>();
  return {
    ...m,
    schedulePlan: (...a: Parameters<typeof m.schedulePlan>) => {
      counts.schedules++;
      return m.schedulePlan(...a);
    },
  };
});
/** The resize, and how many schedules it took. */
function counted(resize: () => Resize): { r: Resize; runs: number } {
  const before = counts.schedules;
  const r = resize();
  return { r, runs: counts.schedules - before };
}

// Mon 2026-10-05 start; Alex and Sam work 40 h a week.
const OPTIONS = { today: "2026-10-05" };
const files = (tasks: string[], more: Record<string, string> = {}): Record<string, string> => ({
  "project.md": md("# P", "", "start: 2026-10-05", "workweek: mon-fri", "hoursPerDay: 8"),
  "team.md": md(
    "# Team",
    "",
    "## Alex",
    "",
    "capacity: 40h/week",
    "",
    "## Sam",
    "",
    "capacity: 40h/week"
  ),
  "milestones/M1.md": md("# M1", "", "id: M1", "", ...tasks),
  ...more,
});
const plan = (...tasks: string[]) => planFrom(files(tasks));
const d = (s: string) => parseDate(s)!;
const dates = (s: Schedule, id: string) => {
  const ts = s.byKey.get(id)!;
  return [formatDate(ts.start!), formatDate(ts.finish!)];
};
/** The resize, which must have found an estimate. */
function fit(r: Resize): Extract<Resize, { est: number }> {
  if ("why" in r) throw new Error(r.why);
  return r;
}
/** The notice after dropping `id` on `day`, worked out as the Gantt does. */
function moveNotice(p: Plan, options: ScheduleOptions, id: string, day: string): string {
  const s = schedulePlan(p, options);
  const t = task(p, id);
  const start = s.calendar.nextWorkingDay(d(day));
  const after = schedulePlan(p, { ...options, whatIf: { task: t, start } });
  return describeMove(p, s, after, t, d(day), start);
}

describe("resizing a bar in the Gantt", () => {
  // Alex spends Monday morning on an appointment, then works on T1; T2 comes after T1.
  const p = plan(
    "- [ ] Appointment @est:4h @owner:alex @start:2026-10-05 ^T0",
    "- [ ] Build @est:8h @owner:alex ^T1",
    "- [ ] Test @est:8h @owner:alex @dep:T1 ^T2"
  );
  const s = schedulePlan(p, OPTIONS);

  it("finds the work that ends the bar on the dropped day, next to the person's other work", () => {
    expect(dates(s, "T1")).toEqual(["2026-10-05", "2026-10-06"]);
    // Dropped on Friday: Monday afternoon and Tuesday to Friday are 36 h, not 5 full days.
    const { r, runs } = counted(() => resizeTo(p, OPTIONS, s, task(p, "T1"), d("2026-10-09")));
    expect(fit(r).est).toBe(36);
    expect(dates(fit(r).schedule, "T1")).toEqual(["2026-10-05", "2026-10-09"]);
    expect(runs).toBe(1);
    // One more half hour would spill into Monday.
    const more = schedulePlan(p, { ...OPTIONS, whatIf: { task: task(p, "T1"), remaining: 36.5 } });
    expect(formatDate(more.byKey.get("T1")!.finish!)).toBe("2026-10-12");
  });

  it("ends on the last working day before a weekend drop, and shrinks too", () => {
    const sat = fit(resizeTo(p, OPTIONS, s, task(p, "T1"), d("2026-10-10")));
    expect(sat.est).toBe(36);
    const { r: mon, runs } = counted(() => resizeTo(p, OPTIONS, s, task(p, "T1"), d("2026-10-05")));
    expect(fit(mon).est).toBe(4);
    expect(dates(fit(mon).schedule, "T1")).toEqual(["2026-10-05", "2026-10-05"]);
    expect(runs).toBe(1);
    // Dropped before the bar starts: it ends on its first day, with the hours it gets there.
    const later = { today: "2026-10-07" };
    const early = schedulePlan(p, later);
    const first = fit(resizeTo(p, later, early, task(p, "T1"), d("2026-10-01")));
    expect(first.est).toBe(4);
    expect(dates(first.schedule, "T1")).toEqual(["2026-10-07", "2026-10-07"]);
  });

  it("does not move the start of the bar, and says what else moves", () => {
    const r = fit(resizeTo(p, OPTIONS, s, task(p, "T1"), d("2026-10-09")));
    expect(r.schedule.byKey.get("T1")!.start).toBe(s.byKey.get("T1")!.start);
    const moved = movedTasks(s, r.schedule, task(p, "T1"));
    expect(moved.map((m) => [m.task.id, m.days])).toEqual([["T2", 3]]);
    expect(describeMoved(p, s, task(p, "T1"), moved)).toBe(
      "Also moves T2 (+3 d), which waits for it."
    );
    expect(describeResize(p, s, task(p, "T1"), r)).toBe(
      "T1: estimate 8h → 36h, ends Fri 2026-10-09. Also moves T2 (+3 d), which waits for it."
    );
  });

  it("tries a fixed start without editing the plan", () => {
    const t2 = task(p, "T2");
    const moved = schedulePlan(p, { ...OPTIONS, whatIf: { task: t2, start: d("2026-10-12") } });
    expect(dates(moved, "T2")).toEqual(["2026-10-12", "2026-10-12"]);
    expect(t2.start).toBeUndefined();
    expect(dates(schedulePlan(p, OPTIONS), "T2")).toEqual(["2026-10-06", "2026-10-07"]);
  });
});

/**
 * What a resize really writes: its edits applied to the text and the plan parsed again. Its
 * schedule has the same dates as the one the resize reported, for every task.
 */
function written(text: Record<string, string>, r: Extract<Resize, { est: number }>) {
  const edited = { ...text };
  for (const fe of r.edits) edited[fe.path] = applyEdits(text[fe.path], fe.edits);
  const after = planFrom(edited);
  const schedule = schedulePlan(after, OPTIONS);
  const all = (s: Schedule) =>
    [...s.byKey.values()].map((ts) => [ts.key, ts.start, ts.finish, ts.scheduledHours]);
  expect(all(schedule)).toEqual(all(r.schedule));
  return { plan: after, schedule, milestone: edited["milestones/M1.md"] };
}

describe("resizing when more work does not end later", () => {
  // Sam's T1 is what Alex's T3 waits for, and Sam's T2 is due Wednesday. With little work, T3 is
  // not urgent, so T2 goes first and T1 and T3 only in the week after; with 8 h to 24 h, T3 ends
  // on Friday (Alex's Thursday goes to T4).
  const text = files([
    "- [ ] Spec @est:8h @owner:sam ^T1",
    "- [ ] Report @est:40h @owner:sam @due:2026-10-07 ^T2",
    "- [ ] Build @est:16h @owner:alex @dep:T1 @due:2026-10-09 ^T3",
    "- [ ] Review @est:8h @owner:alex @start:2026-10-08 ^T4",
  ]);
  const p = planFrom(text);
  const s = schedulePlan(p, OPTIONS);
  const t3 = task(p, "T3");

  it("finds the largest estimate that ends on the dropped day, not the smallest", () => {
    expect(dates(s, "T3")).toEqual(["2026-10-06", "2026-10-07"]);
    const tiny = schedulePlan(p, { ...OPTIONS, whatIf: { task: t3, remaining: 0.5 } });
    expect(dates(tiny, "T3")).toEqual(["2026-10-13", "2026-10-13"]);
    // All of Thursday and Friday first (T4 takes Thursday), then what it got by Friday.
    const { r, runs } = counted(() => resizeTo(p, OPTIONS, s, t3, d("2026-10-09")));
    expect(fit(r).est).toBe(24);
    expect(runs).toBe(2);
    const w = written(text, fit(r));
    expect(dates(w.schedule, "T3")).toEqual(["2026-10-06", "2026-10-09"]);
    expect(w.milestone).toContain("- [ ] Build @est:24h @owner:alex @dep:T1 @due:2026-10-09 ^T3");
    expect(describeResize(p, s, t3, fit(r))).toBe("T3: estimate 16h → 24h, ends Fri 2026-10-09.");
    // Made shorter: the hours it has by Tuesday.
    const tue = fit(resizeTo(p, OPTIONS, s, t3, d("2026-10-06")));
    expect(tue.est).toBe(8);
    expect(dates(written(text, tue).schedule, "T3")).toEqual(["2026-10-06", "2026-10-06"]);
  });

  it("keeps the estimate and says why less work does not end it on that day", () => {
    // T2 is listed first now: with 8 h, T1 is no more urgent than T2, so T2 goes first and T3
    // would only start a week later. The notice names no start: the bar still starts on Tuesday.
    const q = planFrom(
      files([
        "- [ ] Report @est:40h @owner:sam @due:2026-10-07 ^T2",
        "- [ ] Spec @est:8h @owner:sam ^T1",
        "- [ ] Build @est:16h @owner:alex @dep:T1 @due:2026-10-09 ^T3",
      ])
    );
    const qs = schedulePlan(q, OPTIONS);
    const t3 = task(q, "T3");
    expect(dates(qs, "T3")).toEqual(["2026-10-06", "2026-10-07"]);
    expect(
      dates(schedulePlan(q, { ...OPTIONS, whatIf: { task: t3, remaining: 8 } }), "T3")
    ).toEqual(["2026-10-13", "2026-10-13"]);
    expect(resizeTo(q, OPTIONS, qs, t3, d("2026-10-06"))).toEqual({
      why: "T3 cannot end by Tue 2026-10-06 with only the work it gets by that day: then it waits longer for T1, as Sam's other work comes first.",
    });
  });

  it("names what it waits for on a weekend drop, and gives a shorter bar no more work", () => {
    // Sam's T1 is what Alex's T3 waits for. With 24 h, T1 goes before T5, and T3 runs Thursday to
    // Monday; with the 16 h it has by Friday, T5 goes first, T1 ends on Friday and T3 could only
    // start on Monday. With 24.5 h to 32 h, T1 would go first of all and T3 run Tuesday to Friday:
    // more work, which a shorter bar does not get.
    const q = planFrom(
      files([
        "- [ ] Report @est:16h @owner:sam @due:2026-10-07 ^T5",
        "- [ ] Invoice @est:16h @owner:sam @due:2026-10-06 ^T6",
        "- [ ] Spec @est:4h @owner:sam ^T1",
        "- [ ] Build @est:24h @owner:alex @dep:T1 @due:2026-10-12 ^T3",
      ])
    );
    const qs = schedulePlan(q, OPTIONS);
    const t3 = task(q, "T3");
    expect(dates(qs, "T3")).toEqual(["2026-10-08", "2026-10-12"]);
    const ends = (remaining: number) =>
      formatDate(
        schedulePlan(q, { ...OPTIONS, whatIf: { task: t3, remaining } }).byKey.get("T3")!.finish!
      );
    expect(ends(32)).toBe("2026-10-09");
    // Not the weekend: on Saturday it still waits for T1.
    const why =
      "with only the work it gets by that day: then it waits longer for T1, as Sam's other work comes first.";
    for (const day of ["Fri 2026-10-09", "Sat 2026-10-10", "Sun 2026-10-11"]) {
      const { r, runs } = counted(() => resizeTo(q, OPTIONS, qs, t3, d(day.slice(4))));
      expect(r).toEqual({ why: `T3 cannot end by ${day} ${why}` });
      expect(runs).toBeLessThanOrEqual(2);
    }
    // And it is true: no smaller estimate ends it by Friday.
    for (let remaining = 0.5; remaining < 24; remaining += 0.5)
      expect(ends(remaining) > "2026-10-09").toBe(true);
  });

  it("names the milestone it waits for when that finishes later with less work", () => {
    // Like the Tuesday drop above, with T1 in M1, which M2 waits for: with 8 h, T2 (M0) goes first.
    const q = planFrom(
      files(["- [ ] Spec @est:8h @owner:sam ^T1"], {
        "milestones/M0.md": md(
          "# M0",
          "",
          "id: M0",
          "",
          "- [ ] Report @est:40h @owner:sam @due:2026-10-07 ^T2"
        ),
        "milestones/M2.md": md(
          "# M2",
          "",
          "id: M2",
          "depends: M1",
          "",
          "- [ ] Build @est:16h @owner:alex @due:2026-10-09 ^T3"
        ),
      })
    );
    const qs = schedulePlan(q, OPTIONS);
    expect(dates(qs, "T3")).toEqual(["2026-10-06", "2026-10-07"]);
    expect(resizeTo(q, OPTIONS, qs, task(q, "T3"), d("2026-10-06"))).toEqual({
      why: "T3 cannot end by Tue 2026-10-06 with only the work it gets by that day: then M2 waits longer for M1 to finish, as Sam's other work comes first.",
    });
  });

  it("names whose other work comes first further back along what it waits for", () => {
    // Alex's T3 waits for Sam's T1, which waits for Priya's T0. With 8 h, T0 is no more urgent
    // than Priya's T2, so T1 and T3 wait a week, though Sam has no other work.
    const q = planFrom(
      files(
        [
          "- [ ] Report @est:40h @owner:priya @due:2026-10-07 ^T2",
          "- [ ] Base @est:8h @owner:priya ^T0",
          "- [ ] Spec @est:8h @owner:sam @dep:T0 ^T1",
          "- [ ] Build @est:24h @owner:alex @dep:T1 @due:2026-10-13 ^T3",
        ],
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
            "capacity: 40h/week",
            "",
            "## Priya",
            "",
            "capacity: 40h/week"
          ),
        }
      )
    );
    const qs = schedulePlan(q, OPTIONS);
    const t3 = task(q, "T3");
    expect(dates(qs, "T3")).toEqual(["2026-10-07", "2026-10-09"]);
    const less = schedulePlan(q, { ...OPTIONS, whatIf: { task: t3, remaining: 8 } });
    expect(["T0", "T1", "T3"].map((id) => dates(less, id)[0])).toEqual([
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
    ]);
    expect(resizeTo(q, OPTIONS, qs, t3, d("2026-10-07"))).toEqual({
      why: "T3 cannot end by Wed 2026-10-07 with only the work it gets by that day: then it waits longer for T1, as Priya's other work comes first.",
    });
  });

  it("names the end of the owner's hours when less work leaves the bar out of the schedule", () => {
    // With 8 h, Sam's T1 goes after T2, and Alex's hours end before T3 could start.
    const q = planFrom(
      files(
        [
          "- [ ] Report @est:40h @owner:sam @due:2026-10-08 ^T2",
          "- [ ] Spec @est:8h @owner:sam ^T1",
          "- [ ] Build @est:16h @owner:alex @dep:T1 ^T3",
        ],
        {
          "team.md": md(
            "# Team",
            "",
            "## Alex",
            "",
            "capacity: 40h/week",
            "capacityFrom: 2026-10-12 0h/week",
            "",
            "## Sam",
            "",
            "capacity: 40h/week"
          ),
        }
      )
    );
    const qs = schedulePlan(q, OPTIONS);
    expect(dates(qs, "T3")).toEqual(["2026-10-06", "2026-10-07"]);
    expect(resizeTo(q, OPTIONS, qs, task(q, "T3"), d("2026-10-06"))).toEqual({
      why: "T3 cannot end by Tue 2026-10-06 with only the work it gets by that day: then it cannot be scheduled, as Alex has no working hours from 2026-10-12 on (capacityFrom: 2026-10-12 0h/week).",
    });
  });

  it("says why a bar in progress gets no work by a weekend drop, from where it is now", () => {
    // Alex's T2 is due first, so T3, started last week, only continues on Tue 2026-10-13.
    const q = planFrom(
      files([
        "- [ ] Urgent @est:48h @owner:alex @due:2026-10-12 ^T2",
        "- [/] Build @est:20h @act:4h @owner:alex @started:2026-10-01 ^T3",
      ])
    );
    const qs = schedulePlan(q, OPTIONS);
    expect(dates(qs, "T3")).toEqual(["2026-10-01", "2026-10-14"]);
    // Not the weekend: Alex works on T2 from Monday.
    expect(resizeTo(q, OPTIONS, qs, task(q, "T3"), d("2026-10-10"))).toEqual({
      why: "T3 cannot end by Sat 2026-10-10: Alex's other work comes first, so it continues Tue 2026-10-13.",
    });
  });

  it("says what a bar with no work left waits for", () => {
    // All of T3's estimate is logged: it is done when T1 is.
    const q = planFrom(
      files([
        "- [ ] Spec @est:24h @owner:sam ^T1",
        "- [/] Build @est:2h @act:2h @owner:alex @dep:T1 @started:2026-10-01 ^T3",
      ])
    );
    const qs = schedulePlan(q, OPTIONS);
    expect(dates(qs, "T3")).toEqual(["2026-10-01", "2026-10-08"]);
    expect(resizeTo(q, OPTIONS, qs, task(q, "T3"), d("2026-10-05"))).toEqual({
      why: "T3 cannot end by Mon 2026-10-05: it waits for T1, so it ends Thu 2026-10-08.",
    });
  });

  it("says when the bar starts earlier, as what it waits for becomes more urgent", () => {
    // With 8 h, T1 is no more urgent than T2 (listed first), so T3 starts on Thursday; with more
    // work, T1 goes first and T3 can start on Tuesday.
    const earlier = files([
      "- [ ] Report @est:16h @owner:sam @due:2026-10-07 ^T2",
      "- [ ] Spec @est:8h @owner:sam ^T1",
      "- [ ] Build @est:8h @owner:alex @dep:T1 @due:2026-10-09 ^T3",
    ]);
    const q = planFrom(earlier);
    const qs = schedulePlan(q, OPTIONS);
    expect(dates(qs, "T3")).toEqual(["2026-10-08", "2026-10-08"]);
    const r = fit(resizeTo(q, OPTIONS, qs, task(q, "T3"), d("2026-10-09")));
    expect(dates(written(earlier, r).schedule, "T3")).toEqual(["2026-10-06", "2026-10-09"]);
    expect(describeResize(q, qs, task(q, "T3"), r)).toMatch(
      /^T3: estimate 8h → 32h, starts Tue 2026-10-06, ends Fri 2026-10-09\. Also moves /
    );
  });
});

describe("resizing a subtask that shares its parent's estimate", () => {
  // T1's 40 h are the budget of its subtasks: T2 and T3 have no estimate and get 20 h each.
  const text = files([
    "- [ ] Feature @est:40h @owner:alex ^T1",
    "  - [ ] Part A ^T2",
    "  - [ ] Part B ^T3",
  ]);
  const p = planFrom(text);
  const s = schedulePlan(p, OPTIONS);
  const t3 = task(p, "T3");

  it("changes the parent's estimate by as much, so the other subtask keeps its hours", () => {
    expect(dates(s, "T3")).toEqual(["2026-10-07", "2026-10-09"]);
    const { r, runs } = counted(() => resizeTo(p, OPTIONS, s, t3, d("2026-10-08")));
    const thu = fit(r);
    expect(runs).toBe(1);
    expect([thu.est, thu.parents.map((x) => [x.task.id, x.est])]).toEqual([12, [["T1", 32]]]);
    const w = written(text, thu);
    expect(w.milestone).toBe(
      md(
        "# M1",
        "",
        "id: M1",
        "",
        "- [ ] Feature @est:32h @owner:alex ^T1",
        "  - [ ] Part A ^T2",
        "  - [ ] Part B @est:12h ^T3"
      )
    );
    expect(estimateHours(task(w.plan, "T2"))).toBe(20);
    expect(dates(w.schedule, "T3")).toEqual(["2026-10-07", "2026-10-08"]);
    expect(describeResize(p, s, t3, thu)).toBe(
      "T3: estimate 20h → 12h, ends Thu 2026-10-08. T1: estimate 40h → 32h, so T2 keeps its hours."
    );
    // A week later: 60 h, and still 20 h for T2 (it used to drop to nothing).
    const next = fit(resizeTo(p, OPTIONS, s, t3, d("2026-10-16")));
    expect([next.est, next.parents.map((x) => [x.task.id, x.est])]).toEqual([60, [["T1", 80]]]);
    const w2 = written(text, next);
    expect(estimateHours(task(w2.plan, "T2"))).toBe(20);
    expect(dates(w2.schedule, "T3")).toEqual(["2026-10-07", "2026-10-16"]);
  });

  it("does the same for a subtask with its own estimate next to ones without", () => {
    // T2 gets the 30 h that T3's 10 h leave.
    const own = files([
      "- [ ] Feature @est:40h @owner:alex ^T1",
      "  - [ ] Part A ^T2",
      "  - [ ] Part B @est:10h ^T3",
    ]);
    const q = planFrom(own);
    const r = fit(resizeTo(q, OPTIONS, schedulePlan(q, OPTIONS), task(q, "T3"), d("2026-10-12")));
    expect([r.est, r.parents.map((x) => [x.task.id, x.est])]).toEqual([18, [["T1", 48]]]);
    expect(estimateHours(task(written(own, r).plan, "T2"))).toBe(30);
  });

  it("goes up to every estimated parent whose other subtasks share it", () => {
    // T0's 100 h: 40 h for T1 (shared by T2 and T3), the other 60 h for T4.
    const nested = files([
      "- [ ] Epic @est:100h @owner:alex ^T0",
      "  - [ ] Feature @est:40h ^T1",
      "    - [ ] Part A ^T2",
      "    - [ ] Part B ^T3",
      "  - [ ] Rollout @owner:sam ^T4",
    ]);
    const q = planFrom(nested);
    const qs = schedulePlan(q, OPTIONS);
    const r = fit(resizeTo(q, OPTIONS, qs, task(q, "T3"), d("2026-10-08")));
    expect(r.parents.map((x) => [x.task.id, x.est])).toEqual([
      ["T1", 32],
      ["T0", 92],
    ]);
    const w = written(nested, r);
    expect([estimateHours(task(w.plan, "T2")), estimateHours(task(w.plan, "T4"))]).toEqual([
      20, 60,
    ]);
    expect(describeResize(q, qs, task(q, "T3"), r)).toBe(
      "T3: estimate 20h → 12h, ends Thu 2026-10-08. T1: estimate 40h → 32h and T0: estimate 100h → 92h, so T2 and T4 keep their hours."
    );
  });

  it("keeps a parent's estimate the total when the subtask had the rest of it", () => {
    const rest = files([
      "- [ ] Feature @est:40h @owner:alex ^T1",
      "  - [ ] Part A @est:30h ^T2",
      "  - [ ] Part B ^T3",
    ]);
    const q = planFrom(rest);
    const qs = schedulePlan(q, OPTIONS);
    const r = fit(resizeTo(q, OPTIONS, qs, task(q, "T3"), d("2026-10-12")));
    expect([r.est, r.parents.map((x) => [x.task.id, x.est])]).toEqual([18, [["T1", 48]]]);
    expect(describeResize(q, qs, task(q, "T3"), r)).toBe(
      "T3: estimate 10h → 18h, ends Mon 2026-10-12. T1: estimate 40h → 48h, so its subtasks still add up to it."
    );
    written(rest, r);
  });

  it("leaves a parent alone when no subtask shares its estimate", () => {
    const q = planFrom(
      files([
        "- [ ] Feature @est:40h @owner:alex ^T1",
        "  - [ ] Part A @est:20h ^T2",
        "  - [ ] Part B @est:20h ^T3",
      ])
    );
    expect(parentEstimates(task(q, "T3"), 12)).toEqual([]);
  });

  it("keeps a three-way share to the hundredth of an hour, and models it exactly", () => {
    const thirds = files([
      "- [ ] Feature @est:40h @owner:alex ^T1",
      "  - [ ] Part A ^T2",
      "  - [ ] Part B ^T3",
      "  - [ ] Part C ^T4",
    ]);
    const q = planFrom(thirds);
    const r = fit(resizeTo(q, OPTIONS, schedulePlan(q, OPTIONS), task(q, "T3"), d("2026-10-09")));
    expect([r.est, r.parents.map((x) => [x.task.id, x.est])]).toEqual([26.5, [["T1", 53.17]]]);
    const w = written(thirds, r);
    expect(estimateHours(task(w.plan, "T2"))).toBeCloseTo(40 / 3, 2);
    expect(dates(w.schedule, "T3")).toEqual(["2026-10-06", "2026-10-09"]);
  });
});

describe("what a resize does not change", () => {
  // T4 is pinned to Friday for a full day; T5 to Monday, with high priority.
  const p = planFrom(
    files([
      "- [ ] Wrap-up @est:8h @owner:alex @start:2026-10-09 ^T4",
      "- [ ] Demo @est:8h @owner:alex @start:2026-10-12 @prio:high ^T5",
    ])
  );
  const s = schedulePlan(p, OPTIONS);
  const t4 = task(p, "T4");

  it("says why a longer bar cannot end any later, without a schedule when it has no hours", () => {
    const { r, runs } = counted(() => resizeTo(p, OPTIONS, s, t4, d("2026-10-10")));
    expect(r).toEqual({
      why: "T4 still ends Fri 2026-10-09: Alex has no working hours on Sat 2026-10-10.",
    });
    expect(runs).toBe(0);
    expect(resizeTo(p, OPTIONS, s, t4, d("2026-10-12"))).toEqual({
      why: "T4 still ends Fri 2026-10-09: Alex has no working hours from Sat 2026-10-10 to Sun 2026-10-11, then other work comes first.",
    });
    expect(fit(resizeTo(p, OPTIONS, s, t4, d("2026-10-13"))).est).toBe(16);
  });

  it("refuses a task at 100 %, whose estimate leaves no work", () => {
    const q = planFrom(files(["- [/] Build @est:10h @progress:100% @owner:alex ^T1"]));
    expect(resizeTo(q, OPTIONS, schedulePlan(q, OPTIONS), task(q, "T1"), d("2026-10-09"))).toEqual({
      why: "T1 is at 100% (@progress): whatever its estimate, no work is left.",
    });
  });

  it("writes the estimate that leaves that much work after logged time or progress", () => {
    const logged = files(["- [/] Build @est:10h @act:4h @owner:alex @started:2026-10-01 ^T1"]);
    const q = planFrom(logged);
    const r = fit(resizeTo(q, OPTIONS, schedulePlan(q, OPTIONS), task(q, "T1"), d("2026-10-09")));
    expect(r.est).toBe(44);
    expect(dates(written(logged, r).schedule, "T1")).toEqual(["2026-10-01", "2026-10-09"]);
    const half = files(["- [/] Build @est:10h @progress:50% @owner:alex @started:2026-10-01 ^T1"]);
    const h = planFrom(half);
    const rh = fit(resizeTo(h, OPTIONS, schedulePlan(h, OPTIONS), task(h, "T1"), d("2026-10-09")));
    expect(rh.est).toBe(80);
    expect(dates(written(half, rh).schedule, "T1")).toEqual(["2026-10-01", "2026-10-09"]);
  });
});

describe("dragging when tasks share an id", () => {
  // Copied lines: Alpha and Beta are both T1, Docs and Report both T5.
  const p = plan(
    "- [ ] Alpha @est:8h @owner:alex ^T1",
    "- [ ] Beta @est:24h @owner:sam ^T1",
    "- [ ] Spec @est:8h @owner:alex ^T2",
    "- [ ] Docs @est:8h @owner:alex ^T5",
    "- [ ] Report @est:40h @owner:sam ^T5"
  );
  const s = schedulePlan(p, OPTIONS);
  const t2 = task(p, "T2");

  it("refuses to resize a bar whose id another task has, as their hours look alike", () => {
    expect(resizeTo(p, OPTIONS, s, task(p, "T1"), d("2026-10-09"))).toEqual({
      why: "2 tasks have the id T1: give each its own id first.",
    });
    expect(sharedIdReason(p, t2)).toBeUndefined();
  });

  it("says which other tasks move by their line, not their id", () => {
    // Spec is moved to Friday, so Docs moves to Wednesday; Report stays.
    const after = schedulePlan(p, { ...OPTIONS, whatIf: { task: t2, start: d("2026-10-09") } });
    expect(movedTasks(s, after, t2).map((m) => [m.task.title, m.days])).toEqual([["Docs", -1]]);
    // Spec ends on Thursday, so Docs moves to Friday.
    const r = fit(resizeTo(p, OPTIONS, s, t2, d("2026-10-08")));
    expect(describeResize(p, s, t2, r)).toBe(
      "T2: estimate 8h → 24h, ends Thu 2026-10-08. Also moves Alex's other work: T5 (+2 d)."
    );
  });
});

describe("resizing on a 2,000-task plan", () => {
  it("takes a few schedules per drag, and the bar ends by the dropped day", () => {
    const index = new PlanIndex();
    for (const [path, text] of Object.entries(largePlanFiles())) index.update(path, text);
    const big = index.plan;
    const options = { today: LARGE_PLAN_TODAY };
    const s = schedulePlan(big, options);
    const open = [...s.tasks.values()].filter(
      (ts) => !ts.done && !ts.unscheduled && ts.start !== undefined && ts.finish !== undefined
    );
    let drags = 0;
    let total = 0;
    for (const ts of open.filter((_, i) => i % 150 === 7)) {
      for (const day of [ts.finish! + 9, Math.max(ts.start!, ts.finish! - 1)]) {
        const { r, runs } = counted(() => resizeTo(big, options, s, ts.task, day));
        drags++;
        total += runs;
        expect(runs).toBeLessThanOrEqual(4);
        if (!("why" in r)) expect(r.schedule.byKey.get(ts.key)!.finish!).toBeLessThanOrEqual(day);
      }
    }
    // About one schedule per drag (the search used to take ten).
    expect(total / drags).toBeLessThan(1.5);
  });
});

describe("drag notices", () => {
  // Alex's T1 is dragged from Monday to Thursday. Sam's T4 waits for it; Alex's T2 and T3 get
  // their Monday and Tuesday; M2 waits for all of M1; Sam's low-priority T10 gets the day T4 left.
  const p = planFrom(
    files(
      [
        "- [ ] a @est:8h @owner:alex ^T1",
        "- [ ] b @est:8h @owner:alex ^T2",
        "- [ ] c @est:8h @owner:alex ^T3",
        "- [ ] d @est:8h @owner:sam @dep:T1 ^T4",
        "- [ ] e @est:8h @owner:sam ^T11",
        "- [ ] f @est:8h @owner:sam @prio:low ^T10",
      ],
      {
        "milestones/M2.md": md(
          "# M2",
          "",
          "id: M2",
          "depends: M1",
          "",
          "- [ ] g @est:8h @owner:sam ^T5",
          "- [ ] h @est:8h @owner:sam ^T6",
          "- [ ] i @est:8h @owner:sam ^T7",
          "- [ ] j @est:8h @owner:sam ^T8"
        ),
      }
    )
  );
  const s = schedulePlan(p, OPTIONS);
  const t1 = task(p, "T1");
  const after = schedulePlan(p, { ...OPTIONS, whatIf: { task: t1, start: d("2026-10-08") } });
  const moved = movedTasks(s, after, t1);

  it("says why each other task moves: waits for it, same person, milestone, knock-on", () => {
    const reasons = moveReasons(s, t1, moved);
    expect(Object.fromEntries([...reasons].map(([t, r]) => [t.id, r]))).toEqual({
      T4: "waits",
      T2: "person",
      T3: "person",
      T5: "milestone",
      T6: "milestone",
      T7: "milestone",
      T8: "milestone",
      T10: "knock-on",
    });
    expect(describeMoved(p, s, t1, moved)).toBe(
      "Also moves T4 (+3 d), which waits for it; Alex's other work: T2 (−1 d) and T3 (−1 d); 4 tasks of M2, which waits for M1 to finish; 1 more after those."
    );
  });

  it("lists a few names and counts the rest", () => {
    const few = moved.filter((m) => m.task.milestoneId === "M2").slice(0, 2);
    expect(describeMoved(p, s, t1, few)).toBe(
      `Also moves ${few.map((m) => `${m.task.id} (+${m.days} d)`).join(" and ")} of M2, which waits for M1 to finish.`
    );
    expect(describeMoved(p, s, t1, [])).toBe("");
    expect(dragDay(d("2026-10-09"))).toBe("Fri 2026-10-09");
  });
});

describe("why a moved bar starts later than where it was dropped", () => {
  // Alex is off Wednesday to Friday of the second week; Priya has no hours from 2026-10-12 on.
  const p = planFrom(
    files(
      [
        "- [ ] Spec @est:16h @owner:sam ^T1",
        "- [ ] Build @est:8h @owner:alex @dep:T1 ^T2",
        "- [ ] Review @est:8h @owner:alex @start:2026-10-12 @prio:high ^T3",
        "- [ ] Docs @est:8h @owner:alex ^T4",
        "- [ ] Package @start:2026-10-20 ^T5",
        "  - [ ] Bundle @est:4h @owner:sam ^T6",
        "- [ ] Translate @est:8h @owner:priya ^T8",
      ],
      {
        "team.md": md(
          "# Team",
          "",
          "## Alex",
          "",
          "capacity: 40h/week",
          "off: 2026-10-14..2026-10-16",
          "",
          "## Sam",
          "",
          "capacity: 40h/week",
          "",
          "## Priya",
          "",
          "capacity: 40h/week",
          "capacityFrom: 2026-10-12 0h/week"
        ),
        "milestones/M2.md": md(
          "# M2",
          "",
          "id: M2",
          "depends: M1",
          "",
          "- [ ] Launch @est:8h @owner:sam ^T7"
        ),
      }
    )
  );
  const s = schedulePlan(p, OPTIONS);
  const notice = (id: string, day: string) => moveNotice(p, OPTIONS, id, day);

  it("names what it waits for: a task, a milestone or a parent's fixed start", () => {
    expect(notice("T2", "2026-10-05")).toBe(
      "T2: fixed start none → 2026-10-05. It waits for T1, so it starts Wed 2026-10-07. Ends Wed 2026-10-07."
    );
    expect(notice("T7", "2026-10-05")).toBe(
      "T7: fixed start none → 2026-10-05. M2 waits for M1 to finish, so it starts Wed 2026-10-21. Ends Wed 2026-10-21."
    );
    expect(notice("T6", "2026-10-05")).toBe(
      "T6: fixed start none → 2026-10-05. Its parent T5 has the fixed start 2026-10-20, so it starts Tue 2026-10-20. Ends Tue 2026-10-20."
    );
  });

  it("names the owner's time off, other work, or missing hours", () => {
    expect(notice("T4", "2026-10-14")).toBe(
      "T4: fixed start none → 2026-10-14. Alex has no working hours from Wed 2026-10-14 to Sun 2026-10-18, so it starts Mon 2026-10-19. Ends Mon 2026-10-19."
    );
    expect(notice("T4", "2026-10-12")).toBe(
      "T4: fixed start none → 2026-10-12. Alex's other work comes first, so it starts Tue 2026-10-13. Ends Tue 2026-10-13."
    );
    expect(notice("T8", "2026-10-13")).toMatch(
      /^T8: fixed start none → 2026-10-13\. It cannot be scheduled: Priya has no working hours from 2026-10-12 on \(capacityFrom: 2026-10-12 0h\/week\)\./
    );
  });

  it("names today or the project start when the bar is dropped before it", () => {
    // Alex has nothing else to do.
    const solo = files(["- [ ] Spec @est:8h @owner:alex ^T1"]);
    expect(moveNotice(planFrom(solo), { today: "2026-10-14" }, "T1", "2026-10-12")).toBe(
      "T1: fixed start none → 2026-10-12. Nothing is scheduled before today, so it starts Wed 2026-10-14. Ends Wed 2026-10-14."
    );
    // Today is a Sunday: the weekend goes without saying.
    expect(moveNotice(planFrom(solo), { today: "2026-10-11" }, "T1", "2026-10-07")).toBe(
      "T1: fixed start none → 2026-10-07. Nothing is scheduled before today, so it starts Mon 2026-10-12. Ends Mon 2026-10-12."
    );
    const project = md("# P", "", "start: 2026-11-02", "workweek: mon-fri", "hoursPerDay: 8");
    expect(
      moveNotice(planFrom({ ...solo, "project.md": project }), OPTIONS, "T1", "2026-10-26")
    ).toBe(
      "T1: fixed start none → 2026-10-26. Nothing is scheduled before the project start, so it starts Mon 2026-11-02. Ends Mon 2026-11-02."
    );
  });

  it("names what holds it back after what it waits for, but not the weekend", () => {
    // Sam's T1 takes the whole first week; on Monday, Alex's pinned high-priority T3 goes first.
    const q = planFrom(
      files([
        "- [ ] Spec @est:40h @owner:sam ^T1",
        "- [ ] Build @est:8h @owner:alex @dep:T1 ^T2",
        "- [ ] Deploy @est:8h @owner:sam @dep:T1 ^T4",
        "- [ ] Review @est:8h @owner:alex @start:2026-10-12 @prio:high ^T3",
      ])
    );
    expect(moveNotice(q, OPTIONS, "T2", "2026-10-05")).toBe(
      "T2: fixed start none → 2026-10-05. It waits for T1, then Alex's other work comes first, so it starts Tue 2026-10-13. Ends Tue 2026-10-13."
    );
    // T4 waits for T1 too, which takes Sam's Friday: that is not other work coming first.
    expect(moveNotice(q, OPTIONS, "T4", "2026-10-05")).toBe(
      "T4: fixed start none → 2026-10-05. It waits for T1, so it starts Mon 2026-10-12. Ends Mon 2026-10-12."
    );
  });

  it("says when the bar already has that fixed start, as there is nothing to write", () => {
    expect(describeMove(p, s, s, task(p, "T3"), d("2026-10-11"), d("2026-10-12"))).toBe(
      "T3 already has the fixed start 2026-10-12 (Sun 2026-10-11 is not a working day)."
    );
  });
});

describe("moving a bar in progress", () => {
  // Alex started T1 on Tue 2026-10-20 and logged 24 of its 40 h; today is Thu 2026-10-29, so the
  // remaining 16 h fill Thursday and Friday. Alex is off on Monday 2026-11-02.
  const today = { today: "2026-10-29" };
  const p = planFrom(
    files(
      [
        "- [/] Build @est:40h @act:24h @owner:alex @started:2026-10-20 ^T1",
        "- [ ] Test @est:8h @owner:alex @dep:T1 ^T2",
      ],
      {
        "team.md": md("# Team", "", "## Alex", "", "capacity: 40h/week", "off: 2026-11-02"),
      }
    )
  );

  it("moves the remaining work, not the bar from @started, and says so", () => {
    const s = schedulePlan(p, today);
    expect(dates(s, "T1")).toEqual(["2026-10-20", "2026-10-30"]);
    // One working day later than where the rest of the work starts (Thursday): Friday.
    expect(moveNotice(p, today, "T1", "2026-10-30")).toBe(
      "T1: fixed start none → 2026-10-30. It is now pinned: the rest of its work starts no earlier than that, even when its dependencies finish sooner (right-click → Remove fixed start). Ends Tue 2026-11-03. Also moves T2 (+1 d), which waits for it."
    );
    // Dropped on Saturday: Monday is a day off, so the rest goes on on Tuesday.
    expect(moveNotice(p, today, "T1", "2026-10-31")).toBe(
      "T1: fixed start none → 2026-11-02. Alex has no working hours on Mon 2026-11-02, so it continues Tue 2026-11-03. Ends Wed 2026-11-04. Also moves T2 (+2 d), which waits for it."
    );
  });
});

describe("parents in an estimate notice", () => {
  const p = planFrom(
    files([
      "- [ ] Feature @est:40h @owner:alex ^T1",
      "  - [ ] Part A ^T2",
      "  - [ ] Part B ^T3",
      "  - [ ] Part C ^T4",
    ])
  );

  it("names the parent whose estimate changes, and the subtasks that keep their hours", () => {
    const t2 = task(p, "T2");
    expect(describeParentEstimates(t2, parentEstimates(t2, 16))).toBe(
      "T1: estimate 40h → 42.67h, so T3 and T4 keep their hours."
    );
    expect(describeParentEstimates(t2, [])).toBe("");
  });
});

describe("what a milestone edit does to the schedule", () => {
  // Alex's spec is what Sam's build waits for; with a target, M2's work goes first.
  const p = planFrom(
    files(["- [ ] docs @est:8h @owner:alex ^T1", "- [ ] api @est:8h @owner:alex ^T2"], {
      "milestones/M2.md": md(
        "# M2",
        "",
        "id: M2",
        "",
        "- [ ] spec @est:16h @owner:alex ^T3",
        "- [ ] build @est:16h @owner:sam @dep:T3 ^T4"
      ),
    })
  );
  const options = { today: "2026-10-05" };
  const before = schedulePlan(p, options);
  const withTarget = (id: string, target: string) => {
    const m = p.milestoneById(id)!;
    const f = p.file(m.file)!;
    return scheduleAfter(p, options, [
      { path: f.path, edits: changeMilestone(f.lines, m, { target }) },
    ]);
  };

  it("says which milestones and tasks move", () => {
    expect(describeScheduleChange(before, withTarget("M2", "2026-10-09"))).toBe(
      "M1 now ends Thu 2026-10-08 (was Tue 2026-10-06). M2 now ends Thu 2026-10-08 (was Mon 2026-10-12). Moves T1 (+2 d), T2 (+2 d), T3 (−2 d) and 1 more."
    );
  });

  it("says when a milestone becomes late", () => {
    expect(describeScheduleChange(before, withTarget("M1", "2026-10-05"))).toBe("M1 is now late.");
  });

  it("is empty when nothing moves, although the new target line moves the tasks' lines", () => {
    expect(describeScheduleChange(before, withTarget("M1", "2026-12-18"))).toBe("");
  });
});
