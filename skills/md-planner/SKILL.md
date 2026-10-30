---
name: md-planner
description: Plan and track a project kept as Markdown files in a plan/ folder (Markdown Project Planner, md-planner). Use when the workspace has plan/project.md, or when the user asks about the project plan, milestones, tasks, estimates, owners, team capacity, time off, deadlines, the schedule or Gantt chart, budget, test plans, punch items or a status report.
---

# Working with an md-planner plan

The plan is a folder of Markdown files (`plan/` by default): `project.md`, `team.md`,
`milestones/*.md`, `tests/*.md`, `punchlist.md` and `inbox.md`. The md-planner VS Code extension
and its MCP server schedule it, check it and change it with the same rules.

## Use the MCP tools

When the md-planner tools are available (`get_plan_overview` and the others), use them to read and
change the plan. They assign ids, keep dependencies valid, change only what they must and refuse a
change that would break the plan, saying why. Read `get_plan_format` once before you build or
change a plan.

When they are not available, ask the user to run **Planner: Configure MCP for Claude Code** in VS
Code (Copilot agent mode finds the server by itself) and to restart the agent. Until then, follow
"Editing the files yourself" below, and check every edit with the planner's command-line tool as
it says.

## Rules

1. **Dates are computed.** When tasks start and finish, milestone forecasts, slack and the critical
   path come from the scheduler: never work them out yourself and never write them into the files.
   Ask `get_schedule`, `list_tasks`, `get_task` or `get_dashboard`; without the tools, the
   command-line tool (see "Editing the files yourself"): `schedule --plan plan --json`. Write a date only where the user
   gives one: a fixed start (`@start`, "not before"), a deadline (`@due`), a milestone target, time
   off, project dates, and the real day past work was finished or began.
   Entering a project that is already under way, give finished work its real day: `done` (and
   `started`) in `create_tasks`, `build_plan`, `update_task` or `update_tasks`. Without them the
   tools write today, and the burn-up, the status report and the late flags then show months of
   work as done this week.
2. **Ids are references.** `^T123` is what `@dep:T123` points at. Never invent or reuse an id: new
   tasks get theirs from the tools. Link tasks created in one call with refs (`create_tasks`,
   `build_plan`). Never copy a task line with its id.
3. **Statuses** change with `update_task` or `update_tasks`: to do, doing, review, blocked (give the
   reason), done, cancelled. They write `@started` and `@done`, and parents follow their subtasks.
   Finishing a task with open subtasks needs a choice for them: ask the user.
4. **Estimates** are hours (`4h`), days (`1.5d`, by the project's hours per day) or weeks (`1w`). A
   parent's own `@est` is a budget that its subtasks without an estimate share. To split a task,
   add subtasks under it without estimates (or with estimates that add up). Worked time goes to
   `log_time` (it adds to `@act`).
5. **People** are the ids in `team.md` (`list_people`). Time off, capacity changes, overtime and
   extra working days go to `update_person`.
6. **Many changes, one call:** `update_tasks`, `build_plan`. Run `build_plan` with `dryRun: true`
   first for a large change.
7. **Ask before replanning.** Propose changes that move other people's work (owners, priorities,
   dependencies, dates), and apply them after the user agrees.

## Common jobs

- **Understand the plan:** `get_plan_overview`, then `list_milestones` or `get_schedule`.
- **Build a plan from a description:** `get_plan_format`, then one `build_plan` call (refs,
  `dependsOn`, `dryRun` first). Report each milestone's forecast against its target.
- **Add work:** `create_tasks` in a milestone (and section) or under a parent task, with an
  estimate, an owner and `dependsOn` when they are known.
- **Someone is away or their hours change:** `update_person`, then `get_schedule`: say which
  milestones and tasks move and by how much.
- **Status for a meeting:** `get_dashboard` (and `compare_baseline` against the last baseline):
  forecasts against targets, what is late and why, budget. Quote the tools; do not estimate dates.
- **A slip:** `get_schedule` shows late tasks with what holds them back ("Held back by …"). Propose
  fixes (another owner, overtime, dependencies, priorities) and apply them when the user agrees.
- **Ideas and defects:** `capture_inbox`, `plan_inbox_item`; `add_punch_item`, `list_punch_items`.
- **Test runs:** `record_test_results`; a failed step gets `add_punch_item` with the step;
  `finish_test_run` at the end.

## Editing the files yourself

Only when the tools are not available, or for free text the tools do not cover. Work in three
steps, and never skip the last one:

1. **Read** the file you change and copy its layout.
2. **Edit** only the characters you must:
   - A task line: `- [ ] Title @est:2d @owner:sam @dep:T101,T105+2d @due:2026-11-20 #tag ^T108`.
     Statuses: `[ ]` to do, `[/]` doing, `[?]` review, `[!]` blocked (`@blocked:"reason"`),
     `[x]` done, `[-]` cancelled. A status change also sets `@started:<date>` (doing) or
     `@done:<date>` (done). Subtasks are indented checkboxes; notes are indented lines under a task.
   - New tasks get no `^T…` id from you: the planner gives every task without one an id when the
     file is saved in VS Code. Never copy a line with its id.
   - A new milestone is a file `milestones/<id>-<name>.md` that starts with `# <id> – <Name>`, then
     `id:`, `target:`, `status:` and `depends:` lines, like the existing milestone files.
   - Keep attributes you do not know, comments and free text. Do not touch `plan/.planner/`,
     `plan/reports/` and `plan/baselines/`: they are generated.
   - When you finish the last open subtask, finish its parent too (`[x]` with `@done`); when you
     start a subtask, a parent that is still to do becomes `[/]` with `@started`.
   - Pitfalls: a copied line keeps its id (two tasks with one id); `@started` on a to-do task is
     ignored; an open task under a cancelled or done task is not scheduled; a date in the wrong
     year falls outside the project.
3. **Check** the plan, always: with the tools, `validate_plan`. Without them, run the planner's
   command-line tool from the VS Code extension folder:
   `node ~/.vscode/extensions/acro.md-planner-<version>/dist/cli.js validate --plan plan`. It lists
   every problem and exits with 1 on errors. Fix the errors your edit caused. Warnings, notes and
   hints are advice: tell the user about new ones, but do not change what they asked for to silence
   them.

## Explaining results

Quote what the tools report: late tasks and milestones come with their cause ("Held back by the
fixed start … of T461"), blocked tasks with what waits for them and how long they can stay
blocked, people with too much work with a note in `team.md`. Hours are the unit of work.
