// Years outside 1000–9999 and month arithmetic: dates are read back as they were written.
import { describe, expect, it } from "vitest";
import {
  addMonths,
  formatDate,
  isoWeek,
  isoWeekKey,
  parseDate,
  weekKeyStart,
} from "../../../src/core/dates";
import { defaultEndDate } from "../../../src/core/templates";

describe("years before 1000", () => {
  it("reads years 0–99 as written, not as 1900–1999", () => {
    expect(parseDate("0026-10-01")).not.toBe(parseDate("1926-10-01"));
    expect(parseDate("1026-10-01")! - parseDate("0026-10-01")!).toBe(365_242);
    expect(parseDate("0000-02-29")).toBeDefined(); // year 0 is a leap year
    expect(parseDate("0100-02-29")).toBeUndefined();
  });

  it("writes four-digit years, so every date reads back", () => {
    for (const iso of ["0026-10-01", "0999-12-31", "0001-01-01", "1026-07-01", "9999-12-31"])
      expect(formatDate(parseDate(iso)!)).toBe(iso);
    const key = isoWeekKey(parseDate("0026-10-01")!);
    expect(key).toMatch(/^0026-W\d\d$/);
    expect(weekKeyStart(key)).toBe(parseDate("0026-09-28"));
    expect(isoWeek(parseDate("0026-01-04")!).year).toBe(26);
  });

  it("rejects years of five digits", () => {
    expect(parseDate("10000-01-01")).toBeUndefined();
  });
});

describe("months later", () => {
  it("keeps the day of the month, or takes the month's last day when it is shorter", () => {
    const iso = (s: string, n: number) => formatDate(addMonths(parseDate(s)!, n));
    expect(iso("2026-10-14", 6)).toBe("2027-04-14");
    expect(iso("2026-08-31", 6)).toBe("2027-02-28");
    expect(iso("2027-08-31", 6)).toBe("2028-02-29");
    expect(iso("2026-12-31", -1)).toBe("2026-11-30");
    expect(iso("2026-01-31", 1)).toBe("2026-02-28");
  });

  it("gives a new project an end six months on, clamped to the month's end", () => {
    expect(defaultEndDate("2026-08-31")).toBe("2027-02-28");
    expect(defaultEndDate("2026-10-14")).toBe("2027-04-14");
    expect(defaultEndDate("not a date")).toBe("not a date");
  });
});
