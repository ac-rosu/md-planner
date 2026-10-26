// The plan format and the way to work with the tools, for agents: the server's instructions (sent
// when a client connects), get_plan_format and the prompts. The agent skill (skills/md-planner)
// says the same for agents that edit the files too; tests check that all of them name real tools.

/** What every client gets when it connects (MCP `instructions`): the rules that matter most. */
export const SERVER_INSTRUCTIONS = `md-planner keeps a project plan as Markdown files in a plan folder (project.md, team.md,
milestones/*.md, tests/*.md, punchlist.md, inbox.md). These tools read and change it with the same
rules as the VS Code extension.

- Start with get_plan_overview. Read get_plan_format once before you build or change a plan.
- Change the plan with the tools, not by editing the files: they keep ids and dependencies right,
  change only what they must, and refuse a change that would break the plan, saying why.
- Never work out or write dates the scheduler computes (when tasks start and finish, milestone
  forecasts): ask get_schedule, list_tasks or get_dashboard. Write a date only where the user gives
  one: @start, @due, a milestone target, time off.
- Never invent task ids: the tools assign them. Link tasks created in one call with refs.
- A parent's @est is a budget that its subtasks without an estimate share. Change statuses with
  update_task or update_tasks: they write @started/@done and move parents along.
- For a large change, run build_plan with dryRun: true first.
- If you edit a plan file yourself, call validate_plan afterwards and fix every error.
- Explain lateness with the causes the tools report (late tasks say what holds them back).`;

export const PLAN_FORMAT = `# Markdown Project Planner – plan format and tools

A plan is a folder (default plan/) of Markdown files. The tools read and write these files with
minimal edits; you never need to write Markdown yourself. Dates are YYYY-MM-DD; durations are
hours (4h), days (1.5d = 1.5 × hoursPerDay) or weeks (1w = 5 days).

## Files
- project.md – name, code, start, end, workweek (mon-fri, mon-thu, sun-thu …), hoursPerDay,
  holidays (dates and from..to ranges), budget (hours for the whole project: 800h).
- team.md – one "## Name" section per person: id (used in @owner), role, capacity (40h/week,
  6h/day; default full time), capacityFrom (2027-01-01 32h/week), workweek, skills, color,
  off (time off, repeatable), overtime (2026-11-02..2026-11-13 +8h/week, repeatable),
  workday (a weekend day or holiday worked: 2026-11-28 or 2026-11-28 6h, repeatable).
- milestones/<id>-<name>.md – one milestone: "# M2 – Backend", id, target (due date),
  status (planned | active | done | cancelled), depends (other milestones that must finish
  first), a description, "## Section" headings (units, areas, work packages) and tasks.
- tests/<id>-<name>.md – a test plan (acceptance, FAT, SAT, IT, unit): id, type, milestone, eq, witness, "## TC-01 Title"
  cases with pre: and checkbox steps; results @result:pass|fail|na, @note, @punch; "## Run <date>"
  logs.
- punchlist.md – defects and open points: ^P001 items with @sev:A|B|C, @owner, @due, @from.
- inbox.md – unplanned ideas, planned later into a milestone.

## Tasks
"- [ ] Title @est:2d @owner:sam @dep:T101,T105+2d @start:2026-11-02 @due:2026-11-20
@prio:high #tag ^T108"
- Status: [ ] to do, [/] in progress, [?] review, [!] blocked (@blocked:"reason"), [x] done,
  [-] cancelled. @started/@done dates are written when the status changes.
- @dep: finish-to-start dependencies on task ids, with an optional lag in working days (+2d).
- @start: not before this date. @due: deadline. @prio: high | low (med is the default).
- @act: actual hours. @progress: 40% (else actual hours count). Other attributes: @eq (equipment),
  @test (test plan), @src (source code line), and custom ones.
- Subtasks are indented checkboxes. A parent with its own @est gives that budget to its subtasks
  without an estimate (they share what the estimated ones leave); without @est its estimate is the
  sum of its subtasks. Parents follow their subtasks' status. Notes are indented lines under a task.
- Ids (^T…) are assigned by the tools; never invent ids for new tasks – use refs instead. A task
  line copied with its id is a second task with that id: create tasks with the tools instead.

## Scheduling (computed, never written)
Leaf tasks are scheduled from today in priority order on their owner's capacity (time off,
holidays, overtime and extra working days included), after their dependencies and fixed starts.
Tasks without an owner run in the Unassigned pool (40 h/week). A milestone's forecast is the
latest finish of its tasks; it is late when the forecast is after its target.

## How to work
1. get_plan_overview – what exists (or that there is no plan yet).
2. To build or extend a plan from a description: one build_plan call with project settings
   (only when there is no plan), people, milestones with sections and tasks. Give each task a
   ref and use refs in dependsOn (refs work across milestones; titles work too). Use dryRun:
   true first for large plans. build_plan writes nothing when anything is invalid and says why.
3. Check get_schedule (or the milestones in the build_plan result) for late milestones and
   validate_plan for warnings; fix with update_tasks, update_person (overtime, capacity),
   update_milestone.
4. Day to day: update_tasks (status, estimate, owner, dependencies …), log_time, add_punch_item,
   record_test_results, capture_inbox, save_baseline, export_report.
5. If you edit a plan file yourself, call validate_plan afterwards and fix every error.
`;

export function planFromTextPrompt(text: string): string {
  return `Build a project plan in the md-planner plan folder from the description below.

${PLAN_FORMAT}

Steps:
1. Call get_plan_overview to see whether a plan exists and who is in the team.
2. Turn the description into one build_plan call:
   - project: name, start and end dates, work week, hours per day, holidays (only when there is
     no plan yet; ask yourself what the description implies, use today as the start otherwise);
   - people with role, capacity, skills and known time off;
   - milestones with target dates, status, depends, sections and tasks;
   - every task with a ref, a clear title, an estimate, an owner when known, dependsOn using refs,
     fixed starts and due dates when the text gives them, tags for units or areas.
   Run it with dryRun: true first, fix every problem it reports, then run it for real.
3. Report the result: what was created, the forecast of each milestone against its target, the
   critical path (get_schedule) and anything you had to assume.

Description:
${text}`;
}
