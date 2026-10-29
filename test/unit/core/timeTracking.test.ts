import { describe, expect, it } from "vitest";
import { addActual, formatElapsed, timerRanLong, unreadableActual } from "../../../src/core/time";
import { md, planFrom, task } from "../helpers";

const plan = (...lines: string[]) => planFrom({ "milestones/M1.md": md("# M1", "", ...lines) });

describe("logging time on an @act typed by hand", () => {
  it("refuses to add to an @act it does not read, saying what to write", () => {
    const p = plan(
      "- [/] Minutes @act:90m ^T1",
      "- [/] Clock @act:1:30 ^T2",
      "- [/] Words @act:a-while ^T3",
      "- [/] Empty @act: ^T4",
      "- [/] Repeated @act:90m @act:2h ^T5"
    );
    expect(unreadableActual(task(p, "T1"))).toBe(
      "@act:90m is not read as hours; write it as @act:1.5h first"
    );
    expect(unreadableActual(task(p, "T2"))).toBe(
      "@act:1:30 is not read as hours; write it as @act:1.5h first"
    );
    expect(unreadableActual(task(p, "T3"))).toBe(
      "@act:a-while is not read as hours; write it as hours (e.g. @act:1.5h) first"
    );
    expect(unreadableActual(task(p, "T4"))).toMatch(/^@act: is not read as hours/);
    // Only the first @act counts, as when the plan is read.
    expect(unreadableActual(task(p, "T5"))).toMatch(/^@act:90m is not read/);
  });

  it("adds to an @act it reads, and to a task without one, as before", () => {
    const p = plan(
      "- [/] Hours @act:1.5h ^T1",
      "- [/] Days @act:1d ^T2",
      "- [/] Zero @act:0h ^T3",
      "- [/] None ^T4"
    );
    for (const id of ["T1", "T2", "T3", "T4"])
      expect(unreadableActual(task(p, id))).toBeUndefined();
    expect(addActual(task(p, "T2").act, 1)).toBe("9h");
    expect(addActual(task(p, "T4").act, 1)).toBe("1h");
  });
});

describe("a timer left running", () => {
  const hours = (h: number) => h * 3_600_000;

  it("shows the elapsed time in hours and minutes, never like a time of day", () => {
    expect(
      [0, 59_999, 42 * 60_000, 65 * 60_000, hours(17) + 42 * 60_000].map(formatElapsed)
    ).toEqual(["0m", "0m", "42m", "1h 05m", "17h 42m"]);
    // The clock was set back.
    expect(formatElapsed(-60_000)).toBeUndefined();
  });

  it("asks before logging more than a working day, or time across midnight", () => {
    const day = "2026-10-14";
    expect(timerRanLong(hours(7.9), 8, day, day)).toBe(false);
    expect(timerRanLong(hours(8), 8, day, day)).toBe(false);
    expect(timerRanLong(hours(8.1), 8, day, day)).toBe(true);
    expect(timerRanLong(hours(16.3), 8, day, "2026-10-15")).toBe(true);
    // From 23:30 to 00:20: short, but into the next day.
    expect(timerRanLong(50 * 60_000, 8, day, "2026-10-15")).toBe(true);
    // A shorter working day.
    expect(timerRanLong(hours(6.5), 6, day, day)).toBe(true);
  });
});
