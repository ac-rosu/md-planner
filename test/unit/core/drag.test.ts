import { describe, expect, it } from "vitest";
import { formatDate, parseDate } from "../../../src/core/dates";
import {
  describeMoved,
  dragDay,
  movedTasks,
  moveReasons,
  remainingForFinish,
} from "../../../src/core/drag";
import { schedulePlan } from "../../../src/core/scheduler";
import { md, planFrom, task } from "../helpers";

// Mon 2026-10-05 start; Ann and Bob work 40 h a week.
const OPTIONS = { today: "2026-10-05" };
const plan = (...tasks: string[]) =>
  planFrom({
    "project.md": md("# P", "", "start: 2026-10-05", "workweek: mon-fri", "hoursPerDay: 8"),
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
    "milestones/M1.md": md("# M1", "", "id: M1", "", ...tasks),
  });
const d = (s: string) => parseDate(s)!;
const dates = (s: ReturnType<typeof schedulePlan>, id: string) => {
  const ts = s.byKey.get(id)!;
  return [formatDate(ts.start!), formatDate(ts.finish!)];
};

describe("resizing a bar in the Gantt", () => {
  // Ann spends Monday morning on an appointment, then works on T1; T2 comes after T1.
  const p = plan(
    "- [ ] Appointment @est:4h @owner:ann @start:2026-10-05 ^T0",
    "- [ ] Build @est:8h @owner:ann ^T1",
    "- [ ] Test @est:8h @owner:ann @dep:T1 ^T2"
  );
  const s = schedulePlan(p, OPTIONS);

  it("finds the work that ends the bar on the dropped day, next to the person's other work", () => {
    expect(dates(s, "T1")).toEqual(["2026-10-05", "2026-10-06"]);
    // Dropped on Friday: Monday afternoon and Tuesday to Friday are 36 h, not 5 full days.
    const r = remainingForFinish(p, OPTIONS, s, task(p, "T1"), d("2026-10-09"));
    expect(r.hours).toBe(36);
    expect(dates(r.schedule, "T1")).toEqual(["2026-10-05", "2026-10-09"]);
    // One more half hour would spill into Monday.
    const more = schedulePlan(p, { ...OPTIONS, whatIf: { task: task(p, "T1"), remaining: 36.5 } });
    expect(formatDate(more.byKey.get("T1")!.finish!)).toBe("2026-10-12");
  });

  it("ends on the last working day before a weekend drop, and shrinks too", () => {
    const sat = remainingForFinish(p, OPTIONS, s, task(p, "T1"), d("2026-10-10"));
    expect(sat.hours).toBe(36);
    const mon = remainingForFinish(p, OPTIONS, s, task(p, "T1"), d("2026-10-05"));
    expect(mon.hours).toBe(4);
    expect(dates(mon.schedule, "T1")).toEqual(["2026-10-05", "2026-10-05"]);
    // Before the bar starts: the smallest estimate.
    const early = schedulePlan(p, { ...OPTIONS, today: "2026-10-07" });
    expect(remainingForFinish(p, OPTIONS, early, task(p, "T1"), d("2026-10-01")).hours).toBe(0.5);
  });

  it("does not move the start of the bar, and says what else moves", () => {
    const r = remainingForFinish(p, OPTIONS, s, task(p, "T1"), d("2026-10-09"));
    expect(r.schedule.byKey.get("T1")!.start).toBe(s.byKey.get("T1")!.start);
    const moved = movedTasks(s, r.schedule, task(p, "T1"));
    expect(moved.map((m) => [m.task.id, m.days])).toEqual([["T2", 3]]);
    expect(describeMoved(p, s, task(p, "T1"), moved)).toBe(
      "Also moves T2 (+3 d), which waits for it."
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

describe("drag notices", () => {
  // Ann's T1 is dragged from Monday to Thursday. Bob's T4 waits for it; Ann's T2 and T3 get her
  // Monday and Tuesday; M2 waits for all of M1; Bob's low-priority T10 gets the day T4 left.
  const p = planFrom({
    "project.md": md("# P", "", "start: 2026-10-05", "workweek: mon-fri", "hoursPerDay: 8"),
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
      "",
      "- [ ] a @est:8h @owner:ann ^T1",
      "- [ ] b @est:8h @owner:ann ^T2",
      "- [ ] c @est:8h @owner:ann ^T3",
      "- [ ] d @est:8h @owner:bob @dep:T1 ^T4",
      "- [ ] e @est:8h @owner:bob ^T11",
      "- [ ] f @est:8h @owner:bob @prio:low ^T10"
    ),
    "milestones/M2.md": md(
      "# M2",
      "",
      "id: M2",
      "depends: M1",
      "",
      "- [ ] g @est:8h @owner:bob ^T5",
      "- [ ] h @est:8h @owner:bob ^T6",
      "- [ ] i @est:8h @owner:bob ^T7",
      "- [ ] j @est:8h @owner:bob ^T8"
    ),
  });
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
      "Also moves T4 (+3 d), which waits for it; Ann's other work: T2 (−1 d) and T3 (−1 d); 4 tasks of M2, which waits for M1 to finish; 1 more after those."
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
