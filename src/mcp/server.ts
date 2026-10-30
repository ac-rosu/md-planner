// Stdio MCP server for Claude Code, Copilot agent mode and other MCP clients, on the same core as
// the extension and the CLI. Every feature of the planner is a tool: an agent can create a project,
// build a whole plan from a description, and run it day to day.
//   node dist/mcp-server.js --plan <plan folder> [--today YYYY-MM-DD]
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { STATUSES, TEST_TYPES } from "../core/model";
import { listPlanFiles } from "../core/fsLoader";
import { buildPlan } from "./buildPlan";
import { PLAN_FORMAT, planFromTextPrompt, SERVER_INSTRUCTIONS } from "./format";
import {
  addPunchItems,
  captureInbox,
  listInbox,
  listPunchItems,
  planInboxItem,
} from "./inboxTools";
import {
  addSections,
  createMilestones,
  deleteMilestone,
  listMilestones,
  updateMilestone,
} from "./milestoneTools";
import { createProject, listTemplates, planOverview, updateProject } from "./projectTools";
import {
  calibrateEstimates,
  compareBaseline,
  exportReport,
  getDashboard,
  getKanban,
  listBaselines,
  saveBaseline,
} from "./reportTools";
import {
  assignIds,
  createTasks,
  deleteTasks,
  logTime,
  moveTask,
  renameTaskId,
  updateTasks,
} from "./taskTools";
import { type TaskSpec } from "./taskSpecs";
import { addPeople, listPeople, removePerson, updatePerson } from "./teamTools";
import {
  addTestCases,
  createTestPlans,
  finishTestRun,
  recordTestResults,
  resetTestResults,
} from "./testTools";
import { listTodos, promoteTodo } from "./todoTools";
import { PlannerTools, ToolError } from "./tools";

declare const PLANNER_VERSION: string | undefined;

const status = z.enum(STATUSES as unknown as [string, ...string[]]);
const priority = z.enum(["high", "med", "low"]);
const date = z.string().describe("YYYY-MM-DD");
const strings = z.array(z.string());

const taskSpec: z.ZodType<TaskSpec> = z.lazy(() =>
  z.object({
    ref: z
      .string()
      .optional()
      .describe("Your own reference for dependsOn in the same call, e.g. 'fds-review'"),
    title: z.string(),
    status: status.optional(),
    estimate: z.string().optional().describe("4h, 1.5d, 1w"),
    actual: z.string().optional().describe("Hours already worked: 3h, 1d"),
    owner: z.string().optional().describe("Person id or name"),
    tags: strings.optional(),
    dependsOn: strings
      .optional()
      .describe("Refs or titles of tasks in this call, or existing task ids; lag: ref+2d"),
    start: date.optional().describe("Fixed start: not before this date"),
    due: date.optional().describe("Deadline"),
    priority: priority.optional(),
    progress: z.string().optional().describe("e.g. 40%"),
    done: date
      .optional()
      .describe(
        "Status done: the day it was really finished (past work entered now); default today"
      ),
    started: date
      .optional()
      .describe("The day work really began (past or ongoing work entered now); default today"),
    blocked: z.string().optional().describe("Reason, with status blocked"),
    attributes: z
      .record(z.string(), z.string())
      .optional()
      .describe("Other @key:value attributes, e.g. { eq: 'checkout', test: 'UAT-01' }"),
    notes: z.union([z.string(), strings]).optional().describe("Description under the task"),
    subtasks: z.array(taskSpec).optional(),
  })
) as z.ZodType<TaskSpec>;

const personInput = {
  name: z.string(),
  id: z.string().optional().describe("Used in @owner; default: name in lower case, dashes"),
  role: z.string().optional(),
  capacity: z.string().optional().describe("40h/week, 32h/week, 6h/day; default full time"),
  workweek: z.string().optional().describe("Own working days, e.g. mon-thu"),
  skills: strings.optional(),
  color: z.string().optional().describe("blue, green, purple, orange, yellow, red"),
  timeOff: strings.optional().describe("Dates or ranges: 2026-12-22..2027-01-02"),
  capacityChanges: strings.optional().describe("From a date on: '2027-01-01 32h/week'"),
  overtime: strings
    .optional()
    .describe("Extra hours on working days: '2026-11-02..2026-11-13 +8h/week' or '+2h/day'"),
  workdays: strings
    .optional()
    .describe("Weekend days or holidays worked: '2026-11-28' or '2026-11-28 6h'"),
};

const milestoneInput = {
  id: z.string().optional().describe("M6 …; default: the next free id"),
  name: z.string().describe("Without the id, e.g. 'Documentation'"),
  target: date.optional().describe("Due date"),
  status: z.enum(["planned", "active", "done", "cancelled"]).optional(),
  depends: strings.optional().describe("Milestone ids or names that must finish first"),
  description: z.string().optional(),
};

const taskUpdate = {
  id: z.string().describe("Task or punch item id (inbox: 'inbox:2')"),
  title: z.string().optional(),
  status: status.optional(),
  blocked: z.string().optional().describe("Reason (status blocked)"),
  subtasks: z
    .enum(["done", "cancelled", "keep"])
    .optional()
    .describe(
      "Required when status 'done' leaves open subtasks: finish them too, cancel them, or keep them open (no longer scheduled)"
    ),
  startEarly: z
    .boolean()
    .optional()
    .describe(
      "Required to start or finish a task while a milestone its milestone depends on is not finished (only if the work really started)"
    ),
  estimate: z.string().optional(),
  actual: z.string().optional(),
  owner: z.string().optional().describe("Person id or name; '' removes the owner"),
  start: z.string().optional(),
  due: z.string().optional(),
  priority: priority.optional(),
  progress: z.string().optional(),
  done: z
    .string()
    .optional()
    .describe(
      "With status done (or on a done task): the day it was really finished, YYYY-MM-DD, not after today; default today"
    ),
  started: z
    .string()
    .optional()
    .describe("The day work really began, YYYY-MM-DD, not after today; default today"),
  addTags: strings.optional(),
  removeTags: strings.optional(),
  dependsOn: strings
    .optional()
    .describe("Replaces the dependencies (ids, lag T101+2d); [] removes"),
  addDependsOn: strings.optional(),
  removeDependsOn: strings.optional(),
  attributes: z.record(z.string(), z.string()).optional().describe("Any @attribute; '' removes it"),
  notes: z
    .union([z.string(), strings])
    .optional()
    .describe(
      "Replaces the description lines (as get_task returns them: relative indentation and blank lines kept); '' or [] removes them"
    ),
};

const punchInput = {
  title: z.string(),
  sev: z
    .enum(["A", "B", "C"])
    .optional()
    .describe("A blocks acceptance, B before go-live, C later"),
  owner: z.string().optional(),
  due: date.optional(),
  from: z.string().optional().describe("Where it was found, e.g. UAT-01/TC-01"),
  tags: strings.optional(),
  status: status.optional(),
  step: z
    .object({ test: z.string(), case: z.string(), step: z.number().int().positive() })
    .optional()
    .describe("Raised from this test step: links the step with @punch"),
};

const testCase = z.object({
  id: z.string().optional().describe("TC-04 …; default: the next number"),
  title: z.string(),
  pre: z.string().optional().describe("Precondition"),
  steps: strings.describe("One line per step"),
});

const testPlanInput = z.object({
  id: z.string().describe("e.g. UAT-03"),
  title: z.string(),
  type: z.enum(TEST_TYPES).optional(),
  milestone: z.string().optional(),
  equipment: z.string().optional(),
  witness: z.string().optional(),
  cases: z.array(testCase).optional(),
});

const projectSettings = {
  name: z.string().optional(),
  code: z.string().optional(),
  start: date.optional(),
  end: date.optional(),
  workweek: z.string().optional().describe("mon-fri, mon-thu, sun-thu …"),
  hoursPerDay: z.number().optional(),
  budget: z
    .string()
    .optional()
    .describe("Hours budget of the whole project: 1200h, 150d or 30w; empty removes it"),
  holidays: strings.optional().describe("Replaces the holidays: dates and from..to ranges"),
};

export function createServer(tools: PlannerTools): McpServer {
  const server = new McpServer(
    { name: "md-planner", version: typeof PLANNER_VERSION === "string" ? PLANNER_VERSION : "dev" },
    { instructions: SERVER_INSTRUCTIONS }
  );
  const run = async (fn: () => unknown) => {
    try {
      return { content: [{ type: "text" as const, text: JSON.stringify(await fn(), null, 2) }] };
    } catch (err) {
      const message = err instanceof ToolError || err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text" as const, text: message }] };
    }
  };
  // Every tool: a description for the agent, the input schema, and whether it only reads.
  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    fn: (args: z.infer<z.ZodObject<S>>) => unknown,
    readOnly = false
  ) =>
    server.registerTool(
      name,
      { description, inputSchema, annotations: { readOnlyHint: readOnly } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((args: any) => run(() => fn(args))) as never
    );

  // --- Overview and format -------------------------------------------------------------------
  tool(
    "get_plan_overview",
    "Start here. Project settings and hours (budget, planned, logged, forecast, why over budget), people (capacity, time off, overtime), milestones (target, forecast, progress, sections), counts, test plans, the next free ids and the critical path – or that there is no plan yet.",
    {},
    () => planOverview(tools),
    true
  );
  tool(
    "get_plan_format",
    "The plan format (files, task syntax, attributes, durations, statuses), how scheduling works and how to use these tools. Read it before building a plan.",
    {},
    () => PLAN_FORMAT,
    true
  );
  tool(
    "read_plan_file",
    "The Markdown text of a plan file (project.md, team.md, milestones/…, tests/…, punchlist.md, inbox.md). Without a path: the list of plan files.",
    { path: z.string().optional().describe("Relative to the plan folder") },
    ({ path }) => readPlanFile(tools, path),
    true
  );

  // --- Project -------------------------------------------------------------------------------
  tool(
    "list_templates",
    "Project templates for create_project: empty, blank, software (discovery & design → backend and frontend → acceptance test → launch) and custom ones from a folder.",
    { templatesFolder: z.string().optional() },
    (a) => listTemplates(tools, a),
    true
  );
  tool(
    "create_project",
    "Create a new plan in the plan folder from a template (default 'empty': project settings, empty team, inbox and punch list). Refuses when a plan exists. To create everything at once, use build_plan.",
    {
      ...projectSettings,
      name: z.string(),
      template: z.string().optional().describe("empty (default), blank, software or a custom one"),
      templatesFolder: z.string().optional(),
      lead: z.string().optional().describe("Name of the project lead (blank and software)"),
    },
    (a) => createProject(tools, a),
    false
  );
  tool(
    "update_project",
    "Change the project settings: name, code, start, end, work week, hours per day, hours budget, holidays (replace, add or remove).",
    { ...projectSettings, addHolidays: strings.optional(), removeHolidays: strings.optional() },
    (a) => updateProject(tools, a)
  );

  // --- Whole plan ----------------------------------------------------------------------------
  tool(
    "build_plan",
    "Create or extend a whole plan in one call: project settings (creates the project when there is none), people, milestones with sections and tasks (nested subtasks, dependencies by ref or title across milestones), inbox and punch items, test plans. Existing people and milestones (by id or name) are updated and extended. Everything is validated first: when anything is wrong nothing is written and every problem is listed. Returns the new ids per ref and the forecast of each milestone. Use dryRun to check first.",
    {
      project: z
        .object({
          ...projectSettings,
          template: z.string().optional(),
          templatesFolder: z.string().optional(),
          lead: z.string().optional(),
        })
        .optional(),
      people: z.array(z.object(personInput)).optional(),
      milestones: z
        .array(
          z.object({
            ...milestoneInput,
            name: z.string().optional().describe("Needed for new milestones, e.g. 'Documentation'"),
            sections: z
              .array(
                z.union([
                  z.string(),
                  z.object({ title: z.string(), tasks: z.array(taskSpec).optional() }),
                ])
              )
              .optional()
              .describe("Section titles, or { title, tasks }"),
            tasks: z.array(taskSpec).optional().describe("Tasks directly under the milestone"),
          })
        )
        .optional(),
      inbox: strings.optional(),
      punch: z.array(z.object(punchInput)).optional(),
      tests: z.array(testPlanInput).optional(),
      dryRun: z.boolean().optional(),
    },
    (a) => buildPlan(tools, a as never)
  );

  // --- Team ----------------------------------------------------------------------------------
  tool(
    "list_people",
    "The team with capacity, work week, skills, time off, capacity changes, overtime, extra working days, open tasks and this week's load.",
    {},
    () => listPeople(tools),
    true
  );
  tool(
    "add_people",
    "Add people to team.md (created when missing).",
    { people: z.array(z.object(personInput)) },
    (a) => addPeople(tools, a)
  );
  tool(
    "update_person",
    "Change a person: name (keeps the id), role, capacity, work week, skills, colour; replace a list (timeOff, capacityChanges, overtime, workdays) or append to it (addTimeOff, addCapacityChanges, addOvertime, addWorkdays).",
    {
      ...Object.fromEntries(Object.entries(personInput).map(([k, v]) => [k, v.optional()])),
      id: z.string().describe("Person id or name"),
      addTimeOff: strings.optional(),
      addCapacityChanges: strings.optional(),
      addOvertime: strings.optional(),
      addWorkdays: strings.optional(),
    },
    (a) => updatePerson(tools, a as never)
  );
  tool(
    "remove_person",
    "Remove a person from team.md. Their tasks go to reassignTo, or lose their owner.",
    { id: z.string(), reassignTo: z.string().optional() },
    (a) => removePerson(tools, a)
  );

  // --- Milestones ----------------------------------------------------------------------------
  tool(
    "list_milestones",
    "Milestones with target, status, dependencies, description, forecast, progress, sections and their tasks.",
    {},
    () => listMilestones(tools),
    true
  );
  tool(
    "create_milestones",
    "Create milestone files, with sections. depends may name milestones of the same call.",
    { milestones: z.array(z.object({ ...milestoneInput, sections: strings.optional() })) },
    (a) => createMilestones(tools, a)
  );
  tool(
    "update_milestone",
    "Change a milestone: name, target date, status (cancelled cancels its tasks), depends, description. A target, depends or status can move other work: `schedule` in the result says which milestones and tasks move; tell the user.",
    {
      id: z.string().describe("Milestone id or name"),
      name: z.string().optional(),
      target: z.string().optional(),
      status: milestoneInput.status,
      depends: strings.optional(),
      description: z
        .string()
        .optional()
        .describe("Replaces the free text under the heading; '' removes it"),
    },
    (a) => updateMilestone(tools, a)
  );
  tool(
    "add_sections",
    "Add ## sections (units, areas, work packages) to a milestone; existing ones are skipped.",
    { milestone: z.string(), sections: strings },
    (a) => addSections(tools, a)
  );
  tool(
    "delete_milestone",
    "Delete a milestone file; dependencies on its tasks are removed elsewhere, and milestones that depend on it wait for what it waited for instead. Refuses with open tasks unless force (or set status cancelled instead).",
    { id: z.string(), force: z.boolean().optional() },
    (a) => deleteMilestone(tools, a)
  );

  // --- Tasks ---------------------------------------------------------------------------------
  tool(
    "list_tasks",
    "List tasks (leaf tasks by default) with schedule data. Filter by milestone, owner, status, tag, text and a date range that overlaps the scheduled dates.",
    {
      milestone: z.string().optional().describe("Milestone id, e.g. M2"),
      owner: z.string().optional().describe("Person id, or 'unassigned'"),
      status: z.array(status).optional(),
      tag: z.string().optional(),
      text: z
        .string()
        .optional()
        .describe("Words that must all appear in title, id, notes or tags"),
      from: date.optional(),
      to: date.optional(),
      leavesOnly: z.boolean().optional().describe("Only leaf tasks (default true)"),
      limit: z.number().int().positive().optional(),
    },
    (a) => tools.listTasks(a as Parameters<PlannerTools["listTasks"]>[0]),
    true
  );
  tool(
    "get_task",
    "Full task: line, notes, attributes, dependencies, dependents, subtasks and schedule.",
    { id: z.string().describe("Task id, e.g. T105") },
    (a) => tools.getTask(a),
    true
  );
  tool(
    "create_tasks",
    "Add tasks to a milestone (optionally in a ## section, created when missing) or as subtasks of a parent. Give each task a ref; dependsOn may use refs of this call. Subtasks nest. New ids are assigned and returned per ref.",
    {
      milestone: z.string().optional().describe("Milestone id or name (not needed with parent)"),
      section: z.string().optional(),
      parent: z.string().optional().describe("Parent task id"),
      tasks: z.array(taskSpec),
    },
    (a) => createTasks(tools, a)
  );
  tool(
    "update_task",
    "Change a task or punch item: status (writes @started/@done, today unless 'done'/'started' give the real day for past work; parents follow their subtasks unless planner.parentStatus is off; finishing a task with open subtasks needs 'subtasks'), title, estimate, actual, owner, fixed start, due, priority, progress, blocked reason, tags, dependencies (replace, add, remove), any attribute, notes. '' removes a value.",
    taskUpdate,
    (a) => updateTasks(tools, { updates: [a as never] })
  );
  tool(
    "update_tasks",
    "Several task updates (as update_task) in one step.",
    { updates: z.array(z.object(taskUpdate)) },
    (a) => updateTasks(tools, a as never)
  );
  tool(
    "move_task",
    "Move a task with its subtasks and notes to another milestone, section or parent, or right before or after another task (reorder, outdent); its id stays.",
    {
      id: z.string(),
      milestone: z.string().optional(),
      section: z.string().optional(),
      parent: z.string().optional().describe("Becomes the last subtask of this task"),
      before: z.string().optional().describe("Placed right before this task, at its level"),
      after: z.string().optional().describe("Placed right after this task, at its level"),
    },
    (a) => moveTask(tools, a)
  );
  tool(
    "delete_tasks",
    "Delete tasks, punch items or inbox items ('inbox:2'), with their subtasks and notes; dependencies on them are removed.",
    { ids: strings },
    (a) => deleteTasks(tools, a)
  );
  tool(
    "log_time",
    "Add worked time to a task's actual hours (@act).",
    {
      id: z.string(),
      time: z.union([z.string(), z.number()]).describe("1.5, 90m, 1h30m or 1:30"),
    },
    (a) => logTime(tools, a)
  );
  tool(
    "rename_task_id",
    "Rename a task id; every @dep on it follows.",
    { id: z.string(), newId: z.string().describe("e.g. T142") },
    (a) => renameTaskId(tools, a)
  );
  tool(
    "assign_ids",
    "Give ids to tasks and punch items typed without one (all files, or one).",
    { file: z.string().optional() },
    (a) => assignIds(tools, a)
  );

  // --- Inbox and punch list ------------------------------------------------------------------
  tool("list_inbox", "Unplanned items of inbox.md, numbered.", {}, () => listInbox(tools), true);
  tool("capture_inbox", "Add lines to inbox.md (#tags allowed).", { items: strings }, (a) =>
    captureInbox(tools, a)
  );
  tool(
    "plan_inbox_item",
    "Move an inbox item into a milestone (section) as a task with a new id.",
    {
      item: z.union([z.number(), z.string()]).describe("Its number from list_inbox, or its title"),
      milestone: z.string(),
      section: z.string().optional(),
    },
    (a) => planInboxItem(tools, a)
  );
  tool(
    "list_punch_items",
    "Punch items (open ones by default) with severity, owner, due date and origin.",
    {
      status: z.array(status).optional(),
      sev: z.string().optional(),
      owner: z.string().optional(),
      includeClosed: z.boolean().optional(),
    },
    (a) => listPunchItems(tools, a as never),
    true
  );
  tool(
    "add_punch_item",
    "Add a ^P item to punchlist.md (created when missing). With step, it is raised from that test step and linked to it.",
    punchInput,
    (a) => addPunchItems(tools, { items: [a as never] })
  );
  tool(
    "add_punch_items",
    "Several punch items (as add_punch_item).",
    { items: z.array(z.object(punchInput)) },
    (a) => addPunchItems(tools, a as never)
  );

  // --- Tests ---------------------------------------------------------------------------------
  tool(
    "list_tests",
    "Test plans (acceptance, FAT, SAT …) with cases, steps, results and runs.",
    { id: z.string().optional().describe("Test plan id") },
    (a) => tools.listTests(a),
    true
  );
  tool(
    "create_test_plans",
    "Create test plans under tests/ with their cases and steps.",
    { plans: z.array(testPlanInput) },
    (a) => createTestPlans(tools, a)
  );
  tool(
    "add_test_cases",
    "Add test cases to a test plan (before its run logs).",
    { test: z.string(), cases: z.array(testCase) },
    (a) => addTestCases(tools, a)
  );
  const stepResult = {
    test: z.string(),
    case: z.string().describe("Case id, e.g. TC-01"),
    step: z.number().int().positive().describe("1-based step number within the case"),
    result: z.enum(["pass", "fail", "na", "clear"]),
    note: z.string().optional(),
  };
  tool(
    "record_test_result",
    "Record the result of a test step. 'clear' removes the result. For a failure, add_punch_item with step raises and links a punch item.",
    stepResult,
    (a) => recordTestResults(tools, { results: [a as never] })
  );
  tool(
    "record_test_results",
    "Several step results in one step.",
    { results: z.array(z.object(stepResult)) },
    (a) => recordTestResults(tools, a as never)
  );
  tool(
    "finish_test_run",
    "Finish a test run: append '## Run <date>' with tester, witness, result counts, failed cases and punch items.",
    {
      test: z.string(),
      tester: z.string().describe("Who ran the test: a person id or name (recorded as given)"),
      witness: z.string().optional(),
      date: date.optional(),
    },
    (a) => finishTestRun(tools, a)
  );
  tool(
    "reset_test_results",
    "Clear every step result of a test plan to start a new run (punch links stay).",
    { test: z.string() },
    (a) => resetTestResults(tools, a)
  );

  // --- Schedule, views and analysis ----------------------------------------------------------
  tool(
    "get_schedule",
    "Deterministic schedule: task dates, slack, critical path, overtime and milestone forecasts (optionally for one milestone).",
    { milestone: z.string().optional() },
    (a) => tools.getSchedule(a),
    true
  );
  tool(
    "get_team_load",
    "Scheduled hours versus capacity per person and ISO week. Capacity includes planned overtime and extra working days; such weeks also give overtimeCapacity and the overtime scheduled. mode 'demand' shows raw demand if all tasks started as early as possible.",
    { from: date.optional(), to: date.optional(), mode: z.enum(["capacity", "demand"]).optional() },
    (a) => tools.getTeamLoad(a),
    true
  );
  tool(
    "get_dashboard",
    "The dashboard: completion, forecast finish, remaining work, milestone cards with slip since the baseline, burn-up, estimate accuracy, attention lists (overdue, blocked, starting this week, unassigned, unestimated, critical path, planned overtime), tests, punch items.",
    { baseline: z.string().optional().describe("Baseline id or name (default: the latest)") },
    (a) => getDashboard(tools, a),
    true
  );
  tool(
    "get_kanban",
    "The Kanban board: columns per status with cards, optionally in swimlanes and filtered.",
    {
      board: z.enum(["tasks", "punch"]).optional(),
      swimlane: z.enum(["none", "owner", "milestone", "severity"]).optional(),
      owner: z.string().optional(),
      milestone: z.string().optional(),
      tag: z.string().optional(),
      text: z.string().optional(),
      showCancelled: z.boolean().optional(),
      cardMode: z.enum(["tasks", "leaves"]).optional(),
    },
    (a) => getKanban(tools, a),
    true
  );
  tool(
    "validate_plan",
    "All diagnostics: invalid values, unknown owners and dependencies, cycles, late tasks, overbooked people.",
    {},
    () => tools.validatePlan(),
    true
  );
  tool(
    "get_estimate_stats",
    "Actual/estimate ratios of completed tasks per tag and per person.",
    {},
    () => tools.getEstimateStats(),
    true
  );
  tool(
    "calibrate_estimates",
    "Calibrated estimates of open tasks from past accuracy (the person's ratio, else the tag's). With apply: true, the new @est values are written.",
    { minSamples: z.number().int().positive().optional(), apply: z.boolean().optional() },
    (a) => calibrateEstimates(tools, a)
  );

  // --- Baselines and export ------------------------------------------------------------------
  tool(
    "save_baseline",
    "Save the current planned dates as a baseline (baselines/<date>-<name>.json).",
    { name: z.string(), overwrite: z.boolean().optional() },
    (a) => saveBaseline(tools, a)
  );
  tool("list_baselines", "Saved baselines.", {}, () => listBaselines(tools), true);
  tool(
    "compare_baseline",
    "Milestone slip and the tasks that moved most since a baseline (default: the latest).",
    { id: z.string().optional(), limit: z.number().int().positive().optional() },
    (a) => compareBaseline(tools, a),
    true
  );
  tool(
    "export_report",
    "Export the status report (html, pdf), Excel (xlsx), MS Project XML (mspdi), CSV (csv) or the test report of a test plan (test-report, test-report-pdf) into <plan>/reports (or outDir, a folder inside the workspace). Branding and defaults come from the workspace's planner.export.* settings.",
    {
      formats: z.array(
        z.enum([
          "html",
          "pdf",
          "xlsx",
          "mspdi",
          "csv",
          "test-report",
          "test-report-pdf",
          "fat",
          "fat-pdf",
        ])
      ),
      sections: z
        .array(
          z.enum(["header", "summary", "milestones", "gantt", "load", "period", "risks", "tests"])
        )
        .optional(),
      summary: z.string().optional().describe("Summary paragraph of the status report"),
      testPlan: z.string().optional(),
      tester: z.string().optional(),
      witness: z.string().optional(),
      author: z.string().optional(),
      baseline: z.string().optional(),
      periodDays: z.number().int().positive().max(366).optional(),
      ganttWeeks: z.number().int().positive().max(260).optional(),
      csvDelimiter: z.enum([",", ";", "\t"]).optional(),
      browserPath: z.string().optional(),
      outDir: z.string().optional(),
      name: z.string().optional(),
    },
    (a) => exportReport(tools, a as never)
  );

  // --- TODO comments in code -----------------------------------------------------------------
  tool(
    "list_todos",
    "TODO / FIXME comments in the workspace's source code, with the task they are linked to.",
    {
      include: z.string().optional(),
      exclude: z.string().optional(),
      keywords: strings.optional(),
      maxFiles: z.number().int().positive().optional(),
      unlinkedOnly: z.boolean().optional(),
    },
    (a) => listTodos(tools, a),
    true
  );
  tool(
    "promote_todo",
    "Turn a TODO comment into a task (with @src back to the line); the comment gets the id: TODO(T142).",
    {
      file: z.string().describe("Workspace-relative path"),
      line: z.number().int().positive().describe("1-based line"),
      milestone: z.string(),
      section: z.string().optional(),
      title: z.string().optional(),
      owner: z.string().optional(),
    },
    (a) => promoteTodo(tools, a)
  );

  server.registerPrompt(
    "plan_from_text",
    {
      title: "Plan from text",
      description:
        "Build a complete plan (project, team, milestones, tasks, dependencies) from a plain-text description.",
      argsSchema: { text: z.string().describe("Milestones, tasks, people, dates … in plain text") },
    },
    ({ text }) => ({
      messages: [{ role: "user", content: { type: "text", text: planFromTextPrompt(text) } }],
    })
  );

  return server;
}

function readPlanFile(tools: PlannerTools, path: string | undefined) {
  if (!path) return { files: listPlanFiles(tools.planDir) };
  const full = resolve(tools.planDir, path);
  const rel = relative(resolve(tools.planDir), full);
  const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (outside || !existsSync(full) || !statSync(full).isFile())
    throw new ToolError(`No plan file "${path}".`);
  return { path, text: readFileSync(full, "utf8") };
}

export function parseServerArgs(
  argv: string[],
  env = process.env
): { planDir: string; workspaceDir?: string; today?: string } {
  let planDir = env.PLANNER_PLAN_DIR ?? "plan";
  let workspaceDir: string | undefined = env.PLANNER_WORKSPACE;
  let today: string | undefined = env.PLANNER_TODAY;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--plan" && argv[i + 1]) planDir = argv[++i];
    else if (argv[i] === "--workspace" && argv[i + 1]) workspaceDir = argv[++i];
    else if (argv[i] === "--today" && argv[i + 1]) today = argv[++i];
  }
  return {
    planDir: resolve(planDir),
    workspaceDir: workspaceDir ? resolve(workspaceDir) : undefined,
    today,
  };
}

async function main(): Promise<void> {
  const { planDir, workspaceDir, today } = parseServerArgs(process.argv.slice(2));
  const tools = new PlannerTools({ planDir, workspaceDir, today });
  const server = createServer(tools);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`md-planner MCP server: plan folder ${planDir}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(
      `md-planner MCP server failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  });
}
