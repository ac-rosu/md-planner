import { describe, expect, it } from "vitest";
import { formatDate } from "../../../src/core/dates";
import { type Status } from "../../../src/core/model";
import { estimateHours, progressOf, remainingHours } from "../../../src/core/rollup";
import { schedulePlan } from "../../../src/core/scheduler";
import { applyEdits } from "../../../src/core/text";
import { validatePlan } from "../../../src/core/validate";
import { setStatus, type StatusEffects } from "../../../src/core/writer";
import { md, planFrom } from "../helpers";

const TEAM = md("# Team", "", "## Sam", "", "capacity: 40h/week");
const PATH = "milestones/M1.md";

function plan(...lines: string[]) {
  return planFrom({ "team.md": TEAM, [PATH]: md("# M1", "", ...lines) });
}

function codes(...lines: string[]) {
  return validatePlan(plan(...lines))
    .filter((i) => i.code !== "missing-id")
    .map((i) => `${i.severity}:${i.code}:${i.range.start.line}`);
}

describe("a parent's estimate is the budget of its subtasks", () => {
  it("shares what the estimated subtasks leave among the unestimated ones", () => {
    const p = plan(
      "- [ ] Build API @est:3d @owner:sam ^T1",
      "  - [ ] Endpoints ^T2",
      "  - [ ] Tests ^T3",
      "  - [ ] Docs @est:4h ^T4",
      "- [ ] Next @est:1d @owner:sam @dep:T1 ^T5"
    );
    expect(p.taskById("T2")!.budget).toBe(10);
    expect(p.taskById("T3")!.budget).toBe(10);
    expect(p.taskById("T4")!.budget).toBeUndefined();
    expect(estimateHours(p.taskById("T1")!)).toBe(24);
    expect(remainingHours(p.taskById("T1")!)).toBe(24);
    // The work is scheduled: 3 days from Wednesday, so the successor starts on Monday.
    const s = schedulePlan(p, { today: "2026-10-14" });
    expect(formatDate(s.tasks.get(p.taskById("T4")!)!.finish!)).toBe("2026-10-16");
    expect(formatDate(s.tasks.get(p.taskById("T5")!)!.start!)).toBe("2026-10-19");
    expect(validatePlan(p).filter((i) => i.code === "missing-estimate")).toEqual([]);
  });

  it("goes down to the nearest estimated parent and subtracts time logged on the parent", () => {
    const p = plan(
      "- [ ] Outer @est:40h @act:4h ^T1",
      "  - [ ] Group ^T2",
      "    - [ ] A ^T3",
      "    - [ ] B @est:6h ^T4",
      "  - [ ] Inner @est:10h ^T5",
      "    - [ ] C ^T6",
      "    - [x] D ^T7"
    );
    expect(p.taskById("T3")!.budget).toBe(40 - 4 - 6 - 10);
    expect(p.taskById("T6")!.budget).toBe(5);
    expect(p.taskById("T7")!.budget).toBe(5);
    expect(progressOf(p.taskById("T5")!)).toBe(0.5);
  });

  it("gives no budget when the estimated subtasks use it all", () => {
    const p = plan("- [ ] P @est:4h ^T1", "  - [ ] A @est:4h ^T2", "  - [ ] B ^T3");
    expect(p.taskById("T3")!.budget).toBeUndefined();
    expect(codes("- [ ] P @est:4h ^T1", "  - [ ] A @est:4h ^T2", "  - [ ] B ^T3")).toEqual([
      "info:missing-estimate:4",
    ]);
  });

  it("warns when estimated subtasks leave part of the estimate unscheduled", () => {
    const issues = validatePlan(
      plan("- [ ] Test UN1 @est:40h ^T1", "  - [ ] Test IUNA @est:4h ^T2")
    ).filter((i) => i.code.startsWith("parent-estimate"));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      severity: "warning",
      code: "parent-estimate-unscheduled",
      data: { key: "est", remaining: "36h", total: "4h" },
    });
    expect(issues[0].message).toBe(
      "This task's @est is 40h, but its subtasks add up to 4h: 36h is not scheduled. Add a subtask for the rest, or set @est to the subtasks' total."
    );
  });

  it("notes when the subtasks need more than the parent's estimate", () => {
    const issues = validatePlan(
      plan("- [/] Define architecture @est:6h @started:2026-10-01 ^T1", "  - [ ] A @est:32h ^T2")
    ).filter((i) => i.code.startsWith("parent-estimate"));
    expect(issues.map((i) => [i.severity, i.code, i.data?.total])).toEqual([
      ["info", "parent-estimate-exceeded", "32h"],
    ]);
  });

  it("does not check finished parents", () => {
    expect(
      codes("- [x] P @est:40h @done:2026-10-01 ^T1", "  - [x] A @est:4h @done:2026-10-01 ^T2")
    ).toEqual([]);
  });
});

describe("parent and subtask status", () => {
  it("flags a done parent with open subtasks and an open parent whose subtasks are all done", () => {
    expect(
      codes(
        "- [x] Done parent @done:2026-10-01 ^T1",
        "  - [ ] Open child @est:1h ^T2",
        "  - [/] Busy child @est:1h @started:2026-10-01 ^T3",
        "- [/] Open parent @started:2026-10-01 ^T4",
        "  - [x] A @est:1h @done:2026-10-01 ^T5",
        "  - [-] Cancelled @est:1h ^T6",
        "- [!] Blocked parent ^T7",
        "  - [x] B @est:1h @done:2026-10-01 ^T8"
      )
    ).toEqual([
      "info:missing-blocked-reason:8",
      "warning:done-parent-open-subtasks:2",
      "info:open-parent-all-done:5",
    ]);
  });

  const change = (lines: string[], id: string, status: Status, effects: StatusEffects) => {
    const p = plan(...lines);
    const f = p.file(PATH)!;
    const text = f.lines.serialize();
    return applyEdits(text, setStatus(f.lines, p.taskById(id)!, status, "2026-10-14", effects))
      .split("\n")
      .slice(2, 2 + lines.length);
  };

  it("moves a to-do parent to in progress when a subtask starts, up the tree", () => {
    expect(
      change(
        ["- [ ] Top ^T1", "  - [ ] Mid ^T2", "    - [ ] Leaf @est:1h ^T3", "    - [ ] Other ^T4"],
        "T3",
        "doing",
        { rollUp: true }
      )
    ).toEqual([
      "- [/] Top @started:2026-10-14 ^T1",
      "  - [/] Mid @started:2026-10-14 ^T2",
      "    - [/] Leaf @est:1h @started:2026-10-14 ^T3",
      "    - [ ] Other ^T4",
    ]);
  });

  it("finishes a parent with its last open subtask, and reopens it when a subtask reopens", () => {
    const lines = [
      "- [/] Parent @started:2026-10-01 ^T1",
      "  - [x] A @est:1h @done:2026-10-02 ^T2",
      "  - [/] B @est:1h @started:2026-10-01 ^T3",
      "  - [-] Dropped ^T4",
    ];
    const done = change(lines, "T3", "done", { rollUp: true });
    expect(done[0]).toBe("- [x] Parent @started:2026-10-01 @done:2026-10-14 ^T1");
    expect(done[2]).toBe("  - [x] B @est:1h @started:2026-10-01 @done:2026-10-14 ^T3");
    const reopened = change(done, "T2", "todo", { rollUp: true });
    expect(reopened[0]).toBe("- [/] Parent @started:2026-10-01 ^T1");
    // Without roll-up only the task changes.
    expect(change(lines, "T3", "done", {})[0]).toBe(lines[0]);
  });

  it("finishes or cancels open subtasks along with the parent, or keeps them", () => {
    const lines = [
      "- [/] Parent @started:2026-10-01 ^T1",
      "  - [ ] A @est:1h ^T2",
      "    - [/] A1 @est:1h @started:2026-10-01 ^T3",
      "  - [x] B @est:1h @done:2026-10-02 ^T4",
    ];
    expect(change(lines, "T1", "done", { subtasks: "done" })).toEqual([
      "- [x] Parent @started:2026-10-01 @done:2026-10-14 ^T1",
      "  - [x] A @est:1h @done:2026-10-14 ^T2",
      "    - [x] A1 @est:1h @started:2026-10-01 @done:2026-10-14 ^T3",
      "  - [x] B @est:1h @done:2026-10-02 ^T4",
    ]);
    expect(change(lines, "T1", "done", { subtasks: "cancelled" }).slice(1, 3)).toEqual([
      "  - [-] A @est:1h ^T2",
      "    - [-] A1 @est:1h @started:2026-10-01 ^T3",
    ]);
    expect(change(lines, "T1", "done", { subtasks: "keep" }).slice(1)).toEqual(lines.slice(1));
  });
});
