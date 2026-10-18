// Test runner view model: one test plan with its cases, steps, results, punch links and runs.
import { type TestPlan } from "../model";
import { type Plan } from "../resolve";
import { taskKey } from "../scheduler";
import { countResults, type RunCounts } from "../testRun";

export interface RunnerStep {
  key: string;
  text: string;
  done: boolean;
  result?: "pass" | "fail" | "na";
  note?: string;
  punch?: string;
  punchStatus?: string;
  level: number;
}

export interface RunnerCase {
  id: string;
  title: string;
  pre?: string;
  steps: RunnerStep[];
  counts: RunCounts;
}

export interface RunnerModel {
  plans: Array<{ id: string; title: string; type?: string }>;
  plan?: {
    id: string;
    title: string;
    type?: string;
    milestone?: string;
    eq?: string;
    witness?: string;
    file: string;
    counts: RunCounts;
    cases: RunnerCase[];
    runs: Array<{ date: string; title: string; summary: string }>;
    /** Tasks that link this plan with `@test`. */
    linkedTasks: Array<{ key: string; id?: string; title: string; status: string }>;
  };
  people: Array<{ id: string; name: string }>;
  today: string;
  /** Default tester name (`planner.me`). */
  tester?: string;
}

export function buildRunnerModel(
  plan: Plan,
  tp: TestPlan | undefined,
  today: string,
  tester?: string
): RunnerModel {
  const model: RunnerModel = {
    plans: plan.tests.map((t) => ({ id: t.id, title: t.title, type: t.type })),
    people: plan.people.map((p) => ({ id: p.id, name: p.name })),
    today,
    tester,
  };
  if (!tp) return model;
  model.plan = {
    id: tp.id,
    title: tp.title,
    type: tp.type,
    milestone: tp.milestone,
    eq: tp.eq,
    witness: tp.witness,
    file: tp.file,
    counts: countResults(tp),
    cases: tp.cases.map((c) => ({
      id: c.id,
      title: c.title,
      pre: c.pre,
      counts: countResults(c),
      steps: c.steps
        .flatMap((s) => [s, ...s.children])
        .map((s) => ({
          key: taskKey(s),
          text: s.title,
          done: s.status === "done",
          result: s.result,
          note: s.note,
          punch: s.punch,
          punchStatus: s.punch ? plan.punchById(s.punch)?.status : undefined,
          level: s.parent ? 1 : 0,
        })),
    })),
    runs: tp.runs.map((r) => ({
      date: r.date,
      title: r.title,
      summary: r.props.entries
        .filter((e) => e.key !== "pre")
        .map((e) => `${e.key}: ${e.value}`)
        .join(" · "),
    })),
    linkedTasks: plan.tasks
      .filter((t) => t.test?.toLowerCase() === tp.id.toLowerCase())
      .map((t) => ({ key: taskKey(t), id: t.id, title: t.title, status: t.status })),
  };
  return model;
}
