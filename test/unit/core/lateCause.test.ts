import { describe, expect, it } from "vitest";
import { impliedDeps } from "../../../src/core/consistency";
import { formatDate } from "../../../src/core/dates";
import { describeLateCause, lateCause, unscheduledCause } from "../../../src/core/lateCause";
import { scheduleDiagnostics, workloadDiagnostics } from "../../../src/core/scheduleDiagnostics";
import { newErrors, planErrors } from "../../../src/core/newErrors";
import { type Schedule, schedulePlan } from "../../../src/core/scheduler";
import { validatePlan } from "../../../src/core/validate";
import { buildGanttModel } from "../../../src/core/views/gantt";
import { md, planFrom, timeLimit } from "../helpers";

const PROJECT = md("# P", "", "start: 2026-10-01", "end: 2027-06-30");
const TEAM = md(
  "# Team",
  "",
  "## Sam",
  "",
  "capacity: 40h/week",
  "",
  "## Alex",
  "",
  "capacity: 40h/week"
);

function plan(m1: string, m2?: string) {
  return planFrom({
    "project.md": PROJECT,
    "team.md": TEAM,
    "milestones/M1.md": m1,
    ...(m2 ? { "milestones/M2.md": m2 } : {}),
  });
}

/** The causes of every late task of a schedule. */
function lateCauses(s: Schedule) {
  for (const ts of s.tasks.values()) if (ts.late) lateCause(s, ts.task);
}

/**
 * The best of three wall-clock times in ms of `explain`, each on a new schedule (causes are worked
 * out once per schedule): one slow run on a busy machine does not fail the test.
 */
function fastest(schedule: () => Schedule, explain: (s: Schedule) => unknown): number {
  let best = Infinity;
  for (let run = 0; run < 3; run++) {
    const s = schedule();
    const t0 = performance.now();
    explain(s);
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

describe("why a task is late", () => {
  it("follows the chain through milestone dependencies to a wrong fixed start", () => {
    const p = plan(
      md(
        "# M1",
        "",
        "target: 2026-11-30",
        "",
        "- [ ] Plan @est:1d @owner:sam @start:2027-04-19 ^T1",
        "- [ ] Design @est:2d @owner:sam @dep:T1 ^T2"
      ),
      md("# M2", "", "target: 2026-12-18", "depends: M1", "", "- [ ] Build @est:3d @owner:alex ^T3")
    );
    const s = schedulePlan(p, { today: "2026-10-14" });
    const t3 = p.taskById("T3")!;
    expect(s.tasks.get(t3)!.late).toBe(true);
    const cause = lateCause(s, t3)!;
    expect(cause).toMatchObject({ kind: "start", task: p.taskById("T1"), via: ["M1"] });
    expect(describeLateCause(p, t3, cause)).toBe(
      "Held back by the fixed start 2027-04-19 of T1 (via M1)."
    );
    expect(describeLateCause(p, p.taskById("T1")!, lateCause(s, p.taskById("T1")!)!)).toBe(
      "Held back by its own fixed start 2027-04-19."
    );
  });

  it("names an owner who has other work first", () => {
    const p = plan(
      md(
        "# M1",
        "",
        "target: 2026-10-16",
        "",
        "- [ ] Urgent @est:3d @owner:sam @prio:high ^T1",
        "- [ ] Also needed @est:1d @owner:sam ^T2"
      )
    );
    const s = schedulePlan(p, { today: "2026-10-14" });
    const t2 = p.taskById("T2")!;
    const cause = lateCause(s, t2)!;
    expect(cause).toMatchObject({ kind: "busy", task: t2, resource: "sam", via: [] });
    expect(describeLateCause(p, t2, cause)).toBe("Held back by Sam having other work first.");
    // A task that can start right away has no cause.
    expect(lateCause(s, p.taskById("T1")!)).toBeUndefined();
  });

  it("names the owner's other work, not a fixed start that held the task back one day", () => {
    const p = plan(
      md(
        "# M1",
        "",
        "- [ ] Migration @est:3w @owner:sam @start:2026-10-14 @prio:high ^T1",
        "- [ ] Small fix @est:1d @owner:sam @start:2026-10-15 @due:2026-10-20 ^T2"
      )
    );
    const s = schedulePlan(p, { today: "2026-10-14" });
    const t2 = p.taskById("T2")!;
    // The fixed start kept it one day; the migration kept Sam busy for three weeks.
    expect(lateCause(s, t2)).toMatchObject({ kind: "busy", task: t2, resource: "sam" });
    const late = scheduleDiagnostics(p, s).find((i) => i.code === "late-task")!;
    expect(late.message).toBe(
      "Scheduled to finish 2026-11-04, after @due 2026-10-20 (11 working days late). Held back by Sam having other work first."
    );
    const row = buildGanttModel(p, s, { grouping: "milestone" }).rows.find((r) => r.key === "T2")!;
    expect(row.tooltip).toContain("Held back by Sam having other work first.");
    // So the workload note counts it.
    expect(workloadDiagnostics(p, s).map((i) => i.data)).toEqual([{ person: "sam" }]);
  });

  it("counts working days, not weekends, when it weighs a fixed start against other work", () => {
    // Today is a Friday: the fixed start on Monday costs one working day, Sam's other work two.
    const p = plan(
      md(
        "# M1",
        "",
        "- [ ] Prepare @est:2d @owner:sam @start:2026-10-19 @prio:high ^T1",
        "- [ ] Fix @est:1d @owner:sam @start:2026-10-19 @due:2026-10-19 ^T2"
      )
    );
    const s = schedulePlan(p, { today: "2026-10-16" });
    const t2 = p.taskById("T2")!;
    expect(describeLateCause(p, t2, lateCause(s, t2)!)).toBe(
      "Held back by Sam having other work first."
    );
  });

  it("names the other work along the chain when a fixed start before it barely mattered", () => {
    const p = plan(
      md(
        "# M1",
        "",
        "- [ ] Kick-off @est:1d @owner:alex @start:2026-10-15 ^T1",
        "- [ ] Migration @est:3w @owner:sam @prio:high ^T2",
        "- [ ] Review @est:1d @owner:sam @dep:T1 ^T3",
        "- [ ] Release @est:1d @owner:alex @dep:T3 @due:2026-10-23 ^T4"
      )
    );
    const s = schedulePlan(p, { today: "2026-10-14" });
    const t4 = p.taskById("T4")!;
    const cause = lateCause(s, t4)!;
    expect(cause).toMatchObject({ kind: "busy", task: p.taskById("T3"), resource: "sam" });
    expect(describeLateCause(p, t4, cause)).toBe("Held back by Sam having other work before T3.");
    // With the kick-off weeks later, the fixed start is what holds everything up.
    const later = plan(
      md(
        "# M1",
        "",
        "- [ ] Kick-off @est:1d @owner:alex @start:2026-11-30 ^T1",
        "- [ ] Migration @est:3w @owner:sam @prio:high ^T2",
        "- [ ] Review @est:1d @owner:sam @dep:T1 ^T3",
        "- [ ] Release @est:1d @owner:alex @dep:T3 @due:2026-10-23 ^T4"
      )
    );
    const s2 = schedulePlan(later, { today: "2026-10-14" });
    const t4b = later.taskById("T4")!;
    expect(describeLateCause(later, t4b, lateCause(s2, t4b)!)).toBe(
      "Held back by the fixed start 2026-11-30 of T1 (via T3)."
    );
  });

  it("follows the chain past a fixed start that held its task back no working day", () => {
    // The preparation waits for Sam's big job until Friday 2026-11-06: the kick-off would start on
    // Monday without its fixed start too.
    for (const owner of ["alex", "priya"]) {
      const p = planFrom({
        "project.md": PROJECT,
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
        "milestones/M1.md": md(
          "# M1",
          "",
          "- [ ] Big job @est:136h @owner:sam @prio:high ^T1",
          "- [ ] Prepare @est:1d @owner:sam ^T2",
          "- [ ] Kick-off @est:1d @owner:alex @dep:T2 @start:2026-11-09 ^T3",
          `- [ ] Release @est:1d @owner:${owner} @dep:T3 @due:2026-10-23 ^T4`
        ),
      });
      const s = schedulePlan(p, { today: "2026-10-14" });
      const t4 = p.taskById("T4")!;
      expect(describeLateCause(p, t4, lateCause(s, t4)!), owner).toBe(
        "Held back by Sam having other work before T2 (via T3)."
      );
      // Alex has no other work, so there is no workload note on Alex.
      expect(workloadDiagnostics(p, s), owner).toEqual([]);
    }
  });

  it("does not count the day the owner finishes a predecessor as other work", () => {
    // Alex prepares on Wednesday and Thursday and releases on Friday: nothing else came first.
    const p = plan(
      md(
        "# M1",
        "",
        "- [ ] Prepare @est:2d @owner:alex ^T1",
        "- [ ] Release @est:1d @owner:alex @dep:T1 @due:2026-10-15 ^T2"
      )
    );
    const s = schedulePlan(p, { today: "2026-10-14" });
    const t2 = p.taskById("T2")!;
    expect(s.tasks.get(t2)!.late).toBe(true);
    expect(lateCause(s, t2)).toBeUndefined();
    expect(workloadDiagnostics(p, s)).toEqual([]);
    // Other work in the hours the preparation leaves that day does count.
    const q = plan(
      md(
        "# M1",
        "",
        "- [ ] Prepare @est:12h @owner:alex @prio:high ^T1",
        "- [ ] Release @est:1d @owner:alex @dep:T1 @due:2026-10-15 ^T2",
        "- [ ] Urgent @est:4h @owner:alex @prio:high ^T3"
      )
    );
    const s2 = schedulePlan(q, { today: "2026-10-14" });
    const t2b = q.taskById("T2")!;
    expect(describeLateCause(q, t2b, lateCause(s2, t2b)!)).toBe(
      "Held back by Alex having other work first."
    );
  });

  it("counts the hours of a task it waits for once, however often it is named", () => {
    // The preparation leaves 4h on Wednesday and the other task takes them: other work first.
    for (const notes of [
      [
        "- [ ] Release @dep:T1 ^T4",
        "  - [ ] Notes @est:1d @owner:alex @dep:T1 @due:2026-10-14 ^T2",
      ],
      ["- [ ] Notes @est:1d @owner:alex @dep:T1,T1 @due:2026-10-14 ^T2"],
    ]) {
      const p = plan(
        md(
          "# M1",
          "",
          "- [ ] Prepare @est:4h @owner:alex @prio:high ^T1",
          "- [ ] Other @est:4h @owner:alex @prio:high ^T3",
          ...notes
        )
      );
      expect(validatePlan(p)).toEqual([]);
      const s = schedulePlan(p, { today: "2026-10-14" });
      const t2 = p.taskById("T2")!;
      expect(describeLateCause(p, t2, lateCause(s, t2)!), notes[0]).toBe(
        "Held back by Alex having other work first."
      );
      expect(workloadDiagnostics(p, s).map((i) => i.data)).toEqual([{ person: "alex" }]);
    }
  });

  it("counts every task it waits for that takes the owner's hours that day, not only the last", () => {
    // Alex prepares and checks on Wednesday, so the notes start on Thursday: nothing else came
    // first. The same with a sign-off without hours after the preparation.
    const check = plan(
      md(
        "# M1",
        "",
        "- [ ] Prepare @est:4h @owner:alex ^T1",
        "- [ ] Check @est:4h @owner:alex @dep:T1 ^T5",
        "- [ ] Notes @est:1d @owner:alex @dep:T5 @due:2026-10-14 ^T2"
      )
    );
    const signOff = plan(
      md(
        "# M1",
        "",
        "- [ ] Prepare @est:1d @owner:alex ^T1",
        "- [ ] Sign-off @owner:alex @dep:T1 ^T5",
        "- [ ] Notes @est:1d @owner:alex @dep:T5 @due:2026-10-14 ^T2"
      )
    );
    for (const p of [check, signOff]) {
      const s = schedulePlan(p, { today: "2026-10-14" });
      const t2 = p.taskById("T2")!;
      expect(s.tasks.get(t2)!.late).toBe(true);
      expect(lateCause(s, t2)).toBeUndefined();
      expect(workloadDiagnostics(p, s)).toEqual([]);
    }
  });

  it("never makes a task without hours wait for its owner, but weighs its fixed start", () => {
    // Alex works on the Friday holiday; the sign-off needs no hours and is done on the next
    // working day of the project: nothing else came first.
    const holiday = planFrom({
      "project.md": md("# P", "", "start: 2026-10-01", "holidays: 2026-10-16"),
      "team.md": md("# Team", "", "## Alex", "", "capacity: 40h/week", "workday: 2026-10-16"),
      "milestones/M1.md": md(
        "# M1",
        "",
        "- [ ] Prepare @est:4h @owner:alex ^T1",
        "- [ ] Sign-off @owner:alex @dep:T1 ^T2",
        "- [ ] Release @est:4h @owner:alex @dep:T2 @due:2026-10-16 ^T3"
      ),
    });
    const s = schedulePlan(holiday, { today: "2026-10-16" });
    const t3 = holiday.taskById("T3")!;
    expect(s.tasks.get(t3)!.late).toBe(true);
    expect(lateCause(s, t3)).toBeUndefined();
    // A fixed start the day after the preparation took all of Alex's day still holds it back.
    const pinned = plan(
      md(
        "# M1",
        "",
        "- [ ] Prepare @est:1d @owner:alex ^T1",
        "- [ ] Sign-off @owner:alex @dep:T1 @start:2026-10-15 ^T2",
        "- [ ] Release @est:1d @owner:sam @dep:T2 @due:2026-10-15 ^T3"
      )
    );
    const s2 = schedulePlan(pinned, { today: "2026-10-14" });
    const t3b = pinned.taskById("T3")!;
    expect(describeLateCause(pinned, t3b, lateCause(s2, t3b)!)).toBe(
      "Held back by the fixed start 2026-10-15 of T2."
    );
  });

  it("names the owner's other work, not a fixed start that only moved the task into it", () => {
    // Sam has the big job until 2026-11-10 either way: without the kick-off's fixed start the
    // review is just as late, so the cause is Sam's other work, with a note on Sam's workload.
    for (const start of [" @start:2026-10-30", ""]) {
      const p = plan(
        md(
          "# M1",
          "",
          "- [ ] Big job @est:4w @owner:sam @prio:high ^T3",
          `- [ ] Kick-off @est:1d @owner:alex${start} ^T1`,
          "- [ ] Review @est:1d @owner:sam @dep:T1 @due:2026-10-30 ^T2"
        )
      );
      const s = schedulePlan(p, { today: "2026-10-14" });
      const t2 = p.taskById("T2")!;
      expect(formatDate(s.tasks.get(t2)!.finish!), start).toBe("2026-11-11");
      expect(describeLateCause(p, t2, lateCause(s, t2)!), start).toBe(
        "Held back by Sam having other work first."
      );
      expect(workloadDiagnostics(p, s).map((i) => i.data)).toEqual([{ person: "sam" }]);
    }
  });

  it("weighs a part-timer's fixed start in working days of the project, like any wait", () => {
    // Maria works on Mondays (and Tuesdays): her fixed start a week later costs the release 5
    // working days, the urgent work only 3. Without the fixed start the release is on time,
    // without the urgent work it is still late.
    for (const maria of [
      ["capacity: 16h/week", "workweek: mon-tue"],
      ["capacity: 8h/week", "workweek: mon"],
    ]) {
      const p = planFrom({
        "project.md": PROJECT,
        "team.md": TEAM + md("", "## Maria", "", ...maria),
        "milestones/M1.md": md(
          "# M1",
          "",
          "- [ ] Prepare @est:8h @owner:maria @start:2026-10-26 ^T1",
          "- [ ] Urgent @est:24h @owner:alex @prio:high @start:2026-10-27 ^T5",
          "- [ ] Release @est:1d @owner:alex @dep:T1 @due:2026-10-23 ^T3"
        ),
      });
      const s = schedulePlan(p, { today: "2026-10-14" });
      const t3 = p.taskById("T3")!;
      expect(formatDate(s.tasks.get(t3)!.finish!), maria[1]).toBe("2026-10-30");
      expect(describeLateCause(p, t3, lateCause(s, t3)!), maria[1]).toBe(
        "Held back by the fixed start 2026-10-26 of T1."
      );
      // So Alex gets no note to give work away.
      expect(workloadDiagnostics(p, s), maria[1]).toEqual([]);
    }
  });

  it("weighs waits of people with different working days in working days of the project", () => {
    // Jordan works weekends: the check waits seven of Jordan's days, three weeks (15 working
    // days), for the backlog; the release then waits 12 days for Alex's.
    const p = planFrom({
      "project.md": PROJECT,
      "team.md": TEAM + md("", "## Jordan", "", "capacity: 16h/week", "workweek: sat-sun"),
      "milestones/M1.md": md(
        "# M1",
        "",
        "- [ ] Weekend backlog @est:56h @owner:jordan @prio:high ^T1",
        "- [ ] Check @est:1d @owner:jordan ^T2",
        "- [ ] Alex backlog @est:6w @owner:alex @prio:high ^T4",
        "- [ ] Release @est:1d @owner:alex @dep:T2 @due:2026-10-30 ^T3"
      ),
    });
    const s = schedulePlan(p, { today: "2026-10-14" });
    const t3 = p.taskById("T3")!;
    expect(describeLateCause(p, t3, lateCause(s, t3)!)).toBe(
      "Held back by Jordan having other work before T2."
    );
  });

  it("weighs a fixed start by what it holds back on every way to the late task", () => {
    const team = TEAM + md("", "## Priya", "", "capacity: 40h/week");
    const release = (kickOff: string, frontend: string) =>
      planFrom({
        "project.md": PROJECT,
        "team.md": team,
        "milestones/M1.md": md(
          "# M1",
          "",
          `- [ ] Kick-off @est:1d @owner:alex${kickOff} ^T1`,
          "- [ ] Backend @est:1d @owner:sam @dep:T1 ^T2",
          frontend,
          "- [ ] Release @est:1d @owner:alex @dep:T2,T3 @due:2026-10-23 ^T4"
        ),
      });
    const cause = (p: ReturnType<typeof release>) => {
      const s = schedulePlan(p, { today: "2026-10-14" });
      const t4 = p.taskById("T4")!;
      expect(s.tasks.get(t4)!.late).toBe(true);
      const c = lateCause(s, t4);
      return c && describeLateCause(p, t4, c);
    };
    // Both ways wait for the kick-off: its fixed start holds the release back.
    const both = "- [ ] Frontend @est:1d @owner:priya @dep:T1 ^T3";
    expect(cause(release(" @start:2026-11-02", both))).toBe(
      "Held back by the fixed start 2026-11-02 of T1 (via T2)."
    );
    // The frontend takes until 2026-10-29 anyway: the release would not be any earlier.
    const frontend = "- [ ] Frontend @est:12d @owner:priya ^T3";
    expect(cause(release(" @start:2026-10-28", frontend))).toBeUndefined();
    // Maria works on Mondays: she reviews on 2026-10-19 whether the kick-off is on Wednesday or
    // on Friday.
    const monday = planFrom({
      "project.md": PROJECT,
      "team.md": TEAM + md("", "## Maria", "", "capacity: 8h/week", "workweek: mon"),
      "milestones/M1.md": md(
        "# M1",
        "",
        "- [ ] Kick-off @est:1d @owner:alex @start:2026-10-16 ^T1",
        "- [ ] Review @est:1d @owner:maria @dep:T1 @due:2026-10-16 ^T2"
      ),
    });
    const s = schedulePlan(monday, { today: "2026-10-14" });
    const t2 = monday.taskById("T2")!;
    expect(s.tasks.get(t2)!.late).toBe(true);
    expect(lateCause(s, t2)).toBeUndefined();
  });

  it("does not name a fixed start that also puts its task first", () => {
    // The report's fixed start puts it before the audit, which has a fixed start too. Without it
    // the report starts on Wednesday, but the audit goes first from Friday on: the report
    // finishes on 2026-10-21 all the same.
    for (const start of [" @start:2026-10-19", ""]) {
      const p = plan(
        md(
          "# M1",
          "",
          `- [ ] Report @est:3d @owner:alex${start} @due:2026-10-16 ^T1`,
          "- [ ] Audit @est:3d @owner:alex @start:2026-10-16 ^T2"
        )
      );
      const s = schedulePlan(p, { today: "2026-10-14" });
      const t1 = p.taskById("T1")!;
      expect(formatDate(s.tasks.get(t1)!.finish!), start).toBe("2026-10-21");
      expect(lateCause(s, t1), start).toBeUndefined();
    }
  });

  it("tells tasks with the same id apart when it weighs the work handed over", () => {
    // Two tasks share T1 (an error of its own): the notes wait for the first, and the other one is
    // other work that takes the hours the preparation leaves.
    const p = plan(
      md(
        "# M1",
        "",
        "- [ ] Prepare @est:4h @owner:alex @prio:high ^T1",
        "- [ ] Other @est:4h @owner:alex @prio:high ^T1",
        "- [ ] Notes @est:1d @owner:alex @dep:T1 @due:2026-10-14 ^T2"
      )
    );
    const s = schedulePlan(p, { today: "2026-10-14" });
    const t2 = p.taskById("T2")!;
    expect(describeLateCause(p, t2, lateCause(s, t2)!)).toBe(
      "Held back by Alex having other work first."
    );
    expect(workloadDiagnostics(p, s).map((i) => i.data)).toEqual([{ person: "alex" }]);
  });

  it("weighs long waits in linear time", () => {
    // Sam's backlog: everything is due next week, so the last tasks wait for years.
    const tasks = Array.from(
      { length: 3000 },
      (_, i) => `- [ ] Task ${i + 1} @est:1d @owner:sam @due:2026-10-20 ^T${i + 1}`
    );
    const p = plan(md("# M1", "", ...tasks));
    const schedule = () => schedulePlan(p, { today: "2026-10-14" });
    const s = schedule();
    const late = [...s.tasks.values()].filter((ts) => ts.late);
    expect(late.length).toBeGreaterThan(2000);
    const causes = late.map((ts) => lateCause(s, ts.task));
    expect(causes.every((c) => c?.kind === "busy" && c.resource === "sam")).toBe(true);
    expect(fastest(schedule, lateCauses)).toBeLessThan(timeLimit(25));
  });

  it("weighs the work before a task on the day it could start in linear time", () => {
    // A long chain of sign-offs without hours after the preparation, all done on Wednesday, and
    // Alex's backlog waiting for the last one.
    const steps = Array.from(
      { length: 2000 },
      (_, i) => `- [ ] Sign-off ${i + 1} @owner:alex @dep:T${i + 1} ^T${i + 2}`
    );
    const work = Array.from(
      { length: 2000 },
      (_, i) => `- [ ] Work ${i + 1} @est:4h @owner:alex @dep:T2001 @due:2026-10-20 ^W${i + 1}`
    );
    const p = plan(md("# M1", "", "- [ ] Prepare @est:4h @owner:alex ^T1", ...steps, ...work));
    const schedule = () => schedulePlan(p, { today: "2026-10-14" });
    const s = schedule();
    expect(s.tasks.get(p.taskById("T2001")!)!.finish).toBe(s.start);
    const late = [...s.tasks.values()].filter((ts) => ts.late);
    expect(late.length).toBeGreaterThan(1900);
    expect(late.every((ts) => lateCause(s, ts.task)?.resource === "alex")).toBe(true);
    expect(fastest(schedule, lateCauses)).toBeLessThan(timeLimit(25));
  });
});

describe("implied dependencies", () => {
  it("lists dependencies another one in the list already covers, as a hint", () => {
    const p = plan(
      md(
        "# M1",
        "",
        "- [ ] Robots ^T1",
        "  - [ ] Welding @est:1h ^T2",
        "- [ ] Setup @est:1h ^T3",
        "- [ ] Commission @est:1h @dep:T3 ^T4",
        "- [ ] Accept @est:1h @dep:T1,T2,T3,T4 ^T5",
        "- [ ] Lagged @est:1h @dep:T4,T3+2d ^T6"
      )
    );
    expect(impliedDeps(p, p.taskById("T5")!)).toEqual([
      { id: "T2", why: "T1 includes it" },
      { id: "T3", why: "T4 waits for it" },
    ]);
    expect(impliedDeps(p, p.taskById("T6")!)).toEqual([]);
    const hint = validatePlan(p).find((i) => i.code === "implied-dep")!;
    expect(hint).toMatchObject({ severity: "hint", data: { key: "dep", implied: "T2,T3" } });
  });

  it("keeps dependencies that a milestone dependency also covers", () => {
    const p = plan(
      md("# M1", "", "- [ ] A @est:1h ^T1"),
      md("# M2", "", "depends: M1", "", "- [ ] B @est:1h @dep:T1 ^T2")
    );
    expect(impliedDeps(p, p.taskById("T2")!)).toEqual([]);
  });
});

describe("new errors", () => {
  it("finds the errors a change adds, not those that were there or moved", () => {
    const before = plan(md("# M1", "", "- [ ] A @est:1h @dep:T9 ^T1", "- [ ] B @est:1h ^T2"));
    const moved = plan(md("# M1", "", "- [ ] B @est:1h ^T2", "- [ ] A @est:1h @dep:T9 ^T1"));
    expect(newErrors(planErrors(before), planErrors(moved))).toEqual([]);
    const cyclic = plan(
      md("# M1", "", "- [ ] A @est:1h @dep:T9 ^T1", "- [ ] B @est:1h @dep:T3 ^T2"),
      md("# M2", "", "depends: M1", "", "- [ ] C @est:1h ^T3")
    );
    expect(newErrors(planErrors(before), planErrors(cyclic))).toEqual([
      "Circular dependency: T2 → T3.",
    ]);
  });
});

describe("tasks that cannot be scheduled", () => {
  it("names who has no hours and since when, and points the tasks behind it to the cause", () => {
    const p = planFrom({
      "project.md": PROJECT,
      "team.md": md(
        "# Team",
        "",
        "## Jordan",
        "",
        "capacityFrom: 2026-12-24 0h/week",
        "",
        "## Sam",
        "",
        "capacity: 40h/week"
      ),
      "milestones/M1.md": md(
        "# M1",
        "",
        "- [ ] Investigate @est:12w @owner:sam ^T1",
        "- [ ] Interface @est:3d @owner:jordan @dep:T1 ^T2"
      ),
      "milestones/M2.md": md("# M2", "", "depends: M1", "", "- [ ] Test @est:1d @owner:sam ^T3"),
    });
    const s = schedulePlan(p, { today: "2026-10-14" });
    expect(s.tasks.get(p.taskById("T2")!)!.unscheduled).toBe("horizon");
    expect(s.tasks.get(p.taskById("T3")!)!.unscheduled).toBe("waits-for-unscheduled");
    expect(unscheduledCause(p, s, p.taskById("T2")!)).toBe(
      "Jordan has no working hours from 2026-12-24 on (capacityFrom: 2026-12-24 0h/week)"
    );
    expect(unscheduledCause(p, s, p.taskById("T3")!)).toBe(
      "it waits for T2, which cannot be scheduled because Jordan has no working hours from 2026-12-24 on (capacityFrom: 2026-12-24 0h/week)"
    );
    const codes = scheduleDiagnostics(p, s).map((i) => `${i.code}:${i.file}`);
    expect(codes).toContain("unschedulable:milestones/M1.md");
    expect(codes).toContain("blocked-by-unschedulable:milestones/M2.md");
  });

  it("points to the nearest task that cannot be scheduled", () => {
    const p = planFrom({
      "project.md": PROJECT,
      "team.md": md("# Team", "", "## Jordan", "", "capacity: 0h/week", "", "## Sam"),
      "milestones/M1.md": md(
        "# M1",
        "",
        "- [ ] Design @est:1d @owner:jordan ^T1",
        "- [ ] Build @est:1d @owner:sam @dep:T1 ^T2",
        "- [ ] Test @est:1d @owner:sam @dep:T2 ^T3",
        "- [ ] Licence @est:1d @owner:jordan ^T4",
        "- [ ] Release @est:1d @owner:sam @dep:T3,T4 ^T5"
      ),
    });
    const s = schedulePlan(p, { today: "2026-10-14" });
    expect(unscheduledCause(p, s, p.taskById("T3")!)).toMatch(/^it waits for T1, /);
    expect(unscheduledCause(p, s, p.taskById("T5")!)).toMatch(/^it waits for T4, /);
  });

  it("explains long chains behind an unschedulable task in linear time", () => {
    const tasks = Array.from(
      { length: 3000 },
      (_, i) => `- [ ] Step ${i + 2} @est:1h @owner:sam @dep:T${i + 1} ^T${i + 2}`
    );
    const p = planFrom({
      "project.md": PROJECT,
      "team.md": md("# Team", "", "## Jordan", "", "capacity: 0h/week", "", "## Sam"),
      "milestones/M1.md": md("# M1", "", "- [ ] Start @est:1d @owner:jordan ^T1", ...tasks),
    });
    const schedule = () => schedulePlan(p, { today: "2026-10-14" });
    const s = schedule();
    const causes = [...s.tasks.values()].map((ts) => unscheduledCause(p, s, ts.task));
    expect(causes[3000]).toBe(
      "it waits for T1, which cannot be scheduled because Jordan has no working hours from 2026-10-14 on"
    );
    const explain = (s2: Schedule) => {
      for (const ts of s2.tasks.values()) unscheduledCause(p, s2, ts.task);
    };
    expect(fastest(schedule, explain)).toBeLessThan(timeLimit(100));
  });
});

describe("people whose workload makes tasks late", () => {
  it("adds one plain note per person on their heading, only when tasks end up late", () => {
    const p = plan(
      md(
        "# M1",
        "",
        "- [ ] Big job @est:2w @owner:sam @prio:high ^T1",
        "- [ ] Small fix @est:1d @owner:sam @due:2026-10-20 ^T2",
        "- [ ] Other work @est:1d @owner:alex ^T3"
      )
    );
    const s = schedulePlan(p, { today: "2026-10-14" });
    const issues = workloadDiagnostics(p, s);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      file: "team.md",
      range: { start: { line: 2 } },
      severity: "info",
      code: "overbooked",
      data: { person: "sam" },
    });
    expect(issues[0].message).toBe(
      "Sam has 88h of open work, about 3 weeks at 40h a week, planned until 2026-10-28. This task finishes after the deadline because Sam has other work first: T2 (6 working days late). Give some of this work to someone else, or move the deadlines."
    );
    // Without late tasks there is nothing to report, however full the week.
    const busy = plan(
      md("# M1", "", "- [ ] A @est:3w @owner:sam ^T1", "- [ ] B @est:3w @owner:sam ^T2")
    );
    expect(workloadDiagnostics(busy, schedulePlan(busy, { today: "2026-10-14" }))).toEqual([]);
  });

  /** The workload note on Sam for a big job and a small fix due soon, with Sam's extra lines. */
  function samNote(...sam: string[]) {
    const p = planFrom({
      "project.md": PROJECT,
      "team.md": md("# Team", "", "## Sam", "", "capacity: 40h/week", ...sam),
      "milestones/M1.md": md(
        "# M1",
        "",
        "- [ ] Big job @est:2w @owner:sam @prio:high ^T1",
        "- [ ] Small fix @est:1d @owner:sam @due:2026-10-20 ^T2"
      ),
    });
    return workloadDiagnostics(p, schedulePlan(p, { today: "2026-10-14" }))[0]?.message;
  }

  it("works out the weeks with the capacity in force, saying when it changes", () => {
    // Changed before today: the new capacity is the one that counts.
    expect(samNote("capacityFrom: 2026-10-05 20h/week")).toMatch(
      /^Sam has 88h of open work, about 5 weeks at 20h a week, planned until 2026-11-12\. /
    );
    // Changed on the way.
    expect(samNote("capacityFrom: 2026-10-26 20h/week")).toMatch(
      /^Sam has 88h of open work, about 3 weeks at 40h a week, then 20h a week from 2026-10-26, planned until 2026-11-02\. /
    );
    // A break, and back.
    expect(
      samNote("capacityFrom: 2026-10-19 0h/week", "capacityFrom: 2026-10-26 40h/week")
    ).toMatch(
      /^Sam has 88h of open work, about 4 weeks at 40h a week, then no hours from 2026-10-19, then 40h a week from 2026-10-26, planned until 2026-11-04\. /
    );
    // A change after the work is done does not matter.
    expect(samNote("capacityFrom: 2027-01-04 20h/week")).toMatch(
      /^Sam has 88h of open work, about 3 weeks at 40h a week, planned until 2026-10-28\. /
    );
    // Time off counts too.
    expect(samNote("off: 2026-10-19..2026-10-23")).toMatch(
      /^Sam has 88h of open work, about 4 weeks at 40h a week, planned until 2026-11-04\. /
    );
  });

  it("says how much fits when the person's working hours end first", () => {
    const p = planFrom({
      "project.md": PROJECT,
      "team.md": md(
        "# Team",
        "",
        "## Sam",
        "",
        "capacity: 40h/week",
        "capacityFrom: 2026-10-26 0h/week"
      ),
      "milestones/M1.md": md(
        "# M1",
        "",
        "- [ ] Big job @est:1w @owner:sam @prio:high ^T1",
        "- [ ] Small fix @est:1d @owner:sam @due:2026-10-20 ^T2",
        "- [ ] Later @est:1w @owner:sam @prio:low ^T3"
      ),
    });
    const [note] = workloadDiagnostics(p, schedulePlan(p, { today: "2026-10-14" }));
    expect(note.message).toBe(
      "Sam has 88h of open work, but only about 64h fit before Sam's working hours end on 2026-10-26 (40h a week), planned until 2026-10-21 (1 more task cannot be scheduled yet). This task finishes after the deadline because Sam has other work first: T2 (1 working day late). Give some of this work to someone else, or move the deadlines."
    );
  });

  it("counts a task due on a Saturday and done on Monday as one working day late", () => {
    const p = plan(
      md(
        "# M1",
        "",
        "- [ ] Big job @est:3d @owner:sam @prio:high ^T1",
        "- [ ] Small fix @est:1d @owner:sam @due:2026-10-17 ^T2"
      )
    );
    const s = schedulePlan(p, { today: "2026-10-14" });
    expect(scheduleDiagnostics(p, s).find((i) => i.code === "late-task")?.message).toBe(
      "Scheduled to finish 2026-10-19, after @due 2026-10-17 (1 working day late). Held back by Sam having other work first."
    );
    expect(workloadDiagnostics(p, s)[0]?.message).toBe(
      "Sam has 32h of open work, about 1 week at 40h a week, planned until 2026-10-19. This task finishes after the deadline because Sam has other work first: T2 (1 working day late). Give some of this work to someone else, or move the deadlines."
    );
  });
});
