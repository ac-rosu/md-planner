import { describe, expect, it } from "vitest";
import {
  formatDate,
  isoWeek,
  isoWeekday,
  isoWeekKey,
  parseDate,
  parseDateRange,
  parseWorkweek,
  weekKeyStart,
  weekStart,
} from "../../../src/core/dates";
import {
  formatHours,
  parseCapacity,
  parseDeps,
  parseDuration,
  parsePercent,
} from "../../../src/core/duration";

describe("dates", () => {
  it("parses and formats ISO dates round trip", () => {
    for (const d of ["2026-10-14", "2024-02-29", "2027-01-01", "1999-12-31"]) {
      expect(formatDate(parseDate(d)!)).toBe(d);
    }
  });

  it("rejects malformed and impossible dates", () => {
    for (const d of [
      "2026-13-01",
      "2026-02-30",
      "2025-02-29",
      "26-10-14",
      "2026-1-4",
      "today",
      "",
    ]) {
      expect(parseDate(d)).toBeUndefined();
    }
  });

  it("computes ISO weekdays and weeks, including week 53 and year boundaries", () => {
    expect(isoWeekday(parseDate("2026-10-14")!)).toBe(3); // Wednesday
    expect(isoWeekday(parseDate("2026-10-18")!)).toBe(7); // Sunday
    expect(isoWeekKey(parseDate("2026-10-14")!)).toBe("2026-W42");
    expect(isoWeek(parseDate("2026-12-31")!)).toEqual({ year: 2026, week: 53 });
    expect(isoWeek(parseDate("2027-01-03")!)).toEqual({ year: 2026, week: 53 });
    expect(isoWeek(parseDate("2027-01-04")!)).toEqual({ year: 2027, week: 1 });
    expect(isoWeek(parseDate("2024-12-30")!)).toEqual({ year: 2025, week: 1 });
    expect(formatDate(weekStart(parseDate("2026-10-18")!))).toBe("2026-10-12");
    expect(formatDate(weekKeyStart("2026-W53")!)).toBe("2026-12-28");
    expect(formatDate(weekKeyStart("2027-W01")!)).toBe("2027-01-04");
  });

  it("parses workweeks including wrap-around ranges and lists", () => {
    expect([...parseWorkweek("mon-fri")!].sort()).toEqual([1, 2, 3, 4, 5]);
    expect([...parseWorkweek("sun-thu")!].sort()).toEqual([1, 2, 3, 4, 7]);
    expect([...parseWorkweek("mon, wed,fri")!].sort()).toEqual([1, 3, 5]);
    expect([...parseWorkweek("Monday-Thursday")!].sort()).toEqual([1, 2, 3, 4]);
    expect(parseWorkweek("weekdays")).toBeUndefined();
  });

  it("parses date ranges", () => {
    expect(parseDateRange("2026-12-22..2027-01-02")).toEqual([
      parseDate("2026-12-22"),
      parseDate("2027-01-02"),
    ]);
    expect(parseDateRange("2027-02-09")).toEqual([
      parseDate("2027-02-09"),
      parseDate("2027-02-09"),
    ]);
    expect(parseDateRange("2027-01-02..2026-12-22")).toBeUndefined();
    expect(parseDateRange("2027-01-02..x")).toBeUndefined();
  });
});

describe("durations", () => {
  it("converts h, d and w using hoursPerDay and a 5-day week", () => {
    expect(parseDuration("12h", 8)).toBe(12);
    expect(parseDuration("5.5h", 8)).toBe(5.5);
    expect(parseDuration("2d", 8)).toBe(16);
    expect(parseDuration("2d", 7.5)).toBe(15);
    expect(parseDuration("1w", 8)).toBe(40);
    expect(parseDuration("0.5w", 8)).toBe(20);
    expect(parseDuration("12", 8)).toBeUndefined();
    expect(parseDuration("2 days", 8)).toBeUndefined();
    expect(parseDuration("-2h", 8)).toBeUndefined();
  });

  it("formats hours compactly", () => {
    expect(formatHours(5)).toBe("5h");
    expect(formatHours(5.25)).toBe("5.25h");
    expect(formatHours(1 / 3)).toBe("0.33h");
  });

  it("parses percentages and capacities", () => {
    expect(parsePercent("40%")).toBe(0.4);
    expect(parsePercent("100%")).toBe(1);
    expect(parsePercent("140%")).toBeUndefined();
    expect(parseCapacity("32h/week")).toEqual({ hours: 32, per: "week" });
    expect(parseCapacity("6.5h/day")).toEqual({ hours: 6.5, per: "day" });
    expect(parseCapacity("32 h / week")).toEqual({ hours: 32, per: "week" });
    expect(parseCapacity("32")).toBeUndefined();
  });

  it("parses dependency lists with lags", () => {
    const deps = parseDeps("T101,T102+2d, T7+4h", 8);
    expect(deps.map((d) => [d.id, d.lagHours, d.valid])).toEqual([
      ["T101", 0, true],
      ["T102", 16, true],
      ["T7", 4, true],
    ]);
    expect(parseDeps("T1+x", 8)[0].valid).toBe(false);
  });
});
