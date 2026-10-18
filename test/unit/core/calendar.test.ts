import { describe, expect, it } from "vitest";
import { Calendar, UNASSIGNED } from "../../../src/core/calendar";
import { parseDate as d } from "../../../src/core/dates";
import { loadSample, md, planFrom } from "../helpers";

describe("calendar", () => {
  const plan = loadSample().plan;
  const cal = new Calendar(plan.project, plan.people, { unassignedCapacity: 40 });

  it("knows working days, weekends and holidays", () => {
    expect(cal.isWorkingDay(d("2026-10-14")!)).toBe(true);
    expect(cal.isWorkingDay(d("2026-10-17")!)).toBe(false); // Saturday
    expect(cal.isWorkingDay(d("2026-12-25")!)).toBe(false); // holiday
    expect(cal.isWorkingDay(d("2027-01-01")!)).toBe(false);
    expect(cal.nextWorkingDay(d("2026-12-24")! + 1)).toBe(d("2026-12-28"));
    expect(cal.addWorkingDays(d("2026-10-16")!, 1)).toBe(d("2026-10-19"));
    expect(cal.workingDaysBetween(d("2026-10-12")!, d("2026-10-19")!)).toBe(5);
    expect(cal.workingDaysBetween(d("2026-12-21")!, d("2026-12-28")!)).toBe(4);
  });

  it("spreads weekly capacity over the person's working days", () => {
    expect(cal.capacity("alex", d("2026-10-14")!)).toBeCloseTo(32 / 5);
    expect(cal.capacity("sam", d("2026-10-14")!)).toBe(8);
    expect(cal.capacity("Sam", d("2026-10-17")!)).toBe(0);
    expect(cal.weekCapacity("alex", d("2026-10-12")!)).toBeCloseTo(32);
  });

  it("gives zero capacity on time off, single days and holidays", () => {
    expect(cal.capacity("sam", d("2026-11-17")!)).toBe(0);
    expect(cal.capacity("sam", d("2026-11-21")!)).toBe(0);
    expect(cal.capacity("sam", d("2026-11-23")!)).toBe(8);
    expect(cal.capacity("sam", d("2027-02-09")!)).toBe(0);
    expect(cal.isOff("sam", d("2027-02-09")!)).toBe(true);
    expect(cal.capacity("priya", d("2026-12-25")!)).toBe(0);
    expect(cal.weekCapacity("sam", d("2026-11-16")!)).toBe(8);
  });

  it("applies capacityFrom changes and h/day with a personal workweek", () => {
    expect(cal.capacity("jordan", d("2026-12-30")!)).toBeCloseTo(24 / 5);
    expect(cal.capacity("jordan", d("2027-01-04")!)).toBeCloseTo(32 / 5);
    expect(cal.nominalWeeklyCapacity("jordan", d("2027-01-04")!)).toBe(32);
    expect(cal.capacity("maria", d("2026-10-15")!)).toBe(4); // Thursday
    expect(cal.capacity("maria", d("2026-10-16")!)).toBe(0); // Friday: not in mon-thu
    expect(cal.nominalWeeklyCapacity("maria", d("2026-10-16")!)).toBe(16);
  });

  it("has an unassigned pool with configurable capacity", () => {
    const small = new Calendar(plan.project, plan.people, { unassignedCapacity: 20 });
    expect(small.capacity(UNASSIGNED, d("2026-10-14")!)).toBe(4);
    expect(cal.capacity(UNASSIGNED, d("2026-10-14")!)).toBe(8);
    expect(cal.capacity("nobody", d("2026-10-14")!)).toBe(0);
  });

  it("supports other workweeks and default full-time capacity", () => {
    const p = planFrom({
      "project.md": md(
        "# P",
        "",
        "workweek: sun-thu",
        "hoursPerDay: 7.5",
        "holidays: 2026-10-01..2026-10-02"
      ),
      "team.md": md("# Team", "", "## Ali"),
    });
    const c = new Calendar(p.project, p.people);
    expect(c.isWorkingDay(d("2026-10-04")!)).toBe(true); // Sunday
    expect(c.isWorkingDay(d("2026-10-09")!)).toBe(false); // Friday
    expect(c.isWorkingDay(d("2026-10-01")!)).toBe(false); // holiday range
    expect(c.capacity("ali", d("2026-10-04")!)).toBe(7.5);
  });
});
