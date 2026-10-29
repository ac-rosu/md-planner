// Baselines that were edited by hand or written by another tool, and tasks without ids that moved
// since the baseline was saved.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  baselineLookup,
  baselineText,
  createBaseline,
  milestoneTrends,
  parseBaseline,
} from "../../../src/core/baseline";
import { parseDate } from "../../../src/core/dates";
import { schedulePlan, taskKey } from "../../../src/core/scheduler";
import { md, planFrom, SAMPLE_PLAN, TODAY } from "../helpers";

const valid = {
  name: "kickoff",
  date: "2026-10-07",
  project: "P",
  tasks: { T1: { title: "Build", start: "2026-10-01", finish: "2026-10-02", hours: 16 } },
  milestones: { M1: { title: "M1", target: "2026-10-30", forecast: "2026-10-20", hours: 16 } },
};

const withChange = (path: string[], value: unknown): string => {
  const data = JSON.parse(JSON.stringify(valid));
  let o = data;
  for (const p of path.slice(0, -1)) o = o[p];
  o[path[path.length - 1]] = value;
  return JSON.stringify(data);
};

describe("parseBaseline checks every field", () => {
  it("rejects dates, titles and hours of the wrong type instead of failing later", () => {
    const cases: Array<[string[], unknown, RegExp]> = [
      [["milestones", "M1", "forecast"], 20261020, /milestone M1: forecast must be text/],
      [["milestones", "M1", "target"], { y: 2026 }, /milestone M1: target must be text/],
      [["milestones", "M1", "start"], ["2026-10-01"], /milestone M1: start must be text/],
      [["milestones", "M1", "title"], 1, /milestone M1: title must be text/],
      [["milestones", "M1", "hours"], "16", /milestone M1: hours must be a number/],
      [["milestones", "M1"], "M1", /milestone M1 must be an object/],
      [["tasks", "T1", "start"], 20261001, /task T1: start must be text/],
      [["tasks", "T1", "finish"], true, /task T1: finish must be text/],
      [["tasks", "T1", "title"], 7, /task T1: title must be text/],
      [["tasks", "T1", "hours"], "16h", /task T1: hours must be a number/],
      [["tasks", "T1"], null, /task T1 must be an object/],
      [["tasks"], [], /tasks must be an object/],
      [["tasks"], null, /tasks must be an object/],
      [["milestones"], [], /milestones must be an object/],
      [["project"], 42, /project must be text/],
      [["date"], 20261007, /not a planner baseline\./],
      [["name"], null, /not a planner baseline\./],
    ];
    for (const [path, value, message] of cases)
      expect(() => parseBaseline(withChange(path, value), "b.json"), path.join(".")).toThrow(
        message
      );
    expect(() => parseBaseline("[]", "b.json")).toThrow(/b\.json is not a planner baseline\./);
    expect(() => parseBaseline("null", "b.json")).toThrow(/not a planner baseline/);
  });

  it("no longer lets a numeric forecast crash the milestone trend", () => {
    const plan = planFrom({
      "project.md": md("# P", "", "start: 2026-10-01"),
      "milestones/M1.md": md("# M1", "", "id: M1", "", "- [ ] Build @est:16h ^T1"),
    });
    const schedule = schedulePlan(plan, { today: "2026-10-01" });
    const text = withChange(["milestones", "M1", "forecast"], 20261020);
    // Before the check, the file was accepted and the trend failed with "text.trim is not a function".
    expect(() => milestoneTrends(plan, schedule, parseBaseline(text))).toThrow(
      /not a planner baseline/
    );
    // Forecast Fri 2 Oct against 20 Oct in the baseline: 12 working days earlier.
    expect(milestoneTrends(plan, schedule, parseBaseline(JSON.stringify(valid))).get("M1")).toEqual(
      {
        baseline: "kickoff",
        baselineForecast: "2026-10-20",
        slip: -12,
      }
    );
  });

  it("accepts every baseline the planner writes, unchanged", () => {
    const text = readFileSync(join(SAMPLE_PLAN, "baselines/2026-10-07-kickoff.json"), "utf8");
    expect(parseBaseline(text)).toEqual(JSON.parse(text));
    const plan = planFrom({
      "project.md": md("# P", "", "start: 2026-10-01"),
      "milestones/M1.md": md(
        "# M1",
        "",
        "id: M1",
        "",
        "- [ ] Build @est:16h ^T1",
        "- [ ] Not estimated",
        "- [ ] Parent",
        "  - [ ] Child @est:2h"
      ),
    });
    const b = createBaseline(plan, schedulePlan(plan, { today: TODAY }), "now");
    expect(parseBaseline(baselineText(b))).toEqual(b);
  });

  it("treats missing or null optional fields as absent", () => {
    const b = parseBaseline(
      JSON.stringify({
        name: "old",
        date: "2026-10-01",
        tasks: { T1: { title: "A", start: null, hours: null }, T2: {} },
      })
    );
    expect(b).toEqual({
      name: "old",
      date: "2026-10-01",
      project: "",
      tasks: { T1: { title: "A", hours: 0 }, T2: { title: "", hours: 0 } },
      milestones: {},
    });
    expect(baselineLookup(b).task("T1")).toEqual({ start: undefined, finish: undefined });
  });

  it("does not take keys like constructor from the object prototype", () => {
    const b = parseBaseline(JSON.stringify(valid));
    const lookup = baselineLookup(b);
    expect(lookup.task("constructor")).toBeUndefined();
    expect(lookup.task("toString")).toBeUndefined();
    expect(lookup.task("milestone:constructor")).toBeUndefined();
    expect(lookup.task("T1")).toEqual({
      start: parseDate("2026-10-01"),
      finish: parseDate("2026-10-02"),
    });
  });
});

describe("baselines of tasks without ids", () => {
  const before = md(
    "# M1",
    "",
    "id: M1",
    "",
    "- [ ] Design @est:16h",
    "- [ ] Build @est:24h",
    "- [ ] Test @est:8h ^T9"
  );
  const files = (milestone: string) => ({
    "project.md": md("# P", "", "start: 2026-10-01"),
    "milestones/M1.md": milestone,
  });
  const old = planFrom(files(before));
  const baseline = createBaseline(old, schedulePlan(old, { today: "2026-10-01" }), "kickoff");

  it("are found by file and line while the title matches", () => {
    const lookup = baselineLookup(baseline);
    for (const t of old.tasks) {
      const entry = baseline.tasks[taskKey(t)];
      expect(lookup.task(taskKey(t), t.title)).toEqual({
        start: parseDate(entry.start!),
        finish: parseDate(entry.finish!),
      });
    }
  });

  it("are not shown on another task after lines were inserted above them", () => {
    // A new task above Design moves every task one line down.
    const now = planFrom(
      files(before.replace("- [ ] Design", "- [ ] Kick-off @est:4h\n- [ ] Design"))
    );
    const lookup = baselineLookup(baseline);
    const byTitle = new Map(now.tasks.map((t) => [t.title, t]));
    const key = (title: string) => taskKey(byTitle.get(title)!);
    // Kick-off now has Design's line, Design has Build's line: neither gets the other's dates.
    expect(key("Kick-off")).toBe("milestones/M1.md#5");
    expect(baseline.tasks["milestones/M1.md#5"].title).toBe("Design");
    expect(lookup.task(key("Kick-off"), "Kick-off")).toBeUndefined();
    expect(lookup.task(key("Design"), "Design")).toBeUndefined();
    expect(lookup.task(key("Build"), "Build")).toBeUndefined();
    // A task with an id keeps its baseline wherever it is.
    expect(lookup.task("T9", "Test")).toEqual({
      start: parseDate(baseline.tasks.T9.start!),
      finish: parseDate(baseline.tasks.T9.finish!),
    });
    // Matched by id even when renamed; without a title (older callers) as before.
    expect(lookup.task("T9", "Renamed")).toBeDefined();
    expect(lookup.task("milestones/M1.md#5")).toBeDefined();
  });

  it("still match an entry saved without a title", () => {
    const b = parseBaseline(
      JSON.stringify({
        name: "x",
        date: "2026-10-01",
        tasks: { "milestones/M1.md#5": { start: "2026-10-01", finish: "2026-10-02", hours: 8 } },
      })
    );
    expect(baselineLookup(b).task("milestones/M1.md#5", "Anything")).toEqual({
      start: parseDate("2026-10-01"),
      finish: parseDate("2026-10-02"),
    });
  });
});
