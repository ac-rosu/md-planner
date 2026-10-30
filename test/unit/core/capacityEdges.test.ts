// Capacity edge cases: someone who leaves halfway through a task, overtime after their hours end,
// and two capacity changes on one day.
import { describe, expect, it } from "vitest";
import { Calendar } from "../../../src/core/calendar";
import { parseDate } from "../../../src/core/dates";
import { unscheduledCause } from "../../../src/core/lateCause";
import { scheduleDiagnostics } from "../../../src/core/scheduleDiagnostics";
import { schedulePlan } from "../../../src/core/scheduler";
import { md, planFrom } from "../helpers";

const PROJECT = md("# P", "", "start: 2026-10-01", "end: 2027-06-30");
const d = (iso: string) => parseDate(iso)!;

function team(...ann: string[]) {
  return md("# Team", "", "## Ann", "", "capacity: 40h/week", ...ann);
}

describe("someone who leaves halfway through a task", () => {
  it("says from when they have no hours, not that they have none for the task", () => {
    const p = planFrom({
      "project.md": PROJECT,
      "team.md": team("capacityFrom: 2026-11-04 0h/week"),
      "milestones/M1.md": md("# M1", "", "- [ ] Migration @est:5d @owner:ann ^T1"),
    });
    const s = schedulePlan(p, { today: "2026-11-02" });
    const t1 = p.taskById("T1")!;
    expect(s.tasks.get(t1)!.unscheduled).toBe("horizon");
    // Two days of hours (Monday and Tuesday), then none.
    expect(s.allocations.filter((a) => a.task === t1).map((a) => a.day)).toEqual([
      d("2026-11-02"),
      d("2026-11-03"),
    ]);
    expect(unscheduledCause(p, s, t1)).toBe(
      "Ann has no working hours from 2026-11-04 on (capacityFrom: 2026-11-04 0h/week)"
    );
    expect(scheduleDiagnostics(p, s).find((i) => i.code === "unschedulable")?.message).toBe(
      "Cannot be scheduled: Ann has no working hours from 2026-11-04 on (capacityFrom: 2026-11-04 0h/week). Give it to someone with time, or change their capacity."
    );
  });

  it("names the capacity change after a weekend, but not one after weeks without hours", () => {
    // Last hours on Friday, gone from Monday.
    const weekend = planFrom({
      "project.md": PROJECT,
      "team.md": team("capacityFrom: 2026-11-09 0h/week"),
      "milestones/M1.md": md("# M1", "", "- [ ] Migration @est:2w @owner:ann ^T1"),
    });
    const s = schedulePlan(weekend, { today: "2026-11-02" });
    expect(unscheduledCause(weekend, s, weekend.taskById("T1")!)).toBe(
      "Ann has no working hours from 2026-11-09 on (capacityFrom: 2026-11-09 0h/week)"
    );
    // No hours at all, and a later change to none again: that change is not the reason.
    const never = planFrom({
      "project.md": PROJECT,
      "team.md": md(
        "# Team",
        "",
        "## Ann",
        "",
        "capacity: 0h/week",
        "capacityFrom: 2027-01-04 0h/week"
      ),
      "milestones/M1.md": md("# M1", "", "- [ ] Migration @est:1d @owner:ann ^T1"),
    });
    const n = schedulePlan(never, { today: "2026-11-02" });
    expect(unscheduledCause(never, n, never.taskById("T1")!)).toBe(
      "Ann has no working hours from 2026-11-02 on"
    );
  });
});

describe("overtime after someone's hours end", () => {
  it("adds no hours once the normal hours end, and says so", () => {
    const p = planFrom({
      "project.md": PROJECT,
      "team.md": team(
        "capacityFrom: 2026-11-04 0h/week",
        "overtime: 2026-11-02..2026-11-13 +2h/day"
      ),
      "milestones/M1.md": md("# M1", "", "- [ ] Migration @est:5d @owner:ann ^T1"),
    });
    const cal = new Calendar(p.project, p.people);
    expect(cal.capacity("ann", d("2026-11-03"))).toBe(10);
    expect(cal.capacity("ann", d("2026-11-04"))).toBe(0);
    expect(cal.capacity("ann", d("2026-11-10"))).toBe(0);
    const s = schedulePlan(p, { today: "2026-11-02" });
    // Only Monday and Tuesday (10h each): no work booked after Ann left.
    expect(s.allocations.every((a) => a.day < d("2026-11-04"))).toBe(true);
    expect(s.tasks.get(p.taskById("T1")!)!.unscheduled).toBe("horizon");
    const warning = p.issues.find((i) => i.code === "overtime-without-hours");
    expect(warning).toMatchObject({ file: "team.md", severity: "warning" });
    expect(warning!.range.start.line).toBe(6);
    expect(warning!.message).toBe(
      "Ann has no working hours from 2026-11-04 (capacity 0h): overtime only adds to the normal hours of a day, so it adds none on 8 of the 10 working days."
    );
  });

  it("warns about overtime that falls entirely after the hours end", () => {
    const p = planFrom({
      "project.md": PROJECT,
      "team.md": team("capacityFrom: 2026-11-04 0h/week", "overtime: 2026-11-16 +4h/day"),
    });
    expect(p.issues.find((i) => i.code === "overtime-without-hours")?.message).toBe(
      "Ann has no working hours in this period (capacity 0h): overtime only adds to the normal hours of a day, so it adds none."
    );
    // Overtime while someone still works is fine.
    const fine = planFrom({
      "project.md": PROJECT,
      "team.md": team("capacityFrom: 2026-11-04 0h/week", "overtime: 2026-11-02 +2h/day"),
    });
    expect(fine.issues).toEqual([]);
  });
});

describe("two capacity changes on one day", () => {
  it("warns that only the last one counts", () => {
    const p = planFrom({
      "project.md": PROJECT,
      "team.md": team("capacityFrom: 2026-11-02 24h/week", "capacityFrom: 2026-11-02 32h/week"),
    });
    const cal = new Calendar(p.project, p.people);
    expect(cal.nominalWeeklyCapacity("ann", d("2026-11-02"))).toBe(32);
    expect(p.issues).toHaveLength(1);
    expect(p.issues[0]).toMatchObject({
      file: "team.md",
      severity: "warning",
      code: "duplicate-capacity-from",
      range: { start: { line: 5 } },
      message:
        "Another capacityFrom for 2026-11-02 follows (32h/week): only the last one counts, so this one is ignored.",
    });
  });
});
