// planner.* settings typed carelessly: a plan folder as `./plan` or an absolute path, numbers as
// text or in the wrong unit, a glob with an unclosed `{`, an empty TODO keyword. None of them may
// hang the extension, corrupt logged time or quietly change what a correct setting does.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_UNASSIGNED_CAPACITY,
  isAbsolutePath,
  pathSegments,
  planFolderSetting,
  settingNumber,
  unassignedCapacitySetting,
} from "../../../src/core/settingValues";
import { addActual, roundingMinutes, roundMinutes } from "../../../src/core/time";
import {
  DEFAULT_TODO_EXCLUDE,
  DEFAULT_TODO_INCLUDE,
  DEFAULT_TODO_KEYWORDS,
  globMatch,
  scanTodos,
  todoExclude,
  todoInclude,
  todoKeywords,
} from "../../../src/core/todos";

describe("planner.planFolder", () => {
  it("is plan when empty or not text, and trimmed", () => {
    expect([undefined, "", "  ", 42, null].map(planFolderSetting)).toEqual([
      "plan",
      "plan",
      "plan",
      "plan",
      "plan",
    ]);
    expect(planFolderSetting(" docs/plan ")).toBe("docs/plan");
  });

  it("tells absolute paths from relative ones", () => {
    for (const p of ["/var/folders/x/plan", "C:\\work\\plan", "c:/work/plan", "\\\\server\\plan"])
      expect(isAbsolutePath(p), p).toBe(true);
    for (const p of ["plan", "./plan", "docs/plan", "../shared/plan", "C:plan"])
      expect(isAbsolutePath(p), p).toBe(false);
  });

  it("names the same folder as ./plan, plan/ and plan", () => {
    expect(pathSegments("./plan")).toEqual(["plan"]);
    expect(pathSegments("plan/")).toEqual(["plan"]);
    expect(pathSegments("plan")).toEqual(["plan"]);
    expect(pathSegments(".\\docs\\plan\\")).toEqual(["docs", "plan"]);
    expect(pathSegments("../shared/./plan")).toEqual(["..", "shared", "plan"]);
  });
});

describe("number settings", () => {
  it("reads numbers, and numbers written as text with the setting's unit", () => {
    expect(settingNumber(40)).toBe(40);
    expect(settingNumber("40")).toBe(40);
    expect(settingNumber(" 40 h ", ["h"])).toBe(40);
    expect(settingNumber("40h")).toBeUndefined();
    expect(settingNumber("40 days", ["h"])).toBeUndefined();
    for (const v of [NaN, Infinity, "", "forty", true, null, [40], { h: 40 }])
      expect(settingNumber(v, ["h"])).toBeUndefined();
  });

  it("unassignedCapacity: 40h is 40; what is not hours is 40, said once", () => {
    expect(unassignedCapacitySetting(undefined)).toEqual({ hours: 40 });
    expect(unassignedCapacitySetting(32)).toEqual({ hours: 32 });
    expect(unassignedCapacitySetting(0)).toEqual({ hours: 0 });
    expect(unassignedCapacitySetting("40")).toEqual({ hours: 40 });
    expect(unassignedCapacitySetting("40h")).toEqual({ hours: 40 });
    expect(unassignedCapacitySetting("24 hours")).toEqual({ hours: 24 });
    for (const v of ["full", "40h/week", -5, NaN, true]) {
      const r = unassignedCapacitySetting(v);
      expect(r.hours).toBe(DEFAULT_UNASSIGNED_CAPACITY);
      expect(r.invalid).toMatch(/planner\.scheduling\.unassignedCapacity .* 40 is used/);
    }
  });
});

describe("planner.time.roundingMinutes", () => {
  it("keeps correct values as they are", () => {
    for (const m of [1, 5, 15, 30, 60]) expect(roundingMinutes(m)).toEqual({ minutes: m });
    expect(roundMinutes(7, 15)).toBe(15);
    expect(roundMinutes(50, 30)).toBe(60);
  });

  it("reads 15m as 15, and 15 for anything that is not minutes", () => {
    expect(roundingMinutes("15m")).toEqual({ minutes: 15 });
    expect(roundingMinutes("10 min")).toEqual({ minutes: 10 });
    for (const v of ["fifteen", "1h", NaN, -1, 0, true]) {
      const r = roundingMinutes(v);
      expect(r.minutes, String(v)).toBe(15);
      expect(r.invalid).toMatch(/planner\.time\.roundingMinutes/);
    }
    // The timer's @act never becomes NaN.
    expect(roundMinutes(7, Number("15m"))).toBe(15);
    expect(addActual(4, roundMinutes(7, Number("15m")) / 60)).toBe("4.25h");
  });

  it("is at most an hour: 900 (seconds typed as minutes) does not log 15 hours", () => {
    expect(roundingMinutes(900).minutes).toBe(60);
    expect(roundingMinutes(900).invalid).toMatch(/60 minutes/);
    expect(roundMinutes(7, 900)).toBe(60);
    expect(roundMinutes(0, 900)).toBe(0);
  });
});

describe("TODO settings", () => {
  it("treats an unclosed { in a glob as a character, quickly", () => {
    const started = Date.now();
    expect(globMatch("**/*.{ts,py", "src/a.ts")).toBe(false);
    expect(globMatch("**/*.{ts,py", "src/a.{ts,py")).toBe(true);
    expect(globMatch("src/{a", "src/{a")).toBe(true);
    expect(globMatch("**/{node_modules,dist/**", "x/node_modules/y")).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    // Closed braces work as before.
    expect(globMatch("**/*.{ts,py}", "src/a.ts")).toBe(true);
    expect(globMatch("**/*.{ts,py}", "src/a.md")).toBe(false);
    expect(globMatch(DEFAULT_TODO_INCLUDE, "src/server/payments.ts")).toBe(true);
    expect(globMatch(DEFAULT_TODO_EXCLUDE, "node_modules/x/index.js")).toBe(true);
    expect(globMatch("a}b", "a}b")).toBe(true);
  });

  it("ignores empty keywords", () => {
    const text = "const a = 1;\n// TODO: real one\nplain text line\n";
    expect(scanTodos(text, ["TODO", ""]).map((t) => t.text)).toEqual(["real one"]);
    expect(scanTodos(text, ["", " "])).toEqual([]);
    expect(todoKeywords(["TODO", "", "  ", 3, "HACK"])).toEqual(["TODO", "HACK"]);
    expect(todoKeywords("TODO")).toEqual(DEFAULT_TODO_KEYWORDS);
    expect(todoKeywords(undefined)).toEqual(DEFAULT_TODO_KEYWORDS);
  });

  it("uses the default globs for values that are not text; an empty exclude excludes nothing", () => {
    expect(todoInclude("")).toBe(DEFAULT_TODO_INCLUDE);
    expect(todoInclude(["**/*.ts"])).toBe(DEFAULT_TODO_INCLUDE);
    expect(todoInclude("**/*.ts")).toBe("**/*.ts");
    expect(todoExclude("")).toBe("");
    expect(todoExclude(undefined)).toBe(DEFAULT_TODO_EXCLUDE);
    expect(todoExclude(42)).toBe(DEFAULT_TODO_EXCLUDE);
  });
});
