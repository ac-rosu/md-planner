// What the writer and the parser do with slips made while typing in a plan file: a note typed with
// Enter, a code block left open, a copied id, a new task saved before it has a title.
import { describe, expect, it } from "vitest";
import { type Status } from "../../../src/core/model";
import { applyEdits } from "../../../src/core/text";
import {
  assignMissingIds,
  endsInOpenFence,
  type FileEdit,
  reindent,
  renameIdProblem,
  setStatus,
  sharedIdProblem,
} from "../../../src/core/writer";
import { type OutlineMove, outlineMove, placeTask } from "../../../src/core/writer/structure";
import { md, milestone, planFrom } from "../helpers";

const PATH = "milestones/M1.md";

const issuesOf = (text: string, code: string) =>
  milestone(text, PATH).issues.filter((i) => i.code === code);

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

describe("a note typed with Enter", () => {
  it("is pointed out when it is not indented under the task above it", () => {
    const text = md(
      "# M1",
      "",
      "- [ ] Root task ^T110",
      "Typed with Enter under a top-level task.",
      "- [ ] Parent ^T102",
      "  - [ ] Subtask ^T103",
      "  Typed with Enter under a subtask."
    );
    const hints = issuesOf(text, "note-not-indented");
    expect(hints.map((h) => [h.range.start.line, h.severity])).toEqual([
      [3, "hint"],
      [6, "hint"],
    ]);
    expect(hints[0].message).toBe(
      "Not a note of T110: it is not indented under it, so it is read as text outside the task. Indent it to make it a note of T110, or put a blank line above it."
    );
    expect(hints[1].message).toContain("so it is read as a note of T102");
    // Under the task's title, where the quick fix puts it.
    expect(hints.map((h) => h.data)).toEqual([
      { indent: "      ", task: "T110" },
      { indent: "        ", task: "T103" },
    ]);
    expect(hints[1].range).toEqual({
      start: { line: 6, character: 2 },
      end: { line: 6, character: 35 },
    });
  });

  it("is read as before: the hint changes nothing in the plan", () => {
    const text = md("# M1", "", "- [ ] Parent ^T102", "  - [ ] Subtask ^T103", "  Typed.");
    const f = milestone(text, PATH);
    const [parent, sub] = f.items;
    expect(parent.notes).toEqual([{ line: 4, text: "Typed." }]);
    expect(sub.notes).toEqual([]);
    expect(f.lines.serialize()).toBe(text);
  });

  it("takes the indentation of the task's notes", () => {
    const text = md("# M1", "", "- [ ] A ^T1", "  First note.", "Second line.");
    expect(issuesOf(text, "note-not-indented").map((h) => h.data)).toEqual([
      { indent: "  ", task: "T1" },
    ]);
  });

  it("is not pointed out after a blank line, for indented notes, fences, comments and headings", () => {
    const text = md(
      "# M1",
      "",
      "- [ ] A ^T1",
      "      A note.",
      "",
      "Free text after a blank line.",
      "- [ ] B ^T2",
      "## Section",
      "- [ ] C ^T3",
      "<!-- a comment -->",
      "- [ ] D ^T4",
      "```",
      "code",
      "```",
      "- [ ] E ^T5",
      "  - [ ] E1 ^T6",
      "        A note of E1.",
      "    Less indented, but deeper than E1: also a note of E1."
    );
    expect(issuesOf(text, "note-not-indented")).toEqual([]);
  });
});

describe("a code block left open", () => {
  const OPEN = md(
    "# M1",
    "",
    "## S1",
    "",
    "- [ ] A ^T1",
    "- [ ] B ^T2",
    "      ```",
    "      some code",
    "- [ ] C ^T3",
    "",
    "## S2",
    "",
    "- [ ] D ^T4"
  );

  it("is a warning when it hides tasks or headings", () => {
    const [w] = issuesOf(OPEN, "unclosed-fence");
    expect(w).toMatchObject({
      severity: "warning",
      range: { start: { line: 6, character: 6 }, end: { line: 6, character: 9 } },
    });
    expect(w.message).toBe(
      "This code block (```) is never closed, so everything below it to the end of the file is read as code: the 2 task lines and 1 heading below it are not read. Close it with a ``` line where the code ends."
    );
    // Closed, or hiding only text: nothing to say.
    expect(
      issuesOf(OPEN.replace("      some code\n", "      some code\n      ```\n"), "unclosed-fence")
    ).toEqual([]);
    expect(issuesOf(md("# M1", "", "- [ ] A ^T1", "  ```", "  code"), "unclosed-fence")).toEqual(
      []
    );
  });

  it("stops outline moves of the block it runs to the end of the file", () => {
    const p = planFrom({ [PATH]: OPEN });
    expect(endsInOpenFence(p.file(PATH)!.lines, p.taskById("T2")!)).toBe(true);
    expect(endsInOpenFence(p.file(PATH)!.lines, p.taskById("T1")!)).toBe(false);
    const reason =
      "refused: A code block (```) in the notes under T2 is never closed, so everything below it to the end of the file counts as part of T2. Close the code block first, then move the task.";
    expect(run(OPEN, "T2", "up")).toBe(reason);
    // A moves after B's block, which ends at the end of the file.
    expect(run(OPEN, "T1", "down")).toBe(reason);
    expect(run(OPEN, "T2", "indent")).toBe(reason);
    const t = (id: string) => p.taskById(id)!;
    expect(placeTask(p, t("T2"), t("T1"), "before")).toEqual({ reason: reason.slice(9) });
    expect(placeTask(p, t("T1"), t("T2"), "after")).toEqual({ reason: reason.slice(9) });
    // Before it is fine.
    expect("reason" in placeTask(p, t("T1"), t("T2"), "before")).toBe(false);
  });
});

describe("moving a block", () => {
  const CODE = md(
    "# M1",
    "",
    "- [ ] A ^T1",
    "  - [ ] A1 ^T2",
    "        ```yaml",
    "key:",
    "  value: 1",
    "        ```",
    "        ",
    "        After a line of spaces.",
    "  - [ ] A2 ^T3"
  );

  it("leaves the lines of a task that keeps its indentation untouched", () => {
    expect(run(CODE, "T2", "down")).toBe(
      md(
        "# M1",
        "",
        "- [ ] A ^T1",
        "  - [ ] A2 ^T3",
        "  - [ ] A1 ^T2",
        "        ```yaml",
        "key:",
        "  value: 1",
        "        ```",
        "        ",
        "        After a line of spaces."
      )
    );
    expect(reindent(["  - [ ] X", "code", "   "], "  ", "  ")).toEqual([
      "  - [ ] X",
      "code",
      "   ",
    ]);
  });

  it("re-indents the lines indented with the block, not code less indented or blank lines", () => {
    expect(run(CODE, "T2", "outdent")).toBe(
      md(
        "# M1",
        "",
        "- [ ] A ^T1",
        "  - [ ] A2 ^T3",
        "- [ ] A1 ^T2",
        "      ```yaml",
        "key:",
        "  value: 1",
        "      ```",
        "        ",
        "      After a line of spaces."
      )
    );
    expect(reindent(["- [ ] X", "  ```", "code", "  ```", "  note"], "", "  ")).toEqual([
      "  - [ ] X",
      "    ```",
      "  code",
      "    ```",
      "    note",
    ]);
    // Code indented as deep as the block moves with it, keeping its own indentation.
    expect(reindent(["  - [ ] X", "    ```", "    a:", "      b: 1", "    ```"], "  ", "")).toEqual(
      ["- [ ] X", "  ```", "  a:", "    b: 1", "  ```"]
    );
  });
});

describe("ids", () => {
  it("are not given to a task without a title, nor to those the caller skips", () => {
    const text = md(
      "# M1",
      "",
      "- [ ] ",
      "- [ ] @est:4h",
      "- [ ] Write docs @est:",
      "- [ ] Test ^T1"
    );
    const p = planFrom({ [PATH]: text });
    const f = p.file(PATH)!;
    expect(applyEdits(text, assignMissingIds(p, f))).toBe(
      md("# M1", "", "- [ ] ", "- [ ] @est:4h", "- [ ] Write docs @est: ^T2", "- [ ] Test ^T1")
    );
    const reserved = new Set<string>();
    expect(assignMissingIds(p, f, reserved, (t) => t.line === 4)).toEqual([]);
    expect(reserved.size).toBe(0);
  });

  it("are not renamed when shared by copies, nor to a case variant of another id", () => {
    const p = planFrom({
      [PATH]: md(
        "# M1",
        "",
        "- [ ] A ^T111",
        "- [ ] B ^T112",
        "- [ ] B again ^T112",
        "- [ ] C @dep:T112 ^T113"
      ),
    });
    expect(sharedIdProblem(p, "T112")).toBe(
      'T112 is the id of 2 items: a copied line keeps its id. Give the copy its own id first (the quick fix "Give this task a new id" on its ^T112), then rename.'
    );
    expect(renameIdProblem(p, "T112", "T150")).toBe(sharedIdProblem(p, "T112"));
    expect(sharedIdProblem(p, "T111")).toBeUndefined();
    expect(renameIdProblem(p, "T113", "t111")).toBe(
      "The id T111 is already in use, and ids do not differ by case only."
    );
    expect(renameIdProblem(p, "T113", "T111")).toBe("The id T111 is already in use.");
    expect(renameIdProblem(p, "T113", "T150")).toBeUndefined();
    // Its own id in another case is fine.
    expect(renameIdProblem(p, "T113", "t113")).toBeUndefined();
  });
});

describe("parents that follow their subtasks", () => {
  const change = (lines: string[], id: string, status: Status) => {
    const p = planFrom({ [PATH]: md("# M1", "", ...lines) });
    const f = p.file(PATH)!;
    const edits = setStatus(f.lines, p.taskById(id)!, status, "2026-10-14", { rollUp: true });
    return applyEdits(f.lines.serialize(), edits)
      .split("\n")
      .slice(2, 2 + lines.length);
  };

  it("are done when their last subtask was done, as its date says", () => {
    const lines = [
      "- [ ] Top ^T1",
      "  - [/] Parent @started:2026-10-01 ^T2",
      "    - [x] A @done:2026-10-05 ^T3",
      "    - [/] B @started:2026-10-02 @done:2026-10-08 ^T4",
      "    - [-] Dropped @done:2026-10-30 ^T5",
    ];
    // B kept the date it was given.
    expect(change(lines, "T4", "done").slice(0, 2)).toEqual([
      "- [x] Top @done:2026-10-08 ^T1",
      "  - [x] Parent @started:2026-10-01 @done:2026-10-08 ^T2",
    ]);
    // Without a date on a subtask: today, as before.
    const undated = [lines[0], lines[1], "    - [x] A ^T3", lines[3]];
    expect(change(undated, "T4", "done")[1]).toBe(
      "  - [x] Parent @started:2026-10-01 @done:2026-10-14 ^T2"
    );
    // A subtask finished now is done today, the latest date.
    expect(change([lines[1], lines[2], "    - [ ] C ^T6"], "T6", "done")[0]).toBe(
      "  - [x] Parent @started:2026-10-01 @done:2026-10-14 ^T2"
    );
    // Never done before it started: today, as before.
    const late = ["- [/] Parent @started:2026-10-10 ^T2", "  - [/] A @done:2026-10-08 ^T3"];
    expect(change(late, "T3", "done")[0]).toBe(
      "- [x] Parent @started:2026-10-10 @done:2026-10-14 ^T2"
    );
  });

  it("are in progress since their first subtask started", () => {
    const lines = [
      "- [ ] Top ^T1",
      "  - [ ] Parent ^T2",
      "    - [x] A @started:2026-10-03 @done:2026-10-05 ^T3",
      "    - [ ] B ^T4",
      "    - [-] Dropped @started:2026-09-01 ^T5",
    ];
    expect(change(lines, "T4", "doing").slice(0, 4)).toEqual([
      "- [/] Top @started:2026-10-03 ^T1",
      "  - [/] Parent @started:2026-10-03 ^T2",
      lines[2],
      "    - [/] B @started:2026-10-14 ^T4",
    ]);
    // Reopened: the parent takes the earliest start of its subtasks.
    const done = [
      "- [x] Parent @done:2026-10-06 ^T2",
      "  - [x] A @started:2026-10-03 @done:2026-10-05 ^T3",
      "  - [x] B @started:2026-10-04 @done:2026-10-06 ^T4",
    ];
    expect(change(done, "T4", "doing")).toEqual([
      "- [/] Parent @started:2026-10-03 ^T2",
      done[1],
      "  - [/] B @started:2026-10-04 ^T4",
    ]);
    // Without dates: today, as before.
    expect(change(["- [x] Parent ^T2", "  - [x] A ^T3"], "T3", "doing")[0]).toBe(
      "- [/] Parent @started:2026-10-14 ^T2"
    );
  });
});
