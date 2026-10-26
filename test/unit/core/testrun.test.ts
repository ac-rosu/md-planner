import { describe, expect, it } from "vitest";
import { parseFileAs } from "../../../src/core/parser/files";
import { applyEdits } from "../../../src/core/text";
import {
  addPunchItem,
  appendRunLog,
  caseOfStep,
  countResults,
  linkStepToPunch,
  recordStepResult,
  resetResults,
  setStepNote,
} from "../../../src/core/testRun";
import { parseSrc, promoteTodo, scanTodos } from "../../../src/core/todos";
import { buildRunnerModel } from "../../../src/core/views/testRunner";
import { loadSample, md, planFrom } from "../helpers";

const plan = loadSample().plan;
const fat = plan.testById("UAT-01")!;
const fatFile = plan.file(fat.file)!;
const text = fatFile.lines.serialize();
const step = (caseIndex: number, n: number) => fat.cases[caseIndex].steps[n];
const lineOf = (out: string, i: number) => out.split("\n")[i];

describe("test step results", () => {
  it("ticks the step and writes @result and @note", () => {
    const s = step(0, 2);
    expect(lineOf(applyEdits(text, recordStepResult(fatFile, s, "pass")), s.line)).toBe(
      "- [x] Order appears in the order history @result:pass"
    );
    expect(
      lineOf(applyEdits(text, recordStepResult(fatFile, s, "fail", "stays in STOPPING")), s.line)
    ).toBe('- [x] Order appears in the order history @result:fail @note:"stays in STOPPING"');
  });

  it("clears a result and its note, and edits notes only", () => {
    const s = step(0, 1);
    expect(lineOf(applyEdits(text, recordStepResult(fatFile, s, undefined)), s.line)).toBe(
      "- [ ] Pay with a test card → confirmation within 2 s @punch:P007"
    );
    expect(lineOf(applyEdits(text, setStepNote(fatFile, s, "")), s.line)).toBe(
      "- [x] Pay with a test card → confirmation within 2 s @result:fail @punch:P007"
    );
    expect(lineOf(applyEdits(text, setStepNote(fatFile, s, "3.6 s")), s.line)).toBe(
      '- [x] Pay with a test card → confirmation within 2 s @result:fail @note:"3.6 s" @punch:P007'
    );
  });

  it("resets all results for a new run but keeps punch links and run logs", () => {
    const out = applyEdits(text, resetResults(fatFile));
    expect(out).toContain("- [ ] Add a product and open the cart → total with VAT shown\n");
    expect(out).toContain("- [ ] Pay with a test card → confirmation within 2 s @punch:P007\n");
    expect(out).toContain("## Run 2026-10-12");
    expect(countResults(parseTest(out))).toMatchObject({ pass: 0, fail: 0, open: 4 });
  });

  it("appends a run log with counts, failed cases and punch items", () => {
    const out = applyEdits(text, [
      appendRunLog(fatFile, fat, {
        date: "2027-01-20",
        tester: "Alex",
        witness: "Customer key users",
      }),
    ]);
    expect(
      out.endsWith(
        "\n\n## Run 2027-01-20\n\ntester: Alex\nwitness: Customer key users\nresult: 1 pass, 1 fail, 0 n.a., 2 open (4 steps)\nfailed: TC-01\npunch: P007\n"
      )
    ).toBe(true);
    expect(parseTest(out).runs.map((r) => r.date)).toEqual(["2026-10-12", "2027-01-20"]);
  });

  it("finds the case of a step", () => {
    expect(caseOfStep(fat, step(1, 0))?.id).toBe("TC-02");
  });
});

function parseTest(source: string) {
  const f = parseFileAs("tests/FAT.md", source, "test");
  if (f.kind !== "test") throw new Error();
  const items = f.items;
  for (const i of items) i.result = /@result:(\w+)/.exec(f.lines.line(i.line))?.[1] as never;
  return {
    cases: f.cases,
    runs: f.runs,
    file: f.path,
    id: "FAT",
    title: "",
    headingLine: 0,
    props: f.props,
  };
}

describe("punch items from failed steps", () => {
  it("appends a ^P item with @from and links the step", () => {
    const c = addPunchItem(plan, {
      title: "Declined card shows no error message",
      sev: "A",
      owner: "sam",
      from: "UAT-01/TC-02",
    });
    expect(c.id).toBe("P008");
    const punch = plan.file("punchlist.md")!;
    const out = applyEdits(punch.lines.serialize(), c.edits!.edits);
    expect(
      out.endsWith(
        "^P007\n- [ ] Declined card shows no error message @sev:A @owner:sam @from:UAT-01/TC-02 ^P008\n"
      )
    ).toBe(true);
    const s = step(1, 0);
    expect(lineOf(applyEdits(text, linkStepToPunch(fatFile, s, c.id)), s.line)).toBe(
      "- [ ] Declined card → clear error message, the cart is kept @punch:P008"
    );
  });

  it("creates punchlist.md when there is none", () => {
    const p = planFrom({
      "tests/T.md": md("# T", "", "id: T", "", "## TC-01 A", "", "- [x] s @result:fail"),
    });
    const c = addPunchItem(p, { title: "Broken", sev: "B", from: "T/TC-01" });
    expect(c).toMatchObject({
      id: "P001",
      create: {
        path: "punchlist.md",
        text: "# Punch list\n\n- [ ] Broken @sev:B @from:T/TC-01 ^P001\n",
      },
    });
  });
});

describe("TODO comments", () => {
  it("finds TODO and FIXME in common comment styles", () => {
    const src = [
      "// TODO: handle timeout",
      "(* FIXME: limit setpoint *)",
      "# FIXME hard-coded tag",
      "<!-- TODO(T12): link the doc -->",
      "/* TODO check this */",
      "let TODO_LIST = 1; // not a todo",
      "todo: lower case is ignored",
      "// TODO",
      "x = 1 // FIXME(T7) done",
    ].join("\n");
    expect(scanTodos(src).map((t) => [t.line, t.keyword, t.taskId, t.text])).toEqual([
      [0, "TODO", undefined, "handle timeout"],
      [1, "FIXME", undefined, "limit setpoint"],
      [2, "FIXME", undefined, "hard-coded tag"],
      [3, "TODO", "T12", "link the doc"],
      [4, "TODO", undefined, "check this"],
      [8, "FIXME", "T7", "done"],
    ]);
    expect(scanTodos("NOTE: custom", ["NOTE"])).toHaveLength(1);
  });

  it("promotes a TODO to a task with @src and links the comment", () => {
    const source = "BEGIN\n   // TODO: handle the payment provider timeout\nEND";
    const todo = scanTodos(source)[0];
    const m2 = plan.file("milestones/M2-backend.md")!;
    const p = promoteTodo(plan, {
      todo,
      sourcePath: "src/server/payments.ts",
      milestoneFile: m2,
      location: { kind: "section", title: "Checkout" },
      owner: "sam",
    });
    expect(p.id).toBe("T408");
    expect(applyEdits(source, [p.sourceEdit])).toBe(
      "BEGIN\n   // TODO(T408): handle the payment provider timeout\nEND"
    );
    const out = applyEdits(m2.lines.serialize(), p.planEdits);
    expect(out).toContain(
      "^T108\n- [ ] handle the payment provider timeout @owner:sam @src:src/server/payments.ts#L2 ^T408\n"
    );
    expect(parseSrc("src/server/payments.ts#L2")).toEqual({
      path: "src/server/payments.ts",
      line: 1,
    });
    expect(parseSrc("README.md")).toEqual({ path: "README.md", line: undefined });
  });
});

describe("test runner model", () => {
  it("lists cases, steps with keys and punch status, runs and linked tasks", () => {
    const m = buildRunnerModel(plan, fat, "2026-10-14", "Alex");
    expect(m.plans.map((p) => p.id)).toEqual(["UAT-01", "UAT-02"]);
    expect(m.plan!.cases.map((c) => [c.id, c.counts.steps])).toEqual([
      ["TC-01", 3],
      ["TC-02", 1],
    ]);
    expect(m.plan!.cases[0].steps[1]).toMatchObject({
      key: "tests/UAT-01-checkout.md#14",
      result: "fail",
      punch: "P007",
      punchStatus: "todo",
    });
    expect(m.plan!.runs[0]).toMatchObject({ date: "2026-10-12" });
    expect(m.plan!.runs[0].summary).toContain("tester: Alex");
    expect(m.plan!.linkedTasks.map((t) => t.id)).toEqual(["T108", "T301"]);
    expect(m.tester).toBe("Alex");
  });
});
