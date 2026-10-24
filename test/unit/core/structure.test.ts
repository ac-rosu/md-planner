import { describe, expect, it } from "vitest";
import { applyEdits } from "../../../src/core/text";
import { type FileEdit } from "../../../src/core/writer";
import { outlineMove, placeTask, type OutlineMove } from "../../../src/core/writer/structure";
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
  const r = outlineMove(p.file(PATH)!, p.taskById(id)!, move);
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
});
