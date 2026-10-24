import { describe, expect, it } from "vitest";
import { nearMissCheckbox } from "../../../src/core/parser/taskLine";
import { schedulePlan } from "../../../src/core/scheduler";
import { validatePlan } from "../../../src/core/validate";
import { nextStatus, renumberCopiedIds, setStatus } from "../../../src/core/writer";
import { applyEdits } from "../../../src/core/text";
import { md, planFrom } from "../helpers";

const PROJECT = md("# P", "", "start: 2026-10-01", "end: 2027-03-31");
const TEAM = md("# Team", "", "## Sam", "", "capacity: 40h/week");

function plan(milestone: string, extra: Record<string, string> = {}) {
  return planFrom({
    "project.md": PROJECT,
    "team.md": TEAM,
    "milestones/M1.md": milestone,
    ...extra,
  });
}

function issues(milestone: string, extra: Record<string, string> = {}) {
  return validatePlan(plan(milestone, extra));
}

function codes(milestone: string, extra: Record<string, string> = {}) {
  return issues(milestone, extra).map((i) => `${i.severity}:${i.code}:${i.range.start.line}`);
}

describe("near-miss task lines", () => {
  it.each([
    ["- [] Title", "- [ ] Title", "empty"],
    ["-[ ] Title", "- [ ] Title", "after the list marker"],
    ["  -[x] Done", "  - [x] Done", "after the list marker"],
    ["- [ ]Title", "- [ ] Title", "after ]"],
    ["[ ] Title", "- [ ] Title", "no list marker"],
    ["    [/] Under way", "    - [/] Under way", "no list marker"],
    ["1.[ ] Numbered", "1. [ ] Numbered", "after the list marker"],
    ["-[]", "- [ ]", "empty"],
  ])("%s → %s", (line, fixed, problem) => {
    const near = nearMissCheckbox(line);
    expect(near?.fixed).toBe(fixed);
    expect(near?.problem).toContain(problem);
  });

  it.each([
    "- [ ] A real task",
    "- [x]",
    "[x]: https://example.com/reference",
    "[ ](https://example.com) a link",
    "- [link](https://example.com)",
    "- [x](https://example.com)",
    "[^1] a footnote",
    "[] alone without a marker",
    "Some text [ ] in the middle",
    "- plain list item",
  ])("leaves %s alone", (line) => {
    expect(nearMissCheckbox(line)).toBeUndefined();
  });

  it("warns on the line with the fixed text, outside code fences only", () => {
    const list = issues(
      md("# M1", "", "- [ ] Real ^T1", "- [] Forgot the space", "```", "- [] in code", "```")
    ).filter((i) => i.code === "not-a-task");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      severity: "warning",
      range: { start: { line: 3, character: 0 } },
      data: { fixed: "- [ ] Forgot the space" },
    });
  });
});

describe("status dates", () => {
  it("flags a leftover @started on a to-do task, unless time was logged", () => {
    expect(
      codes(
        md(
          "# M1",
          "",
          "- [ ] Left over @est:1h @started:2026-10-02 ^T1",
          "- [ ] Paused @est:4h @act:1h @started:2026-10-02 ^T2",
          "- [/] Running @est:1h @started:2026-10-02 ^T3"
        )
      )
    ).toEqual(["info:stale-started:2"]);
  });

  it("flags done leaf tasks without @done and @done before @started", () => {
    expect(
      codes(
        md(
          "# M1",
          "",
          "- [x] No date @est:1h ^T1",
          "- [x] Backwards @est:1h @started:2026-10-05 @done:2026-10-02 ^T2",
          "- [x] Parent ^T3",
          "  - [x] Child @est:1h @done:2026-10-02 ^T4"
        )
      )
    ).toEqual(["info:missing-done:2", "warning:done-before-started:3"]);
  });

  it("does not stretch a to-do task back to a leftover @started", () => {
    const p = plan(
      md(
        "# M1",
        "",
        "- [ ] Left over @est:8h @owner:sam @started:2026-10-01 ^T1",
        "- [/] Running @est:8h @owner:sam @started:2026-10-01 ^T2"
      )
    );
    const s = schedulePlan(p, { today: "2026-10-14" });
    const start = (id: string) => s.tasks.get(p.taskById(id)!)!.start;
    expect(start("T1")).toBeGreaterThanOrEqual(s.start);
    expect(start("T2")).toBeLessThan(s.start);
  });
});

describe("status changes", () => {
  const line = (text: string, today: string, status?: Parameters<typeof setStatus>[2]) => {
    const p = plan(md("# M1", "", text));
    const t = p.taskById("T1")!;
    const f = p.file("milestones/M1.md")!;
    return applyEdits(
      f.lines.serialize(),
      setStatus(f.lines, t, status ?? nextStatus(t.status), today)
    ).split("\n")[2];
  };

  it("removes @started when a task goes back to to do with no time logged", () => {
    expect(line("- [/] A @est:1h @started:2026-10-02 ^T1", "2026-10-05", "todo")).toBe(
      "- [ ] A @est:1h ^T1"
    );
    expect(line("- [x] A @est:1h @started:2026-10-02 @done:2026-10-04 ^T1", "2026-10-05")).toBe(
      "- [ ] A @est:1h ^T1"
    );
  });

  it("keeps @started when time or progress was logged", () => {
    expect(line("- [/] A @est:4h @act:1h @started:2026-10-02 ^T1", "2026-10-05", "todo")).toBe(
      "- [ ] A @est:4h @act:1h @started:2026-10-02 ^T1"
    );
    expect(
      line("- [/] A @est:4h @progress:50% @started:2026-10-02 ^T1", "2026-10-05", "todo")
    ).toBe("- [ ] A @est:4h @progress:50% @started:2026-10-02 ^T1");
  });
});

describe("dates", () => {
  const ms = (...tasks: string[]) => md("# M1", "", "target: 2027-01-15", "", ...tasks);

  it("flags dates outside the project and suggests the year that fits", () => {
    const list = issues(
      ms(
        "- [/] Typo @est:1h @start:2027-10-19 @started:2026-10-19 ^T1",
        "- [ ] Early due @est:1h @due:2025-11-02 ^T2",
        "- [ ] Far off @est:1h @start:2029-01-01 ^T3"
      )
    ).filter((i) => i.code === "date-outside-project");
    expect(list.map((i) => [i.range.start.line, i.data])).toEqual([
      [4, { key: "start", suggestion: "2026-10-19" }],
      [5, { key: "due", suggestion: "2026-11-02" }],
      [6, { key: "start" }],
    ]);
    // The more precise warning replaces the target and started checks on the same date.
    expect(
      issues(ms("- [/] Typo @est:1h @start:2027-10-19 @started:2026-10-19 ^T1")).map((i) => i.code)
    ).toEqual(["date-outside-project"]);
  });

  it("flags a fixed start after work started, and dates after the milestone target", () => {
    expect(
      codes(
        ms(
          "- [/] Pinned late @est:1h @start:2026-10-22 @started:2026-10-20 ^T1",
          "- [ ] Start too late @est:1h @start:2027-01-20 ^T2",
          "- [ ] Due too late @est:1h @due:2027-02-01 ^T3",
          "- [x] Done tasks are history @est:1h @start:2027-01-20 @done:2027-01-21 ^T4"
        )
      )
    ).toEqual([
      "warning:start-after-started:4",
      "warning:start-after-target:5",
      "warning:due-after-target:6",
    ]);
    const due = issues(ms("- [ ] Due too late @est:1h @due:2027-02-01 ^T3")).find(
      (i) => i.code === "due-after-target"
    )!;
    expect(due.data).toEqual({ key: "due", target: "2027-01-15" });
  });

  it("flags team.md dates after the project end, with the year that fits", () => {
    const list = validatePlan(
      planFrom({
        "project.md": PROJECT,
        "team.md": md(
          "# Team",
          "",
          "## JSO",
          "",
          "capacityFrom: 2027-12-24 0h/week",
          "off: 2026-12-21..2026-12-31",
          "workday: 2028-02-06"
        ),
      })
    ).filter((i) => i.code === "date-outside-project");
    expect(list.map((i) => [i.range.start.line, i.data])).toEqual([
      [4, { date: "2027-12-24", suggestion: "2026-12-24" }],
      [6, { date: "2028-02-06", suggestion: "2027-02-06" }],
    ]);
    expect(list[0].message).toBe(
      "capacityFrom: 2027-12-24 is after the project end 2027-03-31, so it changes nothing. Is the year right?"
    );
  });

  it("flags a milestone target after the project end", () => {
    expect(codes(md("# M1", "", "target: 2027-09-01", "", "- [ ] a @est:1h ^T1"))).toEqual([
      "warning:date-outside-project:2",
    ]);
  });
});

describe("dependencies", () => {
  it("flags dependencies on cancelled work as ignored", () => {
    const list = issues(
      md(
        "# M1",
        "",
        "- [-] Dropped @est:1h ^T1",
        "- [-] Dropped parent ^T2",
        "  - [ ] Moot child @est:1h ^T3",
        "- [ ] After @est:1h @dep:T1,T3,T9 ^T4"
      )
    );
    expect(
      list.filter((i) => i.code === "cancelled-dep").map((i) => [i.data?.depId, i.message])
    ).toEqual([
      ["T1", "T1 is cancelled, so this dependency is ignored."],
      ["T3", "T3 is part of a cancelled task, so this dependency is ignored."],
    ]);
    const cancelledMilestone = issues(md("# M1", "", "- [ ] a @est:1h @dep:T2 ^T1"), {
      "milestones/M2.md": md("# M2", "", "status: cancelled", "", "- [ ] b @est:1h ^T2"),
    }).find((i) => i.code === "cancelled-dep");
    expect(cancelledMilestone?.message).toBe(
      "T2 is in the cancelled milestone M2, so this dependency is ignored."
    );
  });

  it("explains dependencies on the task itself, its parent or its subtask", () => {
    const list = issues(
      md(
        "# M1",
        "",
        "- [ ] Self @est:1h @dep:T1 ^T1",
        "- [ ] Parent ^T2",
        "  - [ ] Child @est:1h @dep:T2 ^T3",
        "- [ ] Waits for a part @dep:T5 ^T4",
        "  - [ ] Part @est:1h ^T5"
      )
    );
    expect(list.filter((i) => i.code === "circular-dep")).toEqual([]);
    expect(list.filter((i) => i.code === "family-dep").map((i) => i.message)).toEqual([
      "Depends on itself. Not scheduled.",
      "Depends on its own parent T2, which only finishes when its subtasks do, so it can never start. Subtasks already wait for what their parent waits for. Not scheduled.",
      "Depends on its own subtask T5: a task cannot wait for a part of itself. Not scheduled.",
    ]);
  });
});

describe("copied ids", () => {
  const PATH = "milestones/M1.md";
  const renumber = (
    text: string,
    saved: string | undefined,
    extra: Record<string, string> = {}
  ) => {
    const p = plan(text, extra);
    const f = p.file(PATH)!;
    return applyEdits(f.lines.serialize(), renumberCopiedIds(p, f, saved));
  };
  const head = ["# M1", ""];

  it("gives a copied line a fresh id once it is retitled, and keeps the original", () => {
    const saved = md(...head, "- [ ] Write spec @est:1h ^T1", "- [ ] Review @dep:T1 ^T2");
    const now = md(
      ...head,
      "- [ ] Write spec @est:1h ^T1",
      "- [ ] Write tests @est:1h ^T1",
      "- [ ] Review @dep:T1 ^T2"
    );
    expect(renumber(now, saved)).toBe(
      md(
        ...head,
        "- [ ] Write spec @est:1h ^T1",
        "- [ ] Write tests @est:1h ^T3",
        "- [ ] Review @dep:T1 ^T2"
      )
    );
  });

  it("leaves an identical copy alone: it may be a task being moved", () => {
    const saved = md(...head, "- [ ] Write spec @est:1h ^T1");
    const now = md(...head, "- [ ] Write spec @est:1h ^T1", "- [ ] Write spec @est:1h ^T1");
    expect(renumber(now, saved)).toBe(now);
  });

  it("keeps the id on the line whose title is unchanged, wherever the copy was pasted", () => {
    const saved = md(...head, "- [ ] Build A @est:1h ^T1");
    const now = md(...head, "- [ ] Build B @est:1h ^T1", "- [ ] Build A @est:1h ^T1");
    expect(renumber(now, saved)).toBe(
      md(...head, "- [ ] Build B @est:1h ^T2", "- [ ] Build A @est:1h ^T1")
    );
  });

  it("renumbers a retitled task pasted from another file, not a task moved there", () => {
    const other = { "milestones/M2.md": md("# M2", "", "- [ ] Original @est:1h ^T5") };
    expect(renumber(md(...head, "- [ ] Variant @est:1h ^T5"), md(...head), other)).toBe(
      md(...head, "- [ ] Variant @est:1h ^T6")
    );
    // Pasted here before it is deleted there: same title, nothing changes.
    expect(renumber(md(...head, "- [ ] Original @est:1h ^T5"), md(...head), other)).toBe(
      md(...head, "- [ ] Original @est:1h ^T5")
    );
  });

  it("leaves duplicates that were already saved for the quick fix", () => {
    const both = md(...head, "- [ ] A ^T1", "- [ ] B ^T1");
    expect(renumber(both, both)).toBe(both);
  });
});
