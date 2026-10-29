// What a plan does with input typed in a hurry: it is either read as meant or reported, never
// dropped without a word.
import { describe, expect, it } from "vitest";
import { parseWorkweek } from "../../../src/core/dates";
import { buildDepGraph, newTaskWouldCycle } from "../../../src/core/graph";
import { joinDepIds, moveIdToEnd, moveLineUp, renameAttrKey } from "../../../src/core/lineFixes";
import { propertyBlockFor } from "../../../src/core/parser/files";
import { cleanTag, nearMissCheckbox, titleMarkup } from "../../../src/core/parser/taskLine";
import { scheduleDiagnostics } from "../../../src/core/scheduleDiagnostics";
import { schedulePlan } from "../../../src/core/scheduler";
import { validatePlan } from "../../../src/core/validate";
import { addTag, formatTaskBlock, formatTaskLine, guardNotes } from "../../../src/core/writer";
import { newTaskLeavesSchedule } from "../../../src/core/writer/structure";
import { apply, md, milestone, planFrom, task } from "../helpers";

const PROJECT = md("# P", "", "start: 2026-11-02", "hoursPerDay: 8");
const TEAM = md(
  "# Team",
  "",
  "## Ann",
  "",
  "capacity: 40h/week",
  "",
  "## Bob",
  "",
  "capacity: 0h/week"
);
const plan = (...lines: string[]) =>
  planFrom({
    "project.md": PROJECT,
    "team.md": TEAM,
    "milestones/M1.md": md("# M1", "", "id: M1", "", ...lines),
  });
const codes = (p: ReturnType<typeof plan>) => validatePlan(p).map((i) => i.code);

describe("checkboxes typed by hand", () => {
  it("reports boxes with more than one character and pasted bullets, with the fix", () => {
    expect(nearMissCheckbox("- [x ] Checkout ^T3")).toEqual({
      problem: "the box holds one character – write [x]",
      fixed: "- [x] Checkout ^T3",
    });
    expect(nearMissCheckbox("  - [ x] Cart")?.fixed).toBe("  - [x] Cart");
    expect(nearMissCheckbox("- [  ] Cart")?.fixed).toBe("- [ ] Cart");
    expect(nearMissCheckbox("• [ ] Pasted")).toEqual({
      problem: "• is not a list marker – write - [ ]",
      fixed: "- [ ] Pasted",
    });
    // Links and real checkboxes are left alone.
    expect(nearMissCheckbox("- [x] Done")).toBeUndefined();
    expect(nearMissCheckbox("- [ab](https://example.com)")).toBeUndefined();
  });

  it("warns on the line instead of making the task disappear", () => {
    const f = milestone(md("# M1", "", "id: M1", "", "- [x ] Checkout @owner:bob ^T3"));
    expect(f.issues.map((i) => [i.code, i.message])).toEqual([
      ["not-a-task", "Not read as a task: the box holds one character – write [x]."],
    ]);
  });
});

describe("workweeks", () => {
  it("reads dashes from word processors and full or short day names", () => {
    expect([...parseWorkweek("mon–fri")!]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseWorkweek("Monday — Thursday")!]).toEqual([1, 2, 3, 4]);
    expect([...parseWorkweek("tues..thurs")!]).toEqual([2, 3, 4]);
  });

  it("rejects what is not a day name instead of reading the first three letters", () => {
    for (const text of ["mon to fri", "mon fri", "monfri", "mo-fr", "mon/fri"])
      expect(parseWorkweek(text), text).toBeUndefined();
    const p = planFrom({ "project.md": md("# P", "", "workweek: mon to fri") });
    expect(validatePlan(p).map((i) => i.message)).toEqual([
      'Invalid workweek "mon to fri" (e.g. mon-fri).',
    ]);
    expect(p.project.workweek.size).toBe(5);
  });
});

describe("attributes and ids typed slightly wrong", () => {
  it("warns when @dep is split by a space after a comma, and the fix joins the ids", () => {
    const p = plan("- [ ] a @est:8h ^T1", "- [ ] b @est:8h ^T2", "- [ ] c @est:4h @dep:T2, T1 ^T3");
    expect(codes(p)).toContain("dep-space");
    expect(joinDepIds("- [ ] c @est:4h @dep:T2, T1,  T4+2d ^T3")).toBe(
      "- [ ] c @est:4h @dep:T2,T1,T4+2d ^T3"
    );
    expect(joinDepIds("- [ ] c @dep:T2, then review ^T3")).toBeUndefined();
  });

  it("warns on a known attribute in another case or under a common other name", () => {
    const p = plan(
      "- [ ] a @Owner:ann @depends:T2 @deadline:2026-11-20 @team:sales ^T1",
      "- [ ] b ^T2"
    );
    const issues = validatePlan(p).filter((i) => i.code === "misspelled-attr");
    expect(issues.map((i) => i.message)).toEqual([
      "@Owner is not @owner: it is kept as a custom field and does nothing. Did you mean @owner?",
      "@depends is not @dep: it is kept as a custom field and does nothing. Did you mean @dep?",
      "@deadline is not @due: it is kept as a custom field and does nothing. Did you mean @due?",
    ]);
    const line = "- [ ] a @Owner:ann ^T1";
    expect(renameAttrKey(line, 8, 18, "owner")).toBe("- [ ] a @owner:ann ^T1");
  });

  it("warns on an id that is not last on the line, and the fix moves it there", () => {
    const p = plan("- [ ] f ^T6 @est:8h", "- [ ] g @dep:T6 ^T7");
    const issue = validatePlan(p).find((i) => i.code === "id-not-last")!;
    expect(issue.message).toBe(
      "^T6 is read as title text: the id has to be the last thing on the line."
    );
    expect(moveIdToEnd("- [ ] f ^T6 @est:8h", 8, 11)).toBe("- [ ] f @est:8h ^T6");
    // Not when the line already ends with an id: that one is the task's.
    expect(moveIdToEnd("- [ ] f ^T6 @est:8h ^T9", 8, 11)).toBeUndefined();
  });

  it("reports two milestones with one id", () => {
    const p = planFrom({
      "milestones/M1-design.md": md(
        "# M1 – Design",
        "",
        "id: M1",
        "target: 2026-11-06",
        "",
        "- [ ] a ^T1"
      ),
      "milestones/M2-build.md": md(
        "# M2 – Build",
        "",
        "id: M1",
        "target: 2026-11-30",
        "",
        "- [ ] b ^T2"
      ),
    });
    const issues = validatePlan(p).filter((i) => i.code === "duplicate-milestone");
    expect(issues.map((i) => [i.file, i.severity])).toEqual([
      ["milestones/M1-design.md", "error"],
      ["milestones/M2-build.md", "error"],
    ]);
  });
});

describe("milestones that cannot finish", () => {
  it("say so instead of showing the forecast of the rest", () => {
    const p = plan("- [ ] a @est:8h @owner:ann ^T1", "- [ ] b @est:8h @owner:bob ^T2");
    const s = schedulePlan(p, { today: "2026-11-02", horizonDays: 30 });
    const issue = scheduleDiagnostics(p, s).find((i) => i.code === "incomplete-forecast")!;
    expect(issue.message).toBe(
      "M1 cannot finish: 1 task cannot be scheduled (T2). Its forecast 2026-11-02 is that of the other tasks."
    );
  });
});

describe("tags and titles from forms", () => {
  it("writes a tag that reads back as written", () => {
    expect(["v1.2", "R&D", "C++", "#bug", "a/b", "..."].map(cleanTag)).toEqual([
      "v1-2",
      "R-D",
      "C",
      "bug",
      "a/b",
      "",
    ]);
    const p = plan("- [ ] Login page @est:8h ^T1");
    const out = apply(
      p.file("milestones/M1.md")!,
      addTag(p.file("milestones/M1.md")!.lines, task(p, "T1"), "v1.2")
    );
    expect(out).toContain("- [ ] Login page @est:8h #v1-2 ^T1\n");
    expect(formatTaskLine({ title: "New", tags: ["Q&A", "..."], id: "T2" }, "")).toBe(
      "- [ ] New #Q-A ^T2"
    );
  });

  it("finds the parts of a title that a task line reads as something else", () => {
    expect(titleMarkup("Fix bug #42")).toEqual(["#42"]);
    expect(titleMarkup("Deploy @est:4h")).toEqual(["@est:4h"]);
    expect(titleMarkup("Fix bug (#42), mail sales@acme.com")).toEqual([]);
  });
});

describe("new tasks", () => {
  it("cannot depend on their parent, or on work that waits for them", () => {
    const p = planFrom({
      "milestones/M1.md": md(
        "# M1",
        "",
        "id: M1",
        "",
        "- [ ] parent ^T1",
        "  - [ ] child ^T2",
        "- [ ] other ^T3"
      ),
      "milestones/M2.md": md("# M2", "", "id: M2", "depends: M1", "", "- [ ] later ^T4"),
      "milestones/M3.md": md("# M3", "", "id: M3", "", "- [ ] waits for the parent @dep:T1 ^T5"),
    });
    const g = buildDepGraph(p);
    const blocked = (id: string, parent?: string) =>
      newTaskWouldCycle(g, task(p, id), "M1", parent ? task(p, parent) : undefined);
    expect(blocked("T1", "T1")).toBe(true); // its own parent
    expect(blocked("T4")).toBe(true); // M2 waits for all of M1
    expect(blocked("T5", "T1")).toBe(true); // waits for the parent's work
    expect(blocked("T5")).toBe(false); // a top-level task of M1 is not the parent's work
    expect(blocked("T3", "T1")).toBe(false);
  });

  it("say when they would not be scheduled where they are added", () => {
    const p = planFrom({
      "milestones/M1.md": md("# M1", "", "id: M1", "", "- [x] shipped @done:2026-11-02 ^T1"),
      "milestones/M2.md": md("# M2", "", "id: M2", "status: cancelled", ""),
    });
    expect(newTaskLeavesSchedule(p, task(p, "T1"), "M1", "Fix follow-up bug")).toBe(
      '"Fix follow-up bug" would be under T1, which is done, and not be scheduled.'
    );
    expect(newTaskLeavesSchedule(p, undefined, "M2", "A new task")).toBe(
      '"A new task" would be in M2, which is cancelled, and not be scheduled.'
    );
    expect(newTaskLeavesSchedule(p, undefined, "M1", "A new task")).toBeUndefined();
  });
});

describe("property lines that are not read", () => {
  const team = (...lines: string[]) =>
    planFrom({ "project.md": PROJECT, "team.md": md("# Team", "", ...lines) });

  it("reports a property after a blank line or text, and the fix moves it into the block", () => {
    const p = team(
      "## Ann",
      "",
      "role: dev",
      "",
      "off: 2026-11-02..2026-11-20",
      "capacity: 40h/week"
    );
    const issues = validatePlan(p).filter((i) => i.code === "property-not-read");
    expect(issues.map((i) => [i.range.start.line, i.message])).toEqual([
      [
        6,
        "off: is not read: property lines go right under the heading, one after the other, with no blank line or text in between.",
      ],
      [
        7,
        "capacity: is not read: property lines go right under the heading, one after the other, with no blank line or text in between.",
      ],
    ]);
    const f = p.file("team.md")!;
    expect(propertyBlockFor(f, 6)).toBe(5);
    expect(apply(f, moveLineUp(f.lines, 6, propertyBlockFor(f, 6)!))).toBe(
      md(
        "# Team",
        "",
        "## Ann",
        "",
        "role: dev",
        "off: 2026-11-02..2026-11-20",
        "",
        "capacity: 40h/week"
      )
    );
    // The last line of a file without a final line end.
    const last = planFrom({ "team.md": "# Team\n\n## Ann\n\nrole: dev\n\noff: 2026-11-02" });
    const lf = last.file("team.md")!;
    expect(apply(lf, moveLineUp(lf.lines, 6, 5))).toBe(
      "# Team\n\n## Ann\n\nrole: dev\noff: 2026-11-02\n"
    );
  });

  it("reports a target under the description, but not prose or code that looks like one", () => {
    const p = planFrom({
      "milestones/M1.md": md(
        "# M1",
        "",
        "id: M1",
        "",
        "Discovery for the relaunch.",
        "Status: waiting for the client",
        "status: still open with the client",
        "target: 2026-12-18",
        "```",
        "target: 2027-01-01",
        "```",
        "",
        "## Work",
        "",
        "target: 2026-12-01"
      ),
    });
    const issues = validatePlan(p).filter((i) => i.code === "property-not-read");
    expect(issues.map((i) => i.range.start.line)).toEqual([7]);
  });

  it("reports a second value of a property that holds one", () => {
    const p = team(
      "## Ann",
      "",
      "capacity: 40h/week",
      "off: 2026-11-02",
      "off: 2026-11-09",
      "capacity: 32h/week"
    );
    expect(
      validatePlan(p)
        .filter((i) => i.code === "duplicate-property")
        .map((i) => i.message)
    ).toEqual(["A second capacity: only the first one is used."]);
  });

  it("reports tasks in project.md and team.md, which are not scheduled", () => {
    const p = planFrom({
      "project.md": md("# P", "", "start: 2026-11-02", "", "- [ ] Kick-off @est:4h"),
    });
    expect(codes(p)).toContain("task-outside-milestone");
  });
});

describe("values that mean something else than they look", () => {
  it("warns on a lag after a space, and the fix joins it", () => {
    const p = plan("- [ ] a @est:8h ^T1", "- [ ] f @est:8h @dep:T1 +2d ^T2");
    expect(validatePlan(p).find((i) => i.code === "dep-space")?.message).toBe(
      "+2d after the space is title text, not the lag: write it without a space (@dep:T1+2d)."
    );
    expect(joinDepIds("- [ ] f @est:8h @dep:T1 +2d ^T2")).toBe("- [ ] f @est:8h @dep:T1+2d ^T2");
    expect(joinDepIds("- [ ] f @dep:T1, T3 +1d ^T2")).toBe("- [ ] f @dep:T1,T3+1d ^T2");
  });

  it("warns on progress written as a fraction", () => {
    const p = plan("- [/] a @est:8h @progress:0.5 ^T1", "- [/] b @est:8h @progress:50 ^T2");
    expect(
      validatePlan(p)
        .filter((i) => i.code === "progress-fraction")
        .map((i) => i.message)
    ).toEqual(["@progress:0.5 is read as 0.5 %. For 50 %, write @progress:50%."]);
  });

  it("warns on a capacity that is more than a day has", () => {
    const p = planFrom({
      "project.md": PROJECT,
      "team.md": md(
        "# Team",
        "",
        "## Ann",
        "",
        "capacity: 200h/week",
        "capacityFrom: 2027-01-04 30h/day"
      ),
    });
    expect(
      validatePlan(p)
        .filter((i) => i.code === "capacity-too-high")
        .map((i) => i.message)
    ).toEqual([
      "200h a week is 40h a working day, more than a day has. Is it a typo?",
      "30h a day is 30h a working day, more than a day has. Is it a typo?",
    ]);
  });

  it("does not let a person called Unassigned share the pool's day", () => {
    const p = planFrom({
      "project.md": PROJECT,
      "team.md": md("# Team", "", "## Unassigned", "", "capacity: 40h/week"),
      "milestones/M1.md": md("# M1", "", "id: M1", "", "- [ ] nobody's @est:16h ^T1"),
    });
    expect(codes(p)).toContain("reserved-person-id");
    const s = schedulePlan(p, { today: "2026-11-02" });
    expect(s.tasks.get(task(p, "T1"))!.finish).toBe(s.tasks.get(task(p, "T1"))!.start! + 1);
  });
});

describe("dates that hold up the plan", () => {
  it("warns on project holidays that close it for over a month or lie after its end", () => {
    const p = planFrom({
      "project.md": md(
        "# P",
        "",
        "start: 2026-11-02",
        "end: 2027-03-31",
        "holidays: 2026-12-24..2027-12-02, 2027-12-24..2027-12-31"
      ),
    });
    const issues = validatePlan(p).filter(
      (i) => i.code === "long-holiday" || i.code === "date-outside-project"
    );
    expect(issues.map((i) => [i.code, i.message])).toEqual([
      [
        "long-holiday",
        "holidays: 2026-12-24..2027-12-02 closes the project for 49 weeks: nobody works then. Is the year right?",
      ],
      [
        "date-outside-project",
        "holidays: 2027-12-24..2027-12-31 is after the project end 2027-03-31. Is the year right?",
      ],
    ]);
  });

  it("warns on a subtask due after its parent", () => {
    const p = plan("- [ ] parent @due:2026-11-13 ^T1", "  - [ ] child @est:8h @due:2026-11-20 ^T2");
    expect(validatePlan(p).find((i) => i.code === "due-after-parent-due")?.message).toBe(
      "@due 2026-11-20 is after the @due 2026-11-13 of T1, so the task is not reported late until 2026-11-20, although T1 is late by then."
    );
  });

  it("warns on a task done after today", () => {
    const p = plan(
      "- [x] shipped @est:8h @started:2026-10-01 @done:2027-10-21 ^T1",
      "- [ ] next @est:8h @dep:T1 ^T2"
    );
    const s = schedulePlan(p, { today: "2026-11-02" });
    expect(scheduleDiagnostics(p, s).find((i) => i.code === "done-in-future")?.message).toBe(
      "@done 2027-10-21 is after today: the tasks that wait for it are scheduled after that date. Is the date right?"
    );
  });
});

describe("notes of new tasks", () => {
  it("stay notes: a checkbox line is escaped and an open code fence closed", () => {
    expect(guardNotes(["- [ ] call Bob", "- plain list", "```", "code"])).toEqual([
      "\\- [ ] call Bob",
      "- plain list",
      "```",
      "code",
      "```",
    ]);
    expect(guardNotes(["~~~", "- [ ] in code", "~~~"])).toEqual(["~~~", "- [ ] in code", "~~~"]);
    const block = formatTaskBlock({ title: "New", id: "T2", notes: ["- [ ] call Bob"] }).join("\n");
    const p = planFrom({
      "milestones/M1.md": md("# M1", "", "id: M1", "", block, "- [ ] after ^T3"),
    });
    expect(task(p, "T2").children).toEqual([]);
    expect(p.tasks.map((t) => t.id)).toEqual(["T2", "T3"]);
  });
});
