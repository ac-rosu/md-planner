// Entering work that happened before it was written down: the real day it was done or began.
import { describe, expect, it } from "vitest";
import { pastDateSuggestions } from "../../../src/core/dates";
import { doneDateSuggestions } from "../../../src/core/queries";
import { markOpenDone, setStatus } from "../../../src/core/writer";
import { changeTask } from "../../../src/core/writer/entities";
import { apply, md, planFrom, task } from "../helpers";

const TODAY = "2026-10-30"; // a Friday
const M1 = (...lines: string[]) =>
  planFrom({ "milestones/M1.md": md("# M1", "", "id: M1", "target: 2026-07-10", "", ...lines) });
const text = (p: ReturnType<typeof M1>, edits: Parameters<typeof apply>[1]) =>
  apply(p.file("milestones/M1.md")!, edits);

describe("the day work was done", () => {
  it("is written instead of today, also replacing a date that is there", () => {
    const p = M1("- [ ] Kick-off @est:4h ^T1", "- [x] Review @est:4h @done:2026-10-30 ^T2");
    const f = p.file("milestones/M1.md")!;
    const done = setStatus(f.lines, task(p, "T1"), "done", TODAY, { date: "2026-06-12" });
    expect(text(p, done)).toContain("- [x] Kick-off @est:4h @done:2026-06-12 ^T1");
    // Without a date: today, and an existing @done stays.
    expect(text(p, setStatus(f.lines, task(p, "T1"), "done", TODAY))).toContain(
      "@done:2026-10-30 ^T1"
    );
    const corrected = changeTask(f.lines, task(p, "T2"), { statusDate: "2026-06-20" }, TODAY);
    expect(text(p, corrected)).toContain("- [x] Review @est:4h @done:2026-06-20 ^T2");
    const started = setStatus(f.lines, task(p, "T1"), "doing", TODAY, { date: "2026-06-01" });
    expect(text(p, started)).toContain("- [/] Kick-off @est:4h @started:2026-06-01 ^T1");
  });

  it("is the day of the subtasks finished along and of the parent that follows", () => {
    const p = M1(
      "- [ ] Design ^T1",
      "  - [x] Wireframes @est:8h @done:2026-06-05 ^T2",
      "  - [ ] Review @est:4h ^T3",
      "  - [ ] Sign-off @est:2h ^T4"
    );
    const f = p.file("milestones/M1.md")!;
    const parentToo = setStatus(f.lines, task(p, "T3"), "done", TODAY, {
      date: "2026-06-09",
      rollUp: true,
    });
    // T4 is still open: the parent does not finish yet.
    expect(text(p, parentToo)).toContain("- [x] Review @est:4h @done:2026-06-09 ^T3");
    const all = setStatus(f.lines, task(p, "T1"), "done", TODAY, {
      date: "2026-06-12",
      subtasks: "done",
    });
    const out = text(p, all);
    expect(out).toContain("- [x] Design @done:2026-06-12 ^T1");
    expect(out).toContain("- [x] Sign-off @est:2h @done:2026-06-12 ^T4");
    expect(out).toContain("@done:2026-06-05 ^T2");
  });

  it("is offered: the milestone target once passed, and when the dependencies finished", () => {
    const p = M1("- [x] API @est:8h @done:2026-07-02 ^T1", "- [ ] UI @est:8h @dep:T1 ^T2");
    expect(doneDateSuggestions(p, task(p, "T2"), TODAY)).toEqual([
      { label: "the M1 target", date: "2026-07-10" },
      { label: "when its dependencies finished", date: "2026-07-02" },
    ]);
    // A target still ahead is not a day work was done on.
    expect(doneDateSuggestions(p, task(p, "T2"), "2026-07-01")).toEqual([]);
    expect(pastDateSuggestions(TODAY)).toEqual([
      { label: "today", date: "2026-10-30" },
      { label: "yesterday", date: "2026-10-29" },
      { label: "last Friday", date: "2026-10-23" },
      { label: "end of last month", date: "2026-09-30" },
    ]);
  });
});

describe("marking a finished phase done at once", () => {
  it("marks every open task done on the day, never before it started, and leaves the rest", () => {
    const p = M1(
      "- [ ] Kick-off @est:4h ^T1",
      "- [/] Research @est:8h @started:2026-07-15 ^T2",
      "- [x] Scope @est:2h @done:2026-06-03 ^T3",
      "- [-] Dropped @est:2h ^T4",
      "- [ ] Design ^T5",
      "  - [ ] Wireframes @est:8h ^T6"
    );
    const f = p.file("milestones/M1.md")!;
    const r = markOpenDone(f.lines, p.milestones[0].tasks, "2026-07-10", TODAY);
    expect(r.marked.map((t) => t.id)).toEqual(["T1", "T2", "T5", "T6"]);
    expect(r.startedLater.map((t) => t.id)).toEqual(["T2"]);
    expect(text(p, r.edits)).toBe(
      md(
        "# M1",
        "",
        "id: M1",
        "target: 2026-07-10",
        "",
        "- [x] Kick-off @est:4h @done:2026-07-10 ^T1",
        "- [x] Research @est:8h @started:2026-07-15 @done:2026-07-15 ^T2",
        "- [x] Scope @est:2h @done:2026-06-03 ^T3",
        "- [-] Dropped @est:2h ^T4",
        "- [x] Design @done:2026-07-10 ^T5",
        "  - [x] Wireframes @est:8h @done:2026-07-10 ^T6"
      )
    );
  });
});
