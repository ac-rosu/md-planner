import { describe, expect, it } from "vitest";
import { applyEdits, pos, type Position, range } from "../../../src/core/text";
import { type FileEdit, moveTask } from "../../../src/core/writer";
import {
  atOneLevel,
  type Move,
  outlineMove,
  outlineMoveAll,
  type OutlineMove,
  placeTask,
  positionAfterMove,
  selectedTasks,
  selectionAfterMove,
  type TextSelection,
} from "../../../src/core/writer/structure";
import { md, planFrom } from "../helpers";

const PATH = "milestones/M1.md";

const OUTLINE = md(
  "# M1",
  "",
  "## Build",
  "",
  "- [ ] A ^T1",
  "      Notes of A.",
  "  - [ ] A1 ^T2",
  "  - [ ] A2 ^T3",
  "        Notes of A2.",
  "- [ ] B ^T4",
  "- [ ] C ^T5",
  "",
  "## Test",
  "",
  "- [ ] D ^T6"
);

function run(text: string, id: string, move: OutlineMove): string {
  const p = planFrom({ [PATH]: text });
  const r = outlineMove(p, p.taskById(id)!, move);
  if ("reason" in r) return `refused: ${r.reason}`;
  return apply(text, r.edits);
}

function apply(text: string, edits: FileEdit[], path = PATH): string {
  return applyEdits(
    text,
    edits.filter((e) => e.path === path).flatMap((e) => e.edits)
  );
}

const body = (text: string) => text.split("\n").slice(4, 11);

function moved(r: Move | { reason: string }): Move {
  if ("reason" in r) throw new Error(r.reason);
  return r;
}

describe("outline moves", () => {
  it("moves a task with its notes and subtasks up and down among its siblings", () => {
    expect(body(run(OUTLINE, "T4", "up"))).toEqual([
      "- [ ] B ^T4",
      "- [ ] A ^T1",
      "      Notes of A.",
      "  - [ ] A1 ^T2",
      "  - [ ] A2 ^T3",
      "        Notes of A2.",
      "- [ ] C ^T5",
    ]);
    expect(run(OUTLINE, "T1", "down")).toBe(run(OUTLINE, "T4", "up"));
    expect(body(run(OUTLINE, "T3", "up")).slice(2, 5)).toEqual([
      "  - [ ] A2 ^T3",
      "        Notes of A2.",
      "  - [ ] A1 ^T2",
    ]);
  });

  it("indents a task under the one above and outdents it after its parent", () => {
    expect(body(run(OUTLINE, "T4", "indent"))).toEqual([
      "- [ ] A ^T1",
      "      Notes of A.",
      "  - [ ] A1 ^T2",
      "  - [ ] A2 ^T3",
      "        Notes of A2.",
      "  - [ ] B ^T4",
      "- [ ] C ^T5",
    ]);
    expect(body(run(OUTLINE, "T2", "outdent"))).toEqual([
      "- [ ] A ^T1",
      "      Notes of A.",
      "  - [ ] A2 ^T3",
      "        Notes of A2.",
      "- [ ] A1 ^T2",
      "- [ ] B ^T4",
      "- [ ] C ^T5",
    ]);
    // The notes move with a task, re-indented with it.
    expect(body(run(OUTLINE, "T3", "outdent")).slice(3, 6)).toEqual([
      "- [ ] A2 ^T3",
      "      Notes of A2.",
      "- [ ] B ^T4",
    ]);
  });

  it("stays within the section and says why a move is not possible", () => {
    expect(run(OUTLINE, "T1", "up")).toBe("refused: T1 is already the first task at its level.");
    expect(run(OUTLINE, "T5", "down")).toBe("refused: T5 is already the last task at its level.");
    expect(run(OUTLINE, "T6", "up")).toBe("refused: T6 is already the first task at its level.");
    expect(run(OUTLINE, "T2", "indent")).toBe(
      "refused: T2 has no task above it at its level to become a subtask of."
    );
    expect(run(OUTLINE, "T1", "outdent")).toBe("refused: T1 is not a subtask.");
  });

  it("keeps a file without a final line ending as it is", () => {
    const text = "# M1\n\n- [ ] A ^T1\n- [ ] B ^T2";
    expect(run(text, "T2", "up")).toBe("# M1\n\n- [ ] B ^T2\n- [ ] A ^T1");
    expect(run(text, "T2", "indent")).toBe("# M1\n\n- [ ] A ^T1\n  - [ ] B ^T2");
  });

  it("places a task before, after or under any task, also in another file", () => {
    const m2 = md("# M2", "", "- [ ] E ^T7");
    const p = planFrom({ [PATH]: OUTLINE, "milestones/M2.md": m2 });
    const t = (id: string) => p.taskById(id)!;
    const under = placeTask(p, t("T5"), t("T7"), "child");
    if ("reason" in under) throw new Error(under.reason);
    expect(apply(m2, under.edits, "milestones/M2.md")).toBe(
      md("# M2", "", "- [ ] E ^T7", "  - [ ] C ^T5")
    );
    expect(apply(OUTLINE, under.edits)).not.toContain("C ^T5");
    const before = placeTask(p, t("T6"), t("T1"), "before");
    if ("reason" in before) throw new Error(before.reason);
    expect(body(apply(OUTLINE, before.edits))[0]).toBe("- [ ] D ^T6");
    expect(placeTask(p, t("T1"), t("T3"), "child")).toEqual({
      reason: "T1 cannot move into itself or its own subtasks.",
    });
  });

  it("changes only the moved lines: a deletion and an insertion, or the indentation", () => {
    const p = planFrom({ [PATH]: OUTLINE });
    const edits = (id: string, move: OutlineMove) =>
      moved(outlineMove(p, p.taskById(id)!, move)).edits.flatMap((e) => e.edits);
    // B moves above the five lines of A: only the line of B is deleted and inserted.
    expect(edits("T4", "up")).toEqual([
      { range: { start: pos(9, 0), end: pos(10, 0) }, newText: "" },
      { range: range(4, 0, 0), newText: "- [ ] B ^T4\n" },
    ]);
    // Into the task right above, or out of the parent as its last subtask: only the indentation.
    expect(edits("T4", "indent")).toEqual([{ range: range(9, 0, 0), newText: "  " }]);
    expect(edits("T3", "outdent")).toEqual([
      { range: range(7, 0, 2), newText: "" },
      { range: range(8, 6, 8), newText: "" },
    ]);
  });

  it("only adds the heading when a task that ends the file moves to a new section there", () => {
    const later = (text: string, id: string) => {
      const p = planFrom({ [PATH]: text });
      const f = p.file(PATH)!;
      return moveTask(f, p.taskById(id)!, f, { kind: "section", title: "Later" });
    };
    // The whole file, without a heading or a final line ending.
    const brief = "- [ ] Draft the brief @est:2h ^T1\n      Notes of the brief.";
    expect(later(brief, "T1")[0].edits).toEqual([
      { range: range(0, 0, 0), newText: "\n## Later\n\n" },
    ]);
    expect(apply(brief, later(brief, "T1"))).toBe(
      "\n## Later\n\n- [ ] Draft the brief @est:2h ^T1\n      Notes of the brief."
    );
    // A subtask also loses its indentation.
    const sub = md("# M1", "", "- [ ] A ^T1", "  - [ ] A1 ^T2");
    expect(later(sub, "T2")[0].edits).toEqual([
      { range: range(3, 0, 0), newText: "\n## Later\n\n" },
      { range: range(3, 0, 2), newText: "" },
    ]);
    expect(apply(sub, later(sub, "T2"))).toBe(
      md("# M1", "", "- [ ] A ^T1", "", "## Later", "", "- [ ] A1 ^T2")
    );
  });

  it("says where a task lands, also without an id, so it can be moved again", () => {
    let text = md(
      "# M1",
      "",
      "- [ ] Parent ^T1",
      "  - [ ] Sub one",
      "        Note of sub one.",
      "  - [ ] Sub two",
      "  - [ ] Sub three"
    );
    let line = 3;
    for (const expected of [4, 5]) {
      const p = planFrom({ [PATH]: text });
      const r = moved(
        outlineMove(
          p,
          p.file(PATH)!.items.find((t) => t.line === line)!,
          "down"
        )
      );
      expect(r.moved.map((m) => [m.file, m.line, m.indent])).toEqual([[PATH, expected, "  "]]);
      text = apply(text, r.edits);
      line = expected;
    }
    expect(text).toBe(
      md(
        "# M1",
        "",
        "- [ ] Parent ^T1",
        "  - [ ] Sub two",
        "  - [ ] Sub three",
        "  - [ ] Sub one",
        "        Note of sub one."
      )
    );
    const p = planFrom({ [PATH]: OUTLINE, "milestones/M2.md": md("# M2", "", "- [ ] E ^T7") });
    const under = moved(placeTask(p, p.taskById("T1")!, p.taskById("T7")!, "child"));
    expect(under.moved.map((m) => [m.file, m.line, m.indent])).toEqual([
      ["milestones/M2.md", 3, "  "],
    ]);
  });

  it("warns before open work ends up under a cancelled or done task", () => {
    const p = planFrom({
      [PATH]: md(
        "# M1",
        "",
        "- [-] Old approach @est:8h ^T1",
        "- [ ] New approach @est:16h ^T2",
        "- [x] Setup @est:2h ^T3",
        "  - [ ] Leftover @est:1h ^T4",
        "- [ ] Next @est:4h ^T5"
      ),
      "milestones/M2.md": md("# M2", "", "status: cancelled", "", "- [ ] Kept @est:1h ^T9"),
    });
    const t = (id: string) => p.taskById(id)!;
    const warning = (r: Move | { reason: string }) => moved(r).warning;
    expect(warning(outlineMove(p, t("T2"), "indent"))).toBe(
      "T2 would end up under T1, which is cancelled, and no longer be scheduled."
    );
    expect(warning(outlineMove(p, t("T5"), "indent"))).toBe(
      "T5 would end up under T3, which is done, and no longer be scheduled."
    );
    expect(warning(placeTask(p, t("T5"), t("T4"), "after"))).toBe(
      "T5 would end up under T3, which is done, and no longer be scheduled."
    );
    expect(warning(placeTask(p, t("T2"), t("T9"), "before"))).toBe(
      "T2 would move into M2, which is cancelled, and no longer be scheduled."
    );
    // Nothing open leaves the schedule: a done task, a subtask that already was under a done
    // task, a move out of a done task, or a move next to an open task.
    expect(warning(outlineMove(p, t("T3"), "indent"))).toBeUndefined();
    expect(warning(placeTask(p, t("T4"), t("T1"), "child"))).toBeUndefined();
    expect(warning(outlineMove(p, t("T4"), "outdent"))).toBeUndefined();
    expect(warning(placeTask(p, t("T5"), t("T2"), "before"))).toBeUndefined();
    // Punch items are not scheduled at all.
    const punch = planFrom({
      "punchlist.md": md("# Punch list", "", "- [x] Done ^P1", "- [ ] Open ^P2"),
    });
    expect(warning(outlineMove(punch, punch.punchById("P2")!, "indent"))).toBeUndefined();
  });

  it("moves the tasks of several cursors at once, consecutive siblings together", () => {
    const p = planFrom({ [PATH]: OUTLINE });
    const run = (ids: string[], move: OutlineMove) => {
      const r = outlineMoveAll(
        p,
        ids.map((id) => p.taskById(id)!),
        move
      );
      return "reason" in r ? `refused: ${r.reason}` : body(apply(OUTLINE, r.edits));
    };
    expect(run(["T4", "T5"], "up")).toEqual([
      "- [ ] B ^T4",
      "- [ ] C ^T5",
      "- [ ] A ^T1",
      "      Notes of A.",
      "  - [ ] A1 ^T2",
      "  - [ ] A2 ^T3",
      "        Notes of A2.",
    ]);
    // Tasks at different levels each move among their own siblings.
    expect(run(["T2", "T4"], "down")).toEqual([
      "- [ ] A ^T1",
      "      Notes of A.",
      "  - [ ] A2 ^T3",
      "        Notes of A2.",
      "  - [ ] A1 ^T2",
      "- [ ] C ^T5",
      "- [ ] B ^T4",
    ]);
    // A subtask of a selected task moves with it; a task that is already last stays.
    expect(run(["T1", "T2"], "down")).toEqual(run(["T1"], "down"));
    expect(run(["T3", "T4"], "down")).toEqual(run(["T4"], "down"));
    expect(run(["T4", "T5"], "down")).toBe("refused: T5 is already the last task at its level.");
    expect(run(["T2", "T3"], "indent")).toBe(
      "refused: T2 has no task above it at its level to become a subtask of."
    );
    expect(run(["T4", "T5"], "indent")).toEqual([
      "- [ ] A ^T1",
      "      Notes of A.",
      "  - [ ] A1 ^T2",
      "  - [ ] A2 ^T3",
      "        Notes of A2.",
      "  - [ ] B ^T4",
      "  - [ ] C ^T5",
    ]);
  });

  it("outdents subtasks of one parent in their order", () => {
    const text = md(
      "# M1",
      "",
      "- [ ] Q ^T1",
      "  - [ ] C1 ^T2",
      "  - [ ] C2 ^T3",
      "  - [ ] C3 ^T4",
      "- [ ] R ^T5"
    );
    const p = planFrom({ [PATH]: text });
    const r = moved(outlineMoveAll(p, [p.taskById("T4")!, p.taskById("T2")!], "outdent"));
    expect(apply(text, r.edits)).toBe(
      md("# M1", "", "- [ ] Q ^T1", "  - [ ] C2 ^T3", "- [ ] C1 ^T2", "- [ ] C3 ^T4", "- [ ] R ^T5")
    );
  });

  it("inserts between moved blocks, also at the end of a file without a final line ending", () => {
    const outdent = (text: string, ids: string[]) => {
      const p = planFrom({ [PATH]: text });
      const r = moved(
        outlineMoveAll(
          p,
          ids.map((id) => p.taskById(id)!),
          "outdent"
        )
      );
      return apply(text, r.edits);
    };
    expect(
      outdent(
        md(
          "# M1",
          "",
          "- [ ] P ^T1",
          "  - [ ] C1 ^T2",
          "  - [ ] Q ^T3",
          "    - [ ] D1 ^T4",
          "    - [ ] D2 ^T5",
          "    - [ ] D3 ^T6",
          "  - [ ] C2 ^T7",
          "- [ ] R ^T8"
        ),
        ["T2", "T4", "T6", "T7"]
      )
    ).toBe(
      md(
        "# M1",
        "",
        "- [ ] P ^T1",
        "  - [ ] Q ^T3",
        "    - [ ] D2 ^T5",
        "  - [ ] D1 ^T4",
        "  - [ ] D3 ^T6",
        "- [ ] C1 ^T2",
        "- [ ] C2 ^T7",
        "- [ ] R ^T8"
      )
    );
    expect(
      outdent(
        "# M1\n\n- [ ] W ^T1\n  - [ ] A ^T2\n  - [ ] Q ^T3\n    - [ ] C1 ^T4\n    - [ ] C2 ^T5\n  - [ ] B ^T6",
        ["T2", "T4", "T6"]
      )
    ).toBe(
      "# M1\n\n- [ ] W ^T1\n  - [ ] Q ^T3\n    - [ ] C2 ^T5\n  - [ ] C1 ^T4\n- [ ] A ^T2\n- [ ] B ^T6"
    );
  });

  it("keeps a subtask that moves to the end of its parent inside it", () => {
    const text = md("# M1", "", "- [ ] A ^T1", "- [ ] N ^T2", "  - [ ] N1 ^T3", "  - [ ] N2 ^T4");
    const p = planFrom({ [PATH]: text });
    const r = moved(outlineMoveAll(p, [p.taskById("T1")!, p.taskById("T3")!], "down"));
    expect(apply(text, r.edits)).toBe(
      md("# M1", "", "- [ ] N ^T2", "  - [ ] N2 ^T4", "  - [ ] N1 ^T3", "- [ ] A ^T1")
    );
    expect(r.moved.map((m) => [m.task.id, m.line])).toEqual([
      ["T1", 5],
      ["T3", 4],
    ]);
  });

  it("moves several tasks at the end of a file without a final line ending", () => {
    const text = "# M1\n\n- [ ] A ^T1\n- [ ] B ^T2\n- [ ] C ^T3";
    const p = planFrom({ [PATH]: text });
    const run = (ids: string[], move: OutlineMove) =>
      apply(
        text,
        moved(
          outlineMoveAll(
            p,
            ids.map((id) => p.taskById(id)!),
            move
          )
        ).edits
      );
    expect(run(["T2", "T3"], "up")).toBe("# M1\n\n- [ ] B ^T2\n- [ ] C ^T3\n- [ ] A ^T1");
    expect(run(["T1", "T2"], "down")).toBe("# M1\n\n- [ ] C ^T3\n- [ ] A ^T1\n- [ ] B ^T2");
    expect(run(["T2", "T3"], "indent")).toBe("# M1\n\n- [ ] A ^T1\n  - [ ] B ^T2\n  - [ ] C ^T3");
  });

  it("lets cursors follow the moved tasks", () => {
    const p = planFrom({ [PATH]: OUTLINE });
    const up = moved(outlineMove(p, p.taskById("T4")!, "up"));
    expect(positionAfterMove(up, PATH, pos(9, 3))).toEqual(pos(4, 3));
    expect(positionAfterMove(up, PATH, pos(5, 2))).toEqual(pos(6, 2));
    expect(positionAfterMove(up, PATH, pos(10, 0))).toEqual(pos(10, 0));
    const indent = moved(outlineMove(p, p.taskById("T4")!, "indent"));
    expect(positionAfterMove(indent, PATH, pos(9, 4))).toEqual(pos(9, 6));
    const out = moved(outlineMove(p, p.taskById("T2")!, "outdent"));
    expect(positionAfterMove(out, PATH, pos(6, 8))).toEqual(pos(8, 6));
    expect(positionAfterMove(out, PATH, pos(7, 0))).toEqual(pos(6, 0));
  });

  it("takes the tasks of a selection as VS Code's line moves take lines", () => {
    const p = planFrom({ [PATH]: OUTLINE });
    const take = (anchor: Position, active = anchor, around = false) => {
      const r = selectedTasks(p.file(PATH)!, { anchor, active }, around);
      return { tasks: r.tasks.map((t) => t.id), other: r.other };
    };
    // A cursor, a selection in a line, whole lines: an end at the start of a line leaves it out.
    expect(take(pos(9, 3))).toEqual({ tasks: ["T4"], other: false });
    expect(take(pos(9, 0), pos(10, 0))).toEqual({ tasks: ["T4"], other: false });
    expect(take(pos(10, 0), pos(9, 0))).toEqual({ tasks: ["T4"], other: false });
    expect(take(pos(9, 0), pos(10, 1))).toEqual({ tasks: ["T4", "T5"], other: false });
    // Subtasks go along with their parent; the notes of the task above are other lines.
    expect(take(pos(4, 0), pos(9, 0))).toEqual({ tasks: ["T1"], other: false });
    expect(take(pos(8, 2), pos(9, 2))).toEqual({ tasks: ["T4"], other: true });
    // Notes alone take nothing, or with `around` their task, also as the whole last note line.
    expect(take(pos(5, 2))).toEqual({ tasks: [], other: true });
    expect(take(pos(5, 2), pos(5, 2), true)).toEqual({ tasks: ["T1"], other: false });
    expect(take(pos(8, 0), pos(9, 0), true)).toEqual({ tasks: ["T3"], other: false });
    const t = (id: string) => p.taskById(id)!;
    expect(atOneLevel([t("T2"), t("T3")])).toBe(true);
    expect(atOneLevel([t("T3"), t("T4")])).toBe(false);
    expect(atOneLevel([t("T5"), t("T6")])).toBe(false);
  });

  it("keeps a selection on the tasks it moves, so the next press moves them again", () => {
    let text = md("# M1", "", "- [ ] A ^T1", "- [ ] B ^T2", "- [ ] C ^T3", "- [ ] D ^T4");
    let sel: TextSelection = { anchor: pos(2, 0), active: pos(3, 0) };
    const press = (move: OutlineMove) => {
      const p = planFrom({ [PATH]: text });
      const tasks = selectedTasks(p.file(PATH)!, sel).tasks;
      const r = moved(outlineMoveAll(p, tasks, move));
      text = apply(text, r.edits);
      sel = selectionAfterMove(r, PATH, sel, tasks);
      return tasks.map((x) => x.id);
    };
    // The whole line of A (Cmd+L): its end, at the start of the next line, stays after A.
    expect(press("down")).toEqual(["T1"]);
    expect(sel).toEqual({ anchor: pos(3, 0), active: pos(4, 0) });
    expect(press("down")).toEqual(["T1"]);
    expect(text).toBe(md("# M1", "", "- [ ] B ^T2", "- [ ] C ^T3", "- [ ] A ^T1", "- [ ] D ^T4"));
    expect(sel).toEqual({ anchor: pos(4, 0), active: pos(5, 0) });
    // Two whole lines, selected upwards: they move together and stay selected.
    sel = { anchor: pos(5, 0), active: pos(3, 0) };
    expect(press("up")).toEqual(["T3", "T1"]);
    expect(text).toBe(md("# M1", "", "- [ ] C ^T3", "- [ ] A ^T1", "- [ ] B ^T2", "- [ ] D ^T4"));
    expect(sel).toEqual({ anchor: pos(4, 0), active: pos(2, 0) });
    expect(press("down")).toEqual(["T3", "T1"]);
    expect(sel).toEqual({ anchor: pos(5, 0), active: pos(3, 0) });
    expect(press("up")).toEqual(["T3", "T1"]);
    // Indent and outdent keep whole lines whole, and a selection in the text on its lines.
    sel = { anchor: pos(3, 0), active: pos(5, 0) };
    expect(press("indent")).toEqual(["T1", "T2"]);
    expect(text).toBe(
      md("# M1", "", "- [ ] C ^T3", "  - [ ] A ^T1", "  - [ ] B ^T2", "- [ ] D ^T4")
    );
    expect(sel).toEqual({ anchor: pos(3, 0), active: pos(5, 0) });
    sel = { anchor: pos(3, 1), active: pos(4, 1) };
    expect(press("outdent")).toEqual(["T1", "T2"]);
    expect(sel).toEqual({ anchor: pos(3, 0), active: pos(4, 1) });
    expect(press("indent")).toEqual(["T1", "T2"]);
    expect(text).toBe(
      md("# M1", "", "- [ ] C ^T3", "  - [ ] A ^T1", "  - [ ] B ^T2", "- [ ] D ^T4")
    );
  });

  it("keeps blank lines between tasks that only change their level", () => {
    const text = md("# M1", "", "- [ ] P ^T1", "  - [ ] A ^T2", "", "  - [ ] B ^T3", "- [ ] R ^T4");
    const p = planFrom({ [PATH]: text });
    const out = moved(outlineMoveAll(p, [p.taskById("T2")!, p.taskById("T3")!], "outdent"));
    const outdented = md(
      "# M1",
      "",
      "- [ ] P ^T1",
      "- [ ] A ^T2",
      "",
      "- [ ] B ^T3",
      "- [ ] R ^T4"
    );
    expect(apply(text, out.edits)).toBe(outdented);
    expect(out.edits[0].edits).toEqual([
      { range: range(3, 0, 2), newText: "" },
      { range: range(5, 0, 2), newText: "" },
    ]);
    // As when B goes first and then A.
    expect(run(run(text, "T3", "outdent"), "T2", "outdent")).toBe(outdented);
    const q = planFrom({ [PATH]: outdented });
    const back = moved(outlineMoveAll(q, [q.taskById("T2")!, q.taskById("T3")!], "indent"));
    expect(apply(outdented, back.edits)).toBe(text);
    // Also at the end of a file without a final line ending.
    const last = "# M1\n\n- [ ] P ^T1\n  - [ ] A ^T2\n\n  - [ ] B ^T3";
    const e = planFrom({ [PATH]: last });
    const end = moved(outlineMoveAll(e, [e.taskById("T2")!, e.taskById("T3")!], "outdent"));
    expect(apply(last, end.edits)).toBe("# M1\n\n- [ ] P ^T1\n- [ ] A ^T2\n\n- [ ] B ^T3");
    expect(end.moved.map((m) => m.line)).toEqual([3, 5]);
  });
});
