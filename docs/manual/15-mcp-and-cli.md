# 15. MCP server and command line

The planner's core also runs outside the VS Code views: as an **MCP server**, so that AI agents such
as Claude Code or Copilot agent mode can read and update the plan, and as a **command-line tool**
for scripts and CI. Both use exactly the same parser, scheduler and minimal-diff writer as the
extension, so the results are identical.

## The MCP server

Everything you can do in the planner, an AI agent can do through its MCP server: create a project,
build the whole plan (team, milestones, sections, tasks, dependencies) from a plain-text
description, and keep it up to date day to day. The coverage is complete: every command of the
extension and every edit in its views has a tool, and a test in the extension's test suite fails
when a new command has none.

### Connect an agent

- **New project** writes `.mcp.json` in the workspace folder automatically (setting
  `planner.mcp.configureOnNewProject`, on by default), so Claude Code started in that folder finds
  the server. Approve the `md-planner` server when Claude Code asks.
- **Planner: Configure MCP for Claude Code** does the same at any time, also when there is no plan
  yet. The agent can then create the project itself.
- **Copilot agent mode** (VS Code 1.101 and later) gets the server without any configuration, under
  the name **Markdown Project Planner**, in a workspace with a plan. In a workspace without a plan,
  run **Configure MCP** first; other projects do not get the planner's tools.

The entry in `.mcp.json` (other entries are kept):

```json
{
  "mcpServers": {
    "md-planner": {
      "type": "stdio",
      "command": "<path of VS Code's runtime>",
      "args": [
        "<VS Code global storage>/mcp-server.js",
        "--plan",
        "<absolute path of the plan folder>",
        "--workspace",
        "<absolute path of the workspace folder>"
      ],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

- The server runs on VS Code's own runtime, so no separate Node.js installation is needed.
- `--workspace` is the folder whose `.vscode/settings.json` the server reads (export branding,
  author, TODO globs) and the root for TODO comments and relative paths. Without it, the server
  takes the nearest folder above the plan whose `planner.planFolder` points at the plan, else the
  plan folder's parent.
- The server file is copied to VS Code's global storage, so extension updates do not break the
  path; the copy is refreshed when the extension starts. Run the command again if VS Code itself
  is moved or reinstalled, or the plan folder moves.

### Teach the agent the rules: instructions and the skill

Tools alone do not tell an agent how a plan works. Two things do:

- **Instructions.** Every client gets the most important rules from the server when it connects:
  start with `get_plan_overview`, change the plan with the tools, never work out or write the dates
  the scheduler computes, never invent task ids, call `validate_plan` after editing a file by hand.
- **The md-planner skill.** **Planner: Add the md-planner Skill for AI Agents** writes
  `.claude/skills/md-planner/SKILL.md` into the workspace folder (New project does it along with
  `.mcp.json`; the command is also in the Milestones view's welcome page and the walkthrough).
  Claude Code and Copilot agent mode load it when you ask them about the plan. It holds the rules
  in more detail, playbooks for common jobs (build a plan from a description, someone is away, a
  status for a meeting, a slip), and what to watch for when an agent edits the files itself,
  which agents with file access often do instead of using the tools.

The skill is plain Markdown: commit it with the plan, or add your own conventions to it. A copy
that you did not change is updated when a new version of the extension brings a new text; a copy
you changed is left alone (run the command again to replace it, after a question).

### Let an agent build the plan from text

Write what you know, in your own words, and ask the agent to plan it:

```text
Plan version 3 of our mobile app, from 19 October 2026 to the end of March 2027.
Holidays 25 and 26 December. Team: Alex (project lead, 32 h a week), Sam (backend, off
16–20 November), Priya (frontend).
Discovery until 20 November: Sam makes the integration inventory (3 days), then Alex writes the
specification: user stories (2 days) and an internal review (half a day).
Backend until end of January, after the specification: shared API library (1 week, two days after
the specification), then the services (2 weeks, high priority).
Frontend screens (2 weeks, Priya) can start as soon as the integration inventory is done;
target 12 February.
```

The agent turns this into one **build_plan** call. The server then:

1. creates the project when there is none (or changes its settings);
2. adds the people (or updates the ones that exist);
3. creates the milestones with their sections (or extends existing ones);
4. creates every task with its estimate, owner, dates and subtasks, and resolves the dependencies,
   which the agent gives as references (`dependsOn: ["io"]`, `["fds+2d"]`) or titles, also across
   milestones;
5. validates everything, and writes all files in one go, or **nothing** when anything is wrong,
   listing every problem (an unknown owner, a date in the wrong format, a dependency that does not
   exist or would create a loop);
6. answers with the new ids and the forecast of every milestone against its target.

A `dryRun` first checks a large plan without writing. MCP clients that support prompts also offer
**plan_from_text**, which gives the agent these instructions together with the plan format.

### Tools

**Start and format**

| Tool                | Does                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_plan_overview` | Project settings and hours (budget, planned, logged, forecast, why over budget), people, milestones with forecasts, counts, test plans, the next free ids – or that there is no plan. |
| `get_plan_format`   | The plan format, how scheduling works and how to use the tools.                                                                                                                       |
| `read_plan_file`    | The Markdown of a plan file, or the list of plan files.                                                                                                                               |

**Project and whole plan**

| Tool             | Does                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `list_templates` | The templates: `empty`, `blank`, `software` and custom ones.                                                  |
| `create_project` | A new plan from a template (refuses when one exists).                                                         |
| `update_project` | Name, code, start, end, work week, hours per day, budget, holidays (replace, add, remove).                    |
| `build_plan`     | Project, people, milestones with sections and tasks, inbox, punch items and test plans in one validated step. |

**Team**

| Tool            | Does                                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_people`   | People with capacity, work week, skills, time off, capacity changes, overtime, extra working days and this week's load.                       |
| `add_people`    | Adds people to `team.md`.                                                                                                                     |
| `update_person` | Name (keeps the id), role, capacity, work week, skills, colour; replaces or appends time off, capacity changes, overtime, extra working days. |
| `remove_person` | Removes a person; their tasks go to someone else or lose their owner.                                                                         |

**Milestones**

| Tool                | Does                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `list_milestones`   | Milestones with target, forecast, progress, description, sections and their tasks.       |
| `create_milestones` | Milestone files with sections; dependencies may name milestones of the same call.        |
| `update_milestone`  | Name, target, status, dependencies, description.                                         |
| `add_sections`      | `##` sections.                                                                           |
| `delete_milestone`  | Deletes a milestone and every dependency on it (refuses with open tasks unless `force`). |

**Tasks**

| Tool                          | Does                                                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_tasks`, `get_task`      | Tasks with schedule data; one task in full.                                                                                                                                                             |
| `create_tasks`                | Tasks in a milestone, section or under a parent, with refs, nested subtasks, dependencies (with lag), notes and any attribute.                                                                          |
| `update_task`, `update_tasks` | Status, title, estimate, actual, owner, fixed start, due, priority, progress, blocked reason, tags, dependencies, any attribute, notes.                                                                 |
| `move_task`                   | To another milestone, section or parent (the id stays). Refuses to put open work under a cancelled or done task or into a cancelled milestone; returns the new `file#line` key of a task without an id. |
| `delete_tasks`                | Tasks, punch items or inbox items, with the dependencies on them.                                                                                                                                       |
| `log_time`                    | Adds worked time to `@act`.                                                                                                                                                                             |
| `rename_task_id`              | Renames an id; every `@dep` follows.                                                                                                                                                                    |
| `assign_ids`                  | Ids for tasks typed without one.                                                                                                                                                                        |

**Inbox, punch list and tests**

| Tool                                                | Does                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| `list_inbox`, `capture_inbox`                       | The inbox, numbered; new lines.                                                |
| `plan_inbox_item`                                   | Moves an inbox item into a milestone as a task.                                |
| `list_punch_items`                                  | Punch items by status, severity, owner.                                        |
| `add_punch_item`, `add_punch_items`                 | New punch items; with `step`, raised from a failed test step and linked to it. |
| `list_tests`, `create_test_plans`, `add_test_cases` | Test plans, new plans with cases and steps, more cases.                        |
| `record_test_result`, `record_test_results`         | Step results (`pass`, `fail`, `na`, `clear`) with notes.                       |
| `finish_test_run`, `reset_test_results`             | The run log (`## Run <date>`); clearing results for a new run.                 |

**Schedule, reports and code**

| Tool                                                  | Does                                                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `get_schedule`                                        | Task dates, slack, critical path, overtime, milestone forecasts.                         |
| `get_team_load`                                       | Hours against capacity per person and ISO week (scheduled or demand), with overtime.     |
| `get_dashboard`, `get_kanban`                         | The dashboard and the Kanban board as data.                                              |
| `validate_plan`                                       | All diagnostics, as in the Problems panel.                                               |
| `get_estimate_stats`, `calibrate_estimates`           | Estimate accuracy; calibrated estimates (written with `apply`).                          |
| `save_baseline`, `list_baselines`, `compare_baseline` | Baselines and slip since a baseline.                                                     |
| `export_report`                                       | Status report (HTML, PDF), Excel, MS Project XML, CSV, test report into `plan/reports/`. |
| `list_todos`, `promote_todo`                          | TODO comments in the code; one turned into a linked task.                                |

The AI commands of the extension (break down, estimate, suggest owners, plan from text, status
summary, schedule review) need no tool of their own: over MCP, the agent is the language model and
uses the tools above.

### Safe by design

- **Minimal edits.** The tools change only the characters that change (comments, notes and unknown
  attributes stay), and every write returns the changed lines.
- **Validated, all or nothing.** A change that would add an error to the plan (an unknown
  dependency, a loop, a duplicate id …) is refused and nothing is written; the answer says why.
- **Up to date.** The server reads the plan folder at every call, so it sees your saved edits, and
  the extension shows the agent's changes at once (also a plan the agent has just created).
- Settings such as the export branding come from the workspace's `.vscode/settings.json`.

> [!IMPORTANT]
> The MCP server works on the files on disk. Save your open plan files before you ask an agent to
> change the plan, and review its changes in git (or in VS Code's Source Control view) afterwards.

### Things to ask

- _"Plan this project:"_ followed by milestones, tasks, people and dates in your own words.
- _"Add a milestone Documentation after the launch, with an admin guide (3 days, Jordan) and a user
  manual (4 days, Maria)."_
- _"M5 is late. Plan overtime for the people on its critical path until it is on time, and tell me
  how many hours that is."_
- _"Sam is ill next week: add the time off and move their critical tasks to someone with room."_
- _"Break down T113 into subtasks of at most one day each and add them under it."_
- _"Record TC-02 step 1 of UAT-01 as failed and raise a B punch item for Sam."_
- _"Save a baseline called 'after sign-off' and export the status report as PDF."_

## The command line

The extension contains a command-line tool, `dist/cli.js`, for CI pipelines and scripts. It is a
single self-contained JavaScript file that needs Node.js 20 or later.

**Where to find it:** in the extension folder, for example
`~/.vscode/extensions/acro.md-planner-1.0.0/dist/cli.js` (on Windows under
`%USERPROFILE%\.vscode\extensions\`). For CI, copy the file into your repository, for example as
`tools/planner.js`, so the pipeline does not depend on a VS Code installation.

```sh
node tools/planner.js help
node tools/planner.js help export
node tools/planner.js --version
```

### validate

Checks the plan: the same diagnostics as the Problems panel, including late and unschedulable
tasks.

```sh
node tools/planner.js validate --plan plan
node tools/planner.js validate --plan plan --strict --json
```

```text
plan/milestones/M5-launch.md:24:6: warning late-task: Scheduled to finish 2027-03-31, after the M5 target 2027-03-26 (3 working days late).
11 files, 50 tasks: 0 error(s), 1 warning(s), 0 info
```

Exit code **0** when there are no errors, **1** when there are errors (or warnings, with
`--strict`), **2** for bad arguments or a missing plan folder.

### schedule

Prints the computed schedule: milestone forecasts and every open task with owner, dates and slack.

```sh
node tools/planner.js schedule --plan plan
node tools/planner.js schedule --plan plan --json --mode demand
```

```text
Milestone              Target      Forecast    Variance     Progress
---------------------  ----------  ----------  -----------  --------
M1 Discovery & Design  2026-10-30  2026-10-20  -8 d         62%
M5 Launch              2027-03-26  2027-03-31  +3 d (late)  0%
```

### export

Writes the same files as **Planner: Export…** to `<plan>/reports` (or `--out`).

```sh
node tools/planner.js export --plan plan --format html,pdf,xlsx,mspdi,csv
node tools/planner.js export --plan plan --format test-report-pdf --test UAT-01
node tools/planner.js export --plan plan --format html \
  --company "Example Corp" --accent "#0f766e" --logo docs/logo.svg --author "Alex Morgan" \
  --summary "Discovery on track; launch forecast 3 days late."
```

The command line does not read VS Code settings, so branding and other report options are passed
as flags.

### Options

| Option                                                         | Commands           | Meaning                                                                                          |
| -------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------ |
| `--plan <dir>`                                                 | all                | Plan folder (default `./plan`).                                                                  |
| `--today <YYYY-MM-DD>`                                         | all                | Compute as of this date (default: today). Useful for reproducible output.                        |
| `--json`                                                       | validate, schedule | Machine-readable output.                                                                         |
| `--strict`                                                     | validate           | Also fail on warnings.                                                                           |
| `--mode capacity\|demand`                                      | schedule           | Resource-constrained (default) or demand schedule.                                               |
| `--unassigned-capacity <h>`                                    | all                | Hours per week of the unassigned pool (default 40).                                              |
| `--format <list>`                                              | export             | `html`, `pdf`, `xlsx`, `mspdi`, `csv`, `test-report`, `test-report-pdf`, comma-separated.        |
| `--out <dir>`                                                  | export             | Output folder (default `<plan>/reports`).                                                        |
| `--sections <list>`                                            | export             | Report sections: `header`, `summary`, `milestones`, `gantt`, `load`, `period`, `risks`, `tests`. |
| `--summary <text>`                                             | export             | Status summary text.                                                                             |
| `--period <days>`                                              | export             | Reporting period (default 7).                                                                    |
| `--weeks <n>`                                                  | export             | Weeks in the report's Gantt and team load (default 12).                                          |
| `--test <id>`                                                  | export             | Test plan for `test-report` / `test-report-pdf` (default: the first one).                        |
| `--baseline <id>`                                              | export             | Baseline (file name without `.json`) for trends (default: the latest).                           |
| `--author`, `--company`, `--accent <#rrggbb>`, `--logo <file>` | export             | Report header and branding.                                                                      |
| `--browser <path>`                                             | export             | Edge or Chrome for PDF (default: detect).                                                        |
| `--delimiter <char>`                                           | export             | CSV delimiter (default `,`).                                                                     |

### Example: GitHub Actions

Validate the plan on every pull request and publish the status report as an artifact:

```yaml
name: Plan
on: [pull_request]
jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: node tools/planner.js validate --plan plan --strict
      - run: node tools/planner.js export --plan plan --format html,xlsx --out out
      - uses: actions/upload-artifact@v4
        with:
          name: status-report
          path: out/
```

---

[← AI assistant](14-ai-assistant.md) · [Contents](README.md) · [Next: How scheduling works →](16-how-scheduling-works.md)
