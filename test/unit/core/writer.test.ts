// Golden edit tests: every writer operation changes only the characters it targets.
import { describe, expect, it } from "vitest";
import { parseFileAs } from "../../../src/core/parser/files";
import { applyEdits, type TextEdit } from "../../../src/core/text";
import {
  addDependency,
  addProperty,
  addTag,
  appendSection,
  assignMissingIds,
  deleteTask,
  formatTaskBlock,
  insertTasks,
  moveTask,
  nextId,
  nextStatus,
  readNotes,
  removeDependency,
  removeProperty,
  removeTag,
  renameTaskId,
  renumberCopiedIds,
  replaceLines,
  setAttr,
  setId,
  setProperty,
  setStatus,
  setTitle,
  setNotes,
} from "../../../src/core/writer";
import { indexFrom, md, TODAY } from "../helpers";

const M2 = md(
  "# M2 – Backend",
  "",
  "id: M2",
  "target: 2026-12-15",
  "status: active # planned | active | done | cancelled",
  "depends: M1",
  "",
  "Short description of the milestone scope (free text).",
  "",
  "## Checkout",
  "",
  "- [x] Data model & API contract @est:4h @act:5h @owner:alex @done:2026-10-09 ^T101",
  "- [/] Order state machine @est:12h @owner:sam @dep:T101 #checkout ^T102",
  "  - [x] State transitions @est:6h ^T103",
  "  - [ ] Order events schema @est:6h ^T104",
  "        Notes indented under a task are its description.",
  "- [ ] Payment provider integration @est:2d @owner:sam @start:2026-11-10 @prio:high ^T105",
  '- [!] Payment form @est:6h @owner:priya #frontend @blocked:"waiting for the payment provider API keys" ^T106',
  "",
  "## Notes",
  "",
  "Free text is allowed anywhere and is preserved."
);

function setup(text = M2) {
  const index = indexFrom({
    "milestones/M2.md": text,
    "inbox.md": md("# Inbox", "", "- [ ] Quick idea @est:2h #idea", "  with a note"),
  });
  const plan = index.plan;
  const file = plan.file("milestones/M2.md")!;
  const t = (id: string) => plan.taskById(id)!;
  const run = (edits: TextEdit[]) => applyEdits(file.lines.serialize(), edits);
  return { index, plan, file, t, run };
}

/** The single changed region between two strings. */
function changed(before: string, after: string): { removed: string; inserted: string } {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (
    s < before.length - p &&
    s < after.length - p &&
    before[before.length - 1 - s] === after[after.length - 1 - s]
  )
    s++;
  return {
    removed: before.slice(p, before.length - s),
    inserted: after.slice(p, after.length - s),
  };
}

function lineOf(text: string, id: string): string {
  return text.split(/\r?\n/).find((l) => l.endsWith(`^${id}`) || l.includes(`^${id} `))!;
}

describe("task line edits", () => {
  it("changes an estimate by touching only its value", () => {
    const { file, t, run } = setup();
    const edits = setAttr(file.lines, t("T104"), "est", "8h");
    expect(edits).toHaveLength(1);
    expect(edits[0].range.end.character - edits[0].range.start.character).toBe(1);
    const out = run(edits);
    expect(changed(M2, out)).toEqual({ removed: "6", inserted: "8" });
    expect(lineOf(out, "T104")).toBe("  - [ ] Order events schema @est:8h ^T104");
  });

  it("adds a new attribute right before the id", () => {
    const { file, t, run } = setup();
    const out = run(setAttr(file.lines, t("T104"), "owner", "sam"));
    expect(out.length - M2.length).toBe(" @owner:sam".length);
    expect(lineOf(out, "T104")).toBe("  - [ ] Order events schema @est:6h @owner:sam ^T104");
  });

  it("quotes values with spaces and escapes quotes", () => {
    const { file, t, run } = setup();
    const out = run(setAttr(file.lines, t("T105"), "note", 'say "hi" now'));
    expect(lineOf(out, "T105")).toBe(
      '- [ ] Payment provider integration @est:2d @owner:sam @start:2026-11-10 @prio:high @note:"say \\"hi\\" now" ^T105'
    );
    const reparsed = parseFileAs("m.md", out, "milestone");
    expect(
      reparsed.items.find((i) => i.line === t("T105").line)!.attrs.find((a) => a.key === "note")!
        .value
    ).toBe('say "hi" now');
  });

  it("removes an attribute with its leading space", () => {
    const { file, t, run } = setup();
    const out = run(setAttr(file.lines, t("T105"), "start", undefined));
    expect(M2.length - out.length).toBe(" @start:2026-11-10".length);
    expect(changed(M2, out).inserted).toBe("");
    expect(lineOf(out, "T105")).toBe(
      "- [ ] Payment provider integration @est:2d @owner:sam @prio:high ^T105"
    );
  });

  it("replaces a quoted value", () => {
    const { file, t, run } = setup();
    const out = run(
      setAttr(file.lines, t("T106"), "blocked", "datasheets received, waiting for PO")
    );
    expect(lineOf(out, "T106")).toBe(
      '- [!] Payment form @est:6h @owner:priya #frontend @blocked:"datasheets received, waiting for PO" ^T106'
    );
  });

  it("starting a task writes @started", () => {
    const { file, t, run } = setup();
    const out = run(setStatus(file.lines, t("T104"), "doing", TODAY));
    expect(lineOf(out, "T104")).toBe(
      "  - [/] Order events schema @est:6h @started:2026-10-14 ^T104"
    );
  });

  it("completing a task writes @done and keeps an existing @started", () => {
    const { file, t, run } = setup();
    const out = run(setStatus(file.lines, t("T102"), "done", TODAY));
    expect(lineOf(out, "T102")).toBe(
      "- [x] Order state machine @est:12h @owner:sam @dep:T101 @done:2026-10-14 #checkout ^T102"
    );
    expect(setStatus(file.lines, t("T101"), "done", TODAY)).toEqual([]);
  });

  it("reopening a done task removes @done", () => {
    const { file, t, run } = setup();
    const out = run(setStatus(file.lines, t("T101"), "todo", TODAY));
    expect(changed(M2, out)).toEqual({
      removed: "x] Data model & API contract @est:4h @act:5h @owner:alex @done:2026-10-09",
      inserted: " ] Data model & API contract @est:4h @act:5h @owner:alex",
    });
    expect(lineOf(out, "T101")).toBe(
      "- [ ] Data model & API contract @est:4h @act:5h @owner:alex ^T101"
    );
  });

  it("unblocking removes @blocked; blocking with a reason adds it", () => {
    const { file, t, run } = setup();
    expect(lineOf(run(setStatus(file.lines, t("T106"), "doing", TODAY)), "T106")).toBe(
      "- [/] Payment form @est:6h @owner:priya @started:2026-10-14 #frontend ^T106"
    );
    expect(
      lineOf(
        run(setStatus(file.lines, t("T105"), "blocked", TODAY, { blockedReason: "no PO" })),
        "T105"
      )
    ).toBe(
      '- [!] Payment provider integration @est:2d @owner:sam @start:2026-11-10 @prio:high @blocked:"no PO" ^T105'
    );
  });

  it("cycles statuses in the documented order", () => {
    expect(
      ["todo", "doing", "review", "done", "blocked", "cancelled"].map((s) => nextStatus(s as never))
    ).toEqual(["doing", "review", "done", "todo", "doing", "todo"]);
  });

  it("edits the title only", () => {
    const { file, t, run } = setup();
    const out = run(setTitle(file.lines, t("T105"), "Payment provider and refund integration"));
    expect(changed(M2, out)).toEqual({ removed: "", inserted: "and refund " });
  });

  it("adds and removes tags", () => {
    const { file, t, run } = setup();
    expect(lineOf(run(addTag(file.lines, t("T104"), "#backend")), "T104")).toBe(
      "  - [ ] Order events schema @est:6h #backend ^T104"
    );
    expect(addTag(file.lines, t("T102"), "checkout")).toEqual([]);
    expect(lineOf(run(removeTag(file.lines, t("T106"), "frontend")), "T106")).toBe(
      '- [!] Payment form @est:6h @owner:priya @blocked:"waiting for the payment provider API keys" ^T106'
    );
  });

  it("adds and removes dependencies", () => {
    const { file, t, run } = setup();
    expect(lineOf(run(addDependency(file.lines, t("T102"), "T105")), "T102")).toContain(
      "@dep:T101,T105 "
    );
    expect(addDependency(file.lines, t("T102"), "T101")).toEqual([]);
    expect(lineOf(run(removeDependency(file.lines, t("T102"), "T101")), "T102")).toBe(
      "- [/] Order state machine @est:12h @owner:sam #checkout ^T102"
    );
  });

  it("works on lines without an id or title", () => {
    const text = md("# M", "", "- [ ]", "- [ ] ", "- [ ] Title only", "- [ ] @est:4h");
    const file = parseFileAs("m.md", text, "milestone");
    const [a, b, c, d] = file.items;
    const run = (e: TextEdit[]) => applyEdits(text, e).split("\n");
    expect(run(setId(file.lines, a, "T1"))[2]).toBe("- [ ] ^T1");
    expect(run(setAttr(file.lines, a, "est", "1h"))[2]).toBe("- [ ] @est:1h");
    expect(run(setTitle(file.lines, a, "New"))[2]).toBe("- [ ] New");
    expect(run(setTitle(file.lines, b, "New"))[3]).toBe("- [ ] New");
    expect(run(setId(file.lines, c, "T3"))[4]).toBe("- [ ] Title only ^T3");
    expect(run(setTitle(file.lines, d, "Named"))[5]).toBe("- [ ] Named @est:4h");
    expect(run(setAttr(file.lines, d, "est", undefined))[5]).toBe("- [ ]");
  });
});

describe("ids", () => {
  it("assigns missing ids continuing the highest number with the same width", () => {
    const text = md("# M", "", "- [ ] a ^T007", "- [ ] b", "  - [ ] c", "- [ ] d ^T012");
    const index = indexFrom({ "milestones/M1.md": text });
    const plan = index.plan;
    expect(nextId(plan)).toBe("T013");
    const out = applyEdits(text, assignMissingIds(plan, plan.file("milestones/M1.md")!));
    expect(out).toBe(
      md("# M", "", "- [ ] a ^T007", "- [ ] b ^T013", "  - [ ] c ^T014", "- [ ] d ^T012")
    );
  });

  it("renames an id and every @dep reference across files", () => {
    const index = indexFrom({
      "milestones/M1.md": md("# M1", "", "- [ ] a ^T1", "- [ ] b @dep:T1+2d,T10 ^T2"),
      "milestones/M2.md": md("# M2", "", "- [ ] c @dep:T10,T1 ^T3", "- [ ] d @dep:T11 ^T4"),
    });
    const edits = renameTaskId(index.plan, "T1", "T100");
    expect(edits.map((e) => e.path).sort()).toEqual(["milestones/M1.md", "milestones/M2.md"]);
    const m1 = applyEdits(
      index.get("milestones/M1.md")!.lines.serialize(),
      edits.find((e) => e.path === "milestones/M1.md")!.edits
    );
    const m2 = applyEdits(
      index.get("milestones/M2.md")!.lines.serialize(),
      edits.find((e) => e.path === "milestones/M2.md")!.edits
    );
    expect(m1).toBe(md("# M1", "", "- [ ] a ^T100", "- [ ] b @dep:T100+2d,T10 ^T2"));
    expect(m2).toBe(md("# M2", "", "- [ ] c @dep:T10,T100 ^T3", "- [ ] d @dep:T11 ^T4"));
  });

  describe("a copied block", () => {
    const head = ["# M1", ""];
    const block = [
      "- [ ] Login page @est:1d ^T1",
      "  - [ ] Form @est:4h ^T2",
      "  - [ ] Validation @est:4h @dep:T2 ^T3",
      "    - [ ] Error texts @est:1h @dep:T2,T9 ^T4",
      "- [ ] Review @dep:T1,T3 ^T9",
    ];
    const renumber = (now: string, saved: string, reserved?: Set<string>) => {
      const plan = indexFrom({ "milestones/M1.md": now }).plan;
      const file = plan.file("milestones/M1.md")!;
      return applyEdits(now, renumberCopiedIds(plan, file, saved, reserved));
    };

    it("gives the copied subtasks new ids too, and dependencies within the copy follow", () => {
      const saved = md(...head, ...block);
      const now = md(
        ...head,
        ...block,
        "- [ ] Signup page @est:1d ^T1",
        "  - [ ] Form @est:4h ^T2",
        "  - [ ] Validation @est:4h @dep:T2 ^T3",
        "    - [ ] Error texts @est:1h @dep:T2,T9 ^T4"
      );
      const reserved = new Set<string>();
      expect(renumber(now, saved, reserved)).toBe(
        md(
          ...head,
          // The originals, and the dependencies on them, are unchanged.
          ...block,
          "- [ ] Signup page @est:1d ^T10",
          "  - [ ] Form @est:4h ^T11",
          "  - [ ] Validation @est:4h @dep:T11 ^T12",
          "    - [ ] Error texts @est:1h @dep:T11,T9 ^T13"
        )
      );
      expect([...reserved]).toEqual(["T10", "T11", "T12", "T13"]);
    });

    it("renumbers only the copies, wherever the block was pasted", () => {
      const saved = md(...head, ...block);
      const now = md(
        ...head,
        "- [ ] Signup page @est:1d ^T1",
        "  - [ ] Form @est:4h ^T2",
        "  - [ ] Password rules @est:2h ^T20",
        ...block
      );
      expect(renumber(now, saved)).toBe(
        md(
          ...head,
          "- [ ] Signup page @est:1d ^T21",
          "  - [ ] Form @est:4h ^T22",
          // Not a copy: its id is used once.
          "  - [ ] Password rules @est:2h ^T20",
          ...block
        )
      );
    });

    it("leaves a block pasted with its parent's title alone: it may be moving", () => {
      const saved = md(...head, ...block);
      const now = md(...head, ...block, ...block.slice(0, 2));
      expect(renumber(now, saved)).toBe(now);
    });

    it("goes together with the ids for tasks that have none, as on save", () => {
      const original = ["- [ ] Login page ^T1", "  - [ ] Form ^T2", "  - [ ] Check @dep:T2"];
      const now = md(
        ...head,
        ...original,
        "- [ ] Signup page ^T1",
        "  - [ ] Form ^T2",
        "  - [ ] Check @dep:T2"
      );
      const plan = indexFrom({ "milestones/M1.md": now }).plan;
      const file = plan.file("milestones/M1.md")!;
      const reserved = new Set<string>();
      const edits = [
        ...renumberCopiedIds(plan, file, md(...head, ...original), reserved),
        ...assignMissingIds(plan, file, reserved),
      ];
      expect(applyEdits(now, edits)).toBe(
        md(
          ...head,
          "- [ ] Login page ^T1",
          "  - [ ] Form ^T2",
          "  - [ ] Check @dep:T2 ^T5",
          "- [ ] Signup page ^T3",
          "  - [ ] Form ^T4",
          "  - [ ] Check @dep:T4 ^T6"
        )
      );
    });
  });
});

describe("inserting, deleting and moving tasks", () => {
  it("formats new task blocks with notes and children", () => {
    expect(
      formatTaskBlock({
        title: "Parent",
        attrs: [
          ["est", "4h"],
          ["note", "two words"],
        ],
        tags: ["frontend"],
        id: "T9",
        notes: ["A note"],
        children: [{ title: "Child", status: "doing", attrs: [["est", "2h"]] }],
      })
    ).toEqual([
      '- [ ] Parent @est:4h @note:"two words" #frontend ^T9',
      "      A note",
      "  - [/] Child @est:2h",
    ]);
  });

  it("appends to the end of an existing section", () => {
    const { file, run } = setup();
    const out = run(
      insertTasks(file, { kind: "section", title: "Checkout" }, [
        { title: "New task", attrs: [["est", "1h"]], id: "T107" },
      ])
    );
    expect(changed(M2, out).inserted).toBe("- [ ] New task @est:1h ^T107\n");
    const lines = out.split("\n");
    expect(lines.indexOf("- [ ] New task @est:1h ^T107")).toBe(
      lines.findIndex((l) => l.endsWith("^T106")) + 1
    );
  });

  it("creates a missing section at the end of the file", () => {
    const { file, run } = setup();
    const out = run(
      insertTasks(file, { kind: "section", title: "Billing" }, [{ title: "CIP", id: "T110" }])
    );
    expect(out.endsWith("preserved.\n\n## Billing\n\n- [ ] CIP ^T110\n")).toBe(true);
  });

  it("fills an empty section and inserts children and siblings", () => {
    const text = md("# M", "", "## Empty", "", "## Next", "", "- [ ] a ^T1", "  - [ ] b ^T2");
    const file = parseFileAs("m.md", text, "milestone");
    expect(
      applyEdits(text, insertTasks(file, { kind: "section", title: "Empty" }, [{ title: "x" }]))
    ).toBe(
      md("# M", "", "## Empty", "", "- [ ] x", "", "## Next", "", "- [ ] a ^T1", "  - [ ] b ^T2")
    );
    expect(
      applyEdits(text, insertTasks(file, { kind: "child", task: file.items[0] }, [{ title: "c" }]))
    ).toBe(
      md("# M", "", "## Empty", "", "## Next", "", "- [ ] a ^T1", "  - [ ] b ^T2", "  - [ ] c")
    );
    expect(
      applyEdits(text, insertTasks(file, { kind: "after", task: file.items[1] }, [{ title: "d" }]))
    ).toBe(
      md("# M", "", "## Empty", "", "## Next", "", "- [ ] a ^T1", "  - [ ] b ^T2", "  - [ ] d")
    );
  });

  it("replaces and removes the notes of a task", () => {
    const text = md("# M", "", "- [ ] a ^T1", "      old note", "  - [ ] b ^T2", "- [ ] c ^T3");
    const file = parseFileAs("m.md", text, "milestone");
    const [a, , c] = file.items;
    expect(applyEdits(text, setNotes(file.lines, a, ["new one", "and two"]))).toBe(
      md("# M", "", "- [ ] a ^T1", "      new one", "      and two", "  - [ ] b ^T2", "- [ ] c ^T3")
    );
    expect(applyEdits(text, setNotes(file.lines, a, []))).toBe(
      md("# M", "", "- [ ] a ^T1", "  - [ ] b ^T2", "- [ ] c ^T3")
    );
    expect(applyEdits(text, setNotes(file.lines, c, ["note"]))).toBe(
      md("# M", "", "- [ ] a ^T1", "      old note", "  - [ ] b ^T2", "- [ ] c ^T3", "      note")
    );
  });

  it("reads and rewrites notes with their relative indentation and paragraphs", () => {
    const text = md(
      "- [ ] a ^T1",
      "      Steps:",
      "        - wire",
      "        - test",
      "",
      "      ```",
      "      run()",
      "      ```",
      "  - [ ] b ^T2"
    );
    const file = parseFileAs("m.md", text, "milestone");
    const [a] = file.items;
    const notes = readNotes(file.lines, a);
    expect(notes).toEqual(["Steps:", "  - wire", "  - test", "", "```", "run()", "```"]);
    // Writing them back changes nothing; appending a line inserts only that line.
    expect(setNotes(file.lines, a, notes)).toEqual([]);
    const edits = setNotes(file.lines, a, [...notes, "Done."]);
    expect(edits).toHaveLength(1);
    expect(edits[0].range.start).toEqual(edits[0].range.end);
    expect(applyEdits(text, edits)).toBe(text.replace("```\n  - [ ]", "```\n      Done.\n  - [ ]"));
    // Input with its own indentation is placed under the notes' indentation.
    expect(applyEdits(text, setNotes(file.lines, a, ["    One", "      nested"]))).toBe(
      md("- [ ] a ^T1", "      One", "        nested", "  - [ ] b ^T2")
    );
    // Removing paragraphs leaves no blank lines behind.
    expect(applyEdits(text, setNotes(file.lines, a, []))).toBe(md("- [ ] a ^T1", "  - [ ] b ^T2"));
  });

  it("replaces lines and leaves the ones that stay the same alone", () => {
    const text = "a\nb\nc\nd";
    const lines = parseFileAs("m.md", text, "milestone").lines;
    const edits = replaceLines(lines, 1, 2, ["b", "x", "c"]);
    expect(edits).toEqual([
      {
        range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } },
        newText: "x\n",
      },
    ]);
    expect(applyEdits(text, edits)).toBe("a\nb\nx\nc\nd");
    expect(applyEdits(text, replaceLines(lines, 1, 3, ["b", "d", "e"]))).toBe("a\nb\nd\ne");
    expect(applyEdits(text, replaceLines(lines, 2, 3, ["c", "d", "e"]))).toBe("a\nb\nc\nd\ne");
    expect(applyEdits(text, replaceLines(lines, 1, 3, ["b"]))).toBe("a\nb");
    expect(replaceLines(lines, 0, 3, ["a", "b", "c", "d"])).toEqual([]);
  });

  it("replaces and removes notes at the end of a file without a final line ending", () => {
    for (const notes of [["      note"], ["      one", "", "      two"]]) {
      const text = ["# M", "", "- [ ] a ^T1", ...notes].join("\n");
      const file = parseFileAs("m.md", text, "milestone");
      const [a] = file.items;
      expect(applyEdits(text, setNotes(file.lines, a, ["new"]))).toBe(
        "# M\n\n- [ ] a ^T1\n      new"
      );
      expect(applyEdits(text, setNotes(file.lines, a, []))).toBe("# M\n\n- [ ] a ^T1");
    }
    const text = "# M\n\n- [ ] a ^T1\n  - [ ] b\n  after b\n  and more";
    const file = parseFileAs("m.md", text, "milestone");
    expect(applyEdits(text, setNotes(file.lines, file.items[0], ["first"]))).toBe(
      "# M\n\n- [ ] a ^T1\n  first\n  - [ ] b"
    );
  });

  it("keeps a blank line under an empty section at the end of the file", () => {
    for (const text of [md("# M", "", "## Last"), md("# M", "", "## Last", "")]) {
      const file = parseFileAs("m.md", text, "milestone");
      expect(
        applyEdits(text, insertTasks(file, { kind: "section", title: "Last" }, [{ title: "x" }]))
      ).toBe(md("# M", "", "## Last", "", "- [ ] x"));
    }
  });

  it("deletes a block with its notes and children", () => {
    const { file, t, run } = setup();
    const out = run([deleteTask(file.lines, t("T102"))]);
    expect(out).not.toContain("T103");
    expect(out).not.toContain("Notes indented");
    expect(changed(M2, out).inserted).toBe("");
  });

  it("moves an inbox item into a milestone section with a new id", () => {
    const { index, plan } = setup();
    const inbox = plan.file("inbox.md")!;
    const target = plan.file("milestones/M2.md")!;
    const edits = moveTask(
      inbox,
      plan.inbox[0],
      target,
      { kind: "section", title: "Checkout" },
      (l) => `${l} ^T107`
    );
    const inboxOut = applyEdits(
      inbox.lines.serialize(),
      edits.find((e) => e.path === "inbox.md")!.edits
    );
    const m2Out = applyEdits(
      target.lines.serialize(),
      edits.find((e) => e.path === "milestones/M2.md")!.edits
    );
    expect(inboxOut).toBe(md("# Inbox", ""));
    expect(changed(M2, m2Out).inserted).toBe(
      "- [ ] Quick idea @est:2h #idea ^T107\n  with a note\n"
    );
    expect(index.update("milestones/M2.md", m2Out)).toBe(true);
    expect(index.plan.taskById("T107")?.notes.map((n) => n.text)).toEqual(["with a note"]);
  });

  it("uses the file's own line endings for inserted lines", () => {
    const text = "# M\r\n\r\n## S\r\n\r\n- [ ] a ^T1\r\n";
    const file = parseFileAs("m.md", text, "milestone");
    const out = applyEdits(
      text,
      insertTasks(file, { kind: "section", title: "S" }, [{ title: "b" }])
    );
    expect(out).toBe("# M\r\n\r\n## S\r\n\r\n- [ ] a ^T1\r\n- [ ] b\r\n");
  });

  it("appends after a final line without newline", () => {
    const text = "# M\n\n- [ ] a ^T1";
    const file = parseFileAs("m.md", text, "milestone");
    expect(applyEdits(text, insertTasks(file, { kind: "end" }, [{ title: "b" }]))).toBe(
      "# M\n\n- [ ] a ^T1\n- [ ] b"
    );
  });
});

describe("property and section edits", () => {
  it("changes a value and keeps the comment", () => {
    const { file, run } = setup();
    const out = run(setProperty(file.lines, file.props, "status", "done"));
    expect(changed(M2, out)).toEqual({ removed: "activ", inserted: "don" });
    expect(out).toContain("status: done # planned | active | done | cancelled");
  });

  it("adds a property at the end of the block", () => {
    const { file, run } = setup();
    const out = run(setProperty(file.lines, file.props, "owner", "alex"));
    expect(out).toContain("depends: M1\nowner: alex\n\nShort description");
  });

  it("creates a property block under a bare heading", () => {
    const text = md("# Title", "", "Body text.");
    const file = parseFileAs("m.md", text, "milestone");
    expect(applyEdits(text, [addProperty(file.lines, file.props, "id", "M3")])).toBe(
      md("# Title", "", "id: M3", "", "Body text.")
    );
    const bare = "# Title\nBody";
    const f2 = parseFileAs("m.md", bare, "milestone");
    expect(applyEdits(bare, [addProperty(f2.lines, f2.props, "id", "M3")])).toBe(
      "# Title\n\nid: M3\n\nBody"
    );
    const only = "# Title\n";
    const f3 = parseFileAs("m.md", only, "milestone");
    expect(applyEdits(only, [addProperty(f3.lines, f3.props, "id", "M3")])).toBe(
      "# Title\n\nid: M3\n"
    );
  });

  it("fills an empty value with a separating space and removes properties", () => {
    const text = md("# T", "", "depends:", "target: 2026-01-01");
    const file = parseFileAs("m.md", text, "milestone");
    expect(applyEdits(text, setProperty(file.lines, file.props, "depends", "M1"))).toBe(
      md("# T", "", "depends: M1", "target: 2026-01-01")
    );
    expect(applyEdits(text, [removeProperty(file.lines, file.props.entries[1])])).toBe(
      md("# T", "", "depends:")
    );
  });

  it("appends a run section with one blank line of separation", () => {
    const { file, run } = setup();
    const out = run([
      appendSection(file.lines, 2, "Run 2027-01-20", ["tester: alex", "result: 3 pass"]),
    ]);
    expect(out.endsWith("preserved.\n\n## Run 2027-01-20\n\ntester: alex\nresult: 3 pass\n")).toBe(
      true
    );
    const spaced = "# T\n\ntext\n\n";
    const f = parseFileAs("t.md", spaced, "test");
    expect(applyEdits(spaced, [appendSection(f.lines, 2, "Run", [])])).toBe(
      "# T\n\ntext\n\n## Run\n"
    );
  });
});

describe("canonical attribute order", () => {
  it("inserts new attributes at their place in the key order", () => {
    const text = md(
      "# M",
      "",
      "- [ ] t @est:4h @owner:sam @dep:T1 #tag ^T2",
      "- [ ] u @due:2026-01-01 ^T3",
      "- [ ] v @custom:x ^T4"
    );
    const file = parseFileAs("m.md", text, "milestone");
    const [t, u, v] = file.items;
    const line = (edits: TextEdit[], n: number) => applyEdits(text, edits).split("\n")[n];
    expect(line(setAttr(file.lines, t, "act", "1h"), 2)).toBe(
      "- [ ] t @est:4h @act:1h @owner:sam @dep:T1 #tag ^T2"
    );
    expect(line(setAttr(file.lines, t, "done", "2026-10-14"), 2)).toBe(
      "- [ ] t @est:4h @owner:sam @dep:T1 @done:2026-10-14 #tag ^T2"
    );
    expect(line(setAttr(file.lines, u, "est", "2h"), 3)).toBe(
      "- [ ] u @est:2h @due:2026-01-01 ^T3"
    );
    expect(line(setAttr(file.lines, v, "owner", "ann"), 4)).toBe(
      "- [ ] v @owner:ann @custom:x ^T4"
    );
  });
});
