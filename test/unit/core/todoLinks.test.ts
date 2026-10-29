import { describe, expect, it } from "vitest";
import { titleMarkup } from "../../../src/core/parser/taskLine";
import { applyEdits } from "../../../src/core/text";
import { linkedTask, promoteTodo, scanTodos, todoTitle } from "../../../src/core/todos";
import { loadSample } from "../helpers";

const plan = loadSample().plan;
const m2 = plan.file("milestones/M2-backend.md")!;

/** Promotes the TODO on the first line of `source`; the source and the new task line after. */
function promote(source: string): { source: string; task: string; id: string } {
  const todo = scanTodos(source)[0];
  const p = promoteTodo(plan, {
    todo,
    sourcePath: "src/a.ts",
    milestoneFile: m2,
    location: { kind: "root" },
  });
  const out = applyEdits(m2.lines.serialize(), p.planEdits);
  return {
    source: applyEdits(source, [p.sourceEdit]),
    task: out.split("\n").find((l) => l.endsWith(`^${p.id}`))!,
    id: p.id,
  };
}

describe("TODO comments with notes in parentheses", () => {
  it("reads only task ids as links, not versions, issues or names", () => {
    const src = [
      "// TODO(v2): drop the old endpoint",
      "// FIXME(issue42) retry on timeout",
      "// TODO(alice): ask about rounding",
      "// TODO(T113): linked",
      "// TODO(T9, alice): linked, with a name",
      "// TODO(alice, T9): linked, name first",
      "// TODO(): empty",
    ].join("\n");
    expect(scanTodos(src).map((t) => [t.taskId, t.ref])).toEqual([
      [undefined, "v2"],
      [undefined, "issue42"],
      [undefined, "alice"],
      ["T113", "T113"],
      ["T9", "T9, alice"],
      ["T9", "alice, T9"],
      [undefined, ""],
    ]);
    // Without parentheses, as before.
    expect(scanTodos("// TODO: plain")[0]).toMatchObject({ taskId: undefined, ref: undefined });
  });

  it("links only to tasks that exist", () => {
    const [linked, gone] = scanTodos("// TODO(T113): linked\n// TODO(T999): deleted task");
    expect(linkedTask(plan, linked)?.id).toBe("T113");
    expect(gone.taskId).toBe("T999");
    expect(linkedTask(plan, gone)).toBeUndefined();
  });

  it("puts the new id inside the comment's parentheses, where it is read back", () => {
    const cases: Array<[string, string]> = [
      ["// TODO: handle the timeout", "// TODO(ID): handle the timeout"],
      ["# FIXME hard-coded tag", "# FIXME(ID) hard-coded tag"],
      ["// TODO(alice): ask about rounding", "// TODO(ID, alice): ask about rounding"],
      ["// TODO(v2): drop the old endpoint", "// TODO(ID, v2): drop the old endpoint"],
      ["// TODO(T999): its task was deleted", "// TODO(ID, T999): its task was deleted"],
      ["// TODO(): empty parentheses", "// TODO(ID): empty parentheses"],
    ];
    for (const [before, after] of cases) {
      const p = promote(before);
      expect(p.source).toBe(after.replace("ID", p.id));
      const [read] = scanTodos(p.source);
      expect(read.taskId).toBe(p.id);
      expect(read.text).toBe(scanTodos(before)[0].text);
    }
  });

  it("keeps markup of the comment in the title instead of making it a tag", () => {
    const p = promote("// TODO: remove once #1234 is merged");
    expect(p.task).toBe(`- [ ] remove once (#1234) is merged @src:src/a.ts#L1 ^${p.id}`);
    expect(todoTitle("see @est:4h and #42, then ^T5")).toBe("see (@est:4h) and (#42), then (^T5)");
    expect(todoTitle("handle the timeout")).toBe("handle the timeout");
    for (const text of ["remove once #1234 is merged", "a #b @c:d e ^f", "#1 #2"])
      expect(titleMarkup(todoTitle(text))).toEqual([]);
  });
});
