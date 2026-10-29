// Test runner edits: step results, punch items raised from failed steps, and the run log.
import { type ParsedFile, type Status, type Task, type TestCase, type TestPlan } from "./model";
import { type Plan } from "./resolve";
import { oneLine, type TextEdit } from "./text";
import {
  appendSection,
  editTaskLine,
  type FileEdit,
  formatTaskBlock,
  insertTasks,
  nextId,
  type NewTask,
  statusDateAttrs,
} from "./writer";

export type StepResult = "pass" | "fail" | "na";

/**
 * Records a step result: the checkbox is ticked when there is a result, `@result` and `@note` are
 * set (an empty note removes `@note`). `undefined` clears the result and unticks the step.
 */
export function recordStepResult(
  file: ParsedFile,
  step: Task,
  result: StepResult | undefined,
  note?: string
): TextEdit[] {
  return editTaskLine(file.lines, step, (e) => {
    e.setStatusChar(result ? "x" : " ");
    e.setAttr("result", result);
    if (note !== undefined) e.setAttr("note", note.trim() === "" ? undefined : note.trim());
    if (result === undefined) e.setAttr("note", undefined);
  });
}

/** Sets or clears only the note of a step. */
export function setStepNote(file: ParsedFile, step: Task, note: string): TextEdit[] {
  return editTaskLine(file.lines, step, (e) =>
    e.setAttr("note", note.trim() === "" ? undefined : note.trim())
  );
}

/** Unticks every step and removes `@result` and `@note` (punch links are kept as history). */
export function resetResults(file: ParsedFile): TextEdit[] {
  return file.items.flatMap((step) =>
    editTaskLine(file.lines, step, (e) => {
      e.setStatusChar(" ");
      e.setAttr("result", undefined);
      e.setAttr("note", undefined);
    })
  );
}

export interface RunCounts {
  steps: number;
  pass: number;
  fail: number;
  na: number;
  open: number;
}

export function countResults(tp: TestPlan | TestCase): RunCounts {
  const steps = ("cases" in tp ? tp.cases.flatMap((c) => c.steps) : tp.steps).flatMap((s) => [
    s,
    ...s.children,
  ]);
  const pass = steps.filter((s) => s.result === "pass").length;
  const fail = steps.filter((s) => s.result === "fail").length;
  const na = steps.filter((s) => s.result === "na").length;
  return { steps: steps.length, pass, fail, na, open: steps.length - pass - fail - na };
}

export interface RunInfo {
  date: string;
  tester: string;
  witness?: string;
}

/** Appends `## Run <date>` with tester, witness, result counts and the punch items raised. */
export function appendRunLog(file: ParsedFile, tp: TestPlan, run: RunInfo): TextEdit {
  const c = countResults(tp);
  // Results are recorded on substeps too: a failed substep fails its case, as in the counts.
  const stepsOf = (cs: TestCase) => cs.steps.flatMap((s) => [s, ...s.children]);
  const punch = tp.cases
    .flatMap(stepsOf)
    .filter((s) => s.result === "fail" && s.punch)
    .map((s) => s.punch!);
  const failed = tp.cases
    .filter((cs) => stepsOf(cs).some((s) => s.result === "fail"))
    .map((cs) => cs.id);
  const body = [`tester: ${oneLine(run.tester)}`];
  if (run.witness) body.push(`witness: ${oneLine(run.witness)}`);
  body.push(
    `result: ${c.pass} pass, ${c.fail} fail, ${c.na} n.a., ${c.open} open (${c.steps} steps)`
  );
  if (failed.length) body.push(`failed: ${failed.join(", ")}`);
  if (punch.length) body.push(`punch: ${[...new Set(punch)].join(", ")}`);
  return appendSection(file.lines, 2, `Run ${run.date}`, body);
}

export interface NewPunchItem {
  title: string;
  sev?: "A" | "B" | "C";
  owner?: string;
  due?: string;
  /** Back-link, e.g. `UAT-01/TC-01`. */
  from?: string;
  tags?: string[];
  /** Initial status (default to do), e.g. when added to a column of the punch-list board. */
  status?: Status;
  /** Date for `@started`/`@done` when the initial status needs one. */
  today?: string;
}

export interface PunchCreation {
  id: string;
  /** Edits of an existing punchlist.md … */
  edits?: FileEdit;
  /** … or the full text of a new punchlist.md. */
  create?: { path: string; text: string };
}

/** Adds a `^P…` item at the end of punchlist.md (creating the file when it does not exist). */
export function addPunchItem(plan: Plan, item: NewPunchItem): PunchCreation {
  const id = nextId(plan, "P");
  const attrs: Array<[string, string]> = [];
  if (item.sev) attrs.push(["sev", item.sev]);
  if (item.owner) attrs.push(["owner", item.owner]);
  if (item.due) attrs.push(["due", item.due]);
  if (item.from) attrs.push(["from", item.from]);
  if (item.today) attrs.push(...statusDateAttrs(item.status, item.today));
  const task: NewTask = { title: item.title, status: item.status, attrs, tags: item.tags, id };
  const file = plan.file("punchlist.md");
  if (!file) {
    return {
      id,
      create: {
        path: "punchlist.md",
        text: ["# Punch list", "", ...formatTaskBlock(task), ""].join("\n"),
      },
    };
  }
  return { id, edits: { path: file.path, edits: insertTasks(file, { kind: "end" }, [task]) } };
}

/** Links a failed step to its punch item with `@punch`. */
export function linkStepToPunch(file: ParsedFile, step: Task, punchId: string): TextEdit[] {
  return editTaskLine(file.lines, step, (e) => e.setAttr("punch", punchId));
}

/** The test case that contains a step. */
export function caseOfStep(tp: TestPlan, step: Task): TestCase | undefined {
  let root: Task = step;
  while (root.parent) root = root.parent;
  return tp.cases.find((c) => c.steps.includes(root));
}

/** The test plan that a test file defines. */
export function testPlanOfFile(plan: Plan, path: string): TestPlan | undefined {
  return plan.tests.find((t) => t.file === path);
}
