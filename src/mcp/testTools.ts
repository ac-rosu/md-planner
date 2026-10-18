// Test tools: create test plans and cases, record step results, finish a run (run log),
// reset results. Punch items from failed steps: add_punch_item with `step`.
import { isValidDate } from "../core/dates";
import { type TestPlan, TEST_TYPES } from "../core/model";
import { appendRunLog, recordStepResult, resetResults } from "../core/testRun";
import { appendBlock, insertLines } from "../core/writer";
import { milestoneFileName } from "../core/writer/entities";
import { findStep } from "./inboxTools";
import { milestoneOf } from "./milestoneTools";
import { type Staging } from "./staging";
import { personOf } from "./taskSpecs";
import { type PlannerTools, ToolError } from "./tools";

export interface TestCaseInput {
  /** TC-04 …; default: the next free TC number. */
  id?: string;
  title: string;
  /** Precondition. */
  pre?: string;
  /** One line per step. */
  steps: string[];
}

export interface TestPlanInput {
  /** e.g. UAT-03 */
  id: string;
  title: string;
  /** acceptance, FAT, SAT, IT or unit */
  type?: string;
  /** Milestone id or name. */
  milestone?: string;
  /** Component or equipment, e.g. billing */
  equipment?: string;
  witness?: string;
  cases?: TestCaseInput[];
}

function caseLines(id: string, c: TestCaseInput): string[] {
  const out = [`## ${id} ${c.title.replace(/\s+/g, " ").trim()}`, ""];
  if (c.pre?.trim()) out.push(`pre: ${c.pre.trim()}`, "");
  for (const s of c.steps) if (s.trim()) out.push(`- [ ] ${s.replace(/\s+/g, " ").trim()}`);
  return out;
}

/** The case ids: given ones as they are, the others the next free TC numbers. */
function caseIds(existing: string[], cases: TestCaseInput[], label: string): string[] {
  const used = new Set(existing.map((x) => x.toUpperCase()));
  for (const c of cases) {
    const id = c.id?.trim();
    if (!id) continue;
    if (used.has(id.toUpperCase()))
      throw new ToolError(`${label}: test case ${id} already exists.`);
    used.add(id.toUpperCase());
  }
  let n = Math.max(0, ...existing.map((x) => Number(/(\d+)$/.exec(x)?.[1] ?? 0)));
  return cases.map((c) => {
    if (c.id?.trim()) return c.id.trim();
    let id: string;
    do id = `TC-${String(++n).padStart(2, "0")}`;
    while (used.has(id));
    used.add(id);
    return id;
  });
}

function checkCases(cases: TestCaseInput[], label: string): void {
  cases.forEach((c, i) => {
    if (!c.title?.trim()) throw new ToolError(`${label} case ${i + 1}: a title is needed.`);
    if (!c.steps?.some((s) => s.trim()))
      throw new ToolError(`${label} case ${i + 1} "${c.title}": at least one step is needed.`);
  });
}

/** Stages test plan files under tests/. */
export function stageTestPlans(st: Staging, plans: TestPlanInput[]): string[] {
  const ids: string[] = [];
  for (const p of plans) {
    if (!p.id?.trim() || !/^[A-Za-z][\w-]*$/.test(p.id.trim()))
      throw new ToolError(`Invalid test plan id "${p.id ?? ""}" (e.g. UAT-03).`);
    if (!p.title?.trim()) throw new ToolError(`Test plan ${p.id}: a title is needed.`);
    if (st.plan.testById(p.id.trim())) throw new ToolError(`Test plan ${p.id} already exists.`);
    if (p.type && !(TEST_TYPES as readonly string[]).includes(p.type))
      throw new ToolError(`Test plan ${p.id}: type is ${TEST_TYPES.join(", ")}.`);
    let milestone: string | undefined;
    if (p.milestone) {
      milestone = milestoneOf(st.plan, p.milestone)?.id;
      if (!milestone) throw new ToolError(`Test plan ${p.id}: unknown milestone "${p.milestone}".`);
    }
    const cases = p.cases ?? [];
    checkCases(cases, `Test plan ${p.id}`);
    const lines = [`# ${p.title.replace(/\s+/g, " ").trim()}`, "", `id: ${p.id.trim()}`];
    if (p.type) lines.push(`type: ${p.type}`);
    if (milestone) lines.push(`milestone: ${milestone}`);
    if (p.equipment) lines.push(`eq: ${p.equipment}`);
    if (p.witness) lines.push(`witness: ${p.witness}`);
    const tcIds = caseIds([], cases, `Test plan ${p.id}`);
    cases.forEach((c, i) => lines.push("", ...caseLines(tcIds[i], c)));
    const path = milestoneFileName(p.id.trim(), p.title).replace(/^milestones\//, "tests/");
    st.create(path, lines.join("\n") + "\n");
    ids.push(p.id.trim());
  }
  return ids;
}

export function createTestPlans(tools: PlannerTools, args: { plans: TestPlanInput[] }) {
  if (!args.plans?.length) throw new ToolError("No test plans given.");
  const st = tools.stage();
  const ids = stageTestPlans(st, args.plans);
  return { created: ids, changed: tools.commit(st) };
}

function testPlan(st: Staging, id: string): TestPlan {
  const tp = st.plan.testById(id);
  if (!tp)
    throw new ToolError(
      `Unknown test plan "${id}" (${st.plan.tests.map((t) => t.id).join(", ")}).`
    );
  return tp;
}

/** Adds test cases before the run logs of a test plan. */
export function addTestCases(tools: PlannerTools, args: { test: string; cases: TestCaseInput[] }) {
  const st = tools.stage();
  const tp = testPlan(st, args.test);
  checkCases(args.cases ?? [], tp.id);
  if (!args.cases?.length) throw new ToolError("No test cases given.");
  const ids = caseIds(
    tp.cases.map((c) => c.id),
    args.cases,
    tp.id
  );
  const body = args.cases.flatMap((c, i) => [...caseLines(ids[i], c), ""]);
  const file = st.plan.file(tp.file)!;
  const firstRun = tp.runs[0];
  st.apply({
    path: file.path,
    edits: [
      firstRun
        ? insertLines(file.lines, firstRun.line, body)
        : appendBlock(file.lines, body.slice(0, -1)),
    ],
  });
  return { test: tp.id, added: ids, changed: tools.commit(st) };
}

export interface StepResult {
  test: string;
  case: string;
  /** 1-based step number within the case (subtasks count as steps). */
  step: number;
  result: "pass" | "fail" | "na" | "clear";
  note?: string;
}

export function recordTestResults(tools: PlannerTools, args: { results: StepResult[] }) {
  if (!args.results?.length) throw new ToolError("No results given.");
  const st = tools.stage();
  for (const r of args.results) {
    if (!["pass", "fail", "na", "clear"].includes(r.result))
      throw new ToolError(`Invalid result "${r.result}" (pass, fail, na, clear).`);
    const { tp, step } = findStep(st.plan, r.test, r.case, r.step);
    const file = st.plan.file(tp.file)!;
    st.apply({
      path: file.path,
      edits: recordStepResult(file, step, r.result === "clear" ? undefined : r.result, r.note),
    });
  }
  return { recorded: args.results.length, changed: tools.commit(st) };
}

/** Appends a `## Run <date>` log with tester, witness, the result counts and punch items. */
export function finishTestRun(
  tools: PlannerTools,
  args: { test: string; tester: string; witness?: string; date?: string }
) {
  const st = tools.stage();
  const tp = testPlan(st, args.test);
  const date = args.date ?? tools.today;
  if (!isValidDate(date)) throw new ToolError(`Invalid date "${date}" (YYYY-MM-DD).`);
  const given = args.tester?.trim();
  if (!given) throw new ToolError("Who ran the test? Give the tester.");
  const tester = st.plan.personById(personOf(st.plan, given) ?? "")?.name ?? given;
  const file = st.plan.file(tp.file)!;
  st.apply({
    path: file.path,
    edits: [appendRunLog(file, tp, { date, tester, witness: args.witness ?? tp.witness })],
  });
  return { test: tp.id, date, changed: tools.commit(st) };
}

/** Clears every step result of a test plan (punch links stay), to start a new run. */
export function resetTestResults(tools: PlannerTools, args: { test: string }) {
  const st = tools.stage();
  const tp = testPlan(st, args.test);
  const file = st.plan.file(tp.file)!;
  st.apply({ path: file.path, edits: resetResults(file) });
  return { test: tp.id, changed: tools.commit(st) };
}
