# 18. Glossary

The words the planner and this manual use, in one sentence each, with the place that explains
them. Attributes and properties are shown as you write them in a plan file.

| Term                       | Meaning                                                                                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actual hours (`@act`)      | Time spent on a task, logged with the timer or by hand. [Time tracking](11-time-tracking.md)                                                                                                         |
| Baseline                   | A saved copy of the planned dates, to see later how much they have moved. [Baselines](10-dashboard-and-baselines.md#baselines)                                                                       |
| Blocked                    | A task status, `[!]`, with a reason (`@blocked:"…"`). It is still scheduled. [Status](04-plan-files.md#status)                                                                                       |
| Budget                     | The hours set aside for the whole project (`budget:` in `project.md`). [Budget](10-dashboard-and-baselines.md#budget)                                                                                |
| Capacity                   | The hours a person can work per week or per day (`capacity:`), changed from a date on with `capacityFrom:`. [team.md](04-plan-files.md#teammd)                                                       |
| CodeLens                   | The grey, clickable lines above milestone headings and tasks in the editor: the schedule and actions. [CodeLens](05-editor.md#codelens-the-schedule-and-actions-inline)                              |
| Critical path              | The chain of tasks that sets the end date: if one of them slips, the end slips. Red outlines on the Gantt. [Analysis](16-how-scheduling-works.md#analysis)                                           |
| Demand                     | The team-load view as if everyone started everything as early as possible, ignoring capacity: where work piles up. [Scheduled and Demand](09-team-load.md#scheduled-and-demand)                      |
| Dependency (`@dep`)        | "Start after these tasks are finished." A milestone's `depends:` makes all its tasks wait for other milestones. [Dependencies](16-how-scheduling-works.md#dependencies)                              |
| Diagnostic                 | An error, warning, info or hint about the plan, in the Problems panel and as a squiggle in the file. [Diagnostics](05-editor.md#diagnostics)                                                         |
| Due date (`@due`)          | The date a task must be finished by.                                                                                                                                                                 |
| Estimate (`@est`)          | How much work a task is: hours (`4h`), days (`2d`) or weeks (`1w`). [Attributes](04-plan-files.md#attributes)                                                                                        |
| Extra working day          | A weekend day or holiday on which one person works (`workday:`). [Overtime and extra working days](09-team-load.md#overtime-and-extra-working-days)                                                  |
| Fixed start (`@start`)     | "Not before this date." Dependencies still come first.                                                                                                                                               |
| Forecast                   | When a milestone or the project is expected to finish, from the schedule.                                                                                                                            |
| Inbox                      | Ideas and requests that are not planned yet (`inbox.md`). [inbox.md](04-plan-files.md#inboxmd)                                                                                                       |
| Lag                        | Working days between the end of one task and the start of the next: `@dep:T303+2d`.                                                                                                                  |
| Late                       | Scheduled to finish after its due date or its milestone's target. **Overdue**: the due date has already passed and the task is still open.                                                           |
| Leaf task                  | A task without subtasks. Only leaf tasks are scheduled; their parents add them up. [Subtasks and notes](04-plan-files.md#subtasks-and-notes)                                                         |
| MCP server                 | The planner's connection for AI agents such as Claude Code: tools to read and change the plan safely. [The MCP server](15-mcp-and-cli.md#the-mcp-server)                                             |
| Milestone                  | A goal with a target date: one file in `milestones/` with its tasks. [Milestone files](04-plan-files.md#milestone-files)                                                                             |
| Notes                      | Indented lines under a task that are not tasks: its description.                                                                                                                                     |
| Overtime                   | Extra hours for one person in a period (`overtime:`). [Overtime and extra working days](09-team-load.md#overtime-and-extra-working-days)                                                             |
| Owner (`@owner`)           | The person who does the task. Subtasks without an owner take their parent's.                                                                                                                         |
| Plan folder                | The folder of Markdown files that is the plan, `plan/` by default. [The plan folder](04-plan-files.md#the-plan-folder)                                                                               |
| Priority (`@prio`)         | `high`, `med` (the default) or `low`: which of a person's ready tasks gets their hours first.                                                                                                        |
| Property                   | A `key: value` line right under a heading, such as `target: 2026-12-18`. [Property blocks](04-plan-files.md#property-blocks)                                                                         |
| Punch item                 | A defect or open point (`P001`) with a severity: A blocks acceptance, B must be fixed before the site acceptance test, C may wait until after handover. [punchlist.md](04-plan-files.md#punchlistmd) |
| Remaining work             | What is left of a task: estimate minus actual hours, or by `@progress`. [Remaining work](04-plan-files.md#remaining-work)                                                                            |
| Section                    | A `##` heading in a milestone file: a work package such as a feature or a component.                                                                                                                 |
| Skill                      | A file that teaches AI agents the planner's rules. [Instructions and the skill](15-mcp-and-cli.md#teach-the-agent-the-rules-instructions-and-the-skill)                                              |
| Slack                      | How many working days a task can slip before it delays the last milestone target.                                                                                                                    |
| Slip                       | How far a date has moved since the baseline.                                                                                                                                                         |
| Status                     | to do `[ ]`, in progress `[/]`, review `[?]`, blocked `[!]`, done `[x]`, cancelled `[-]`. [Status](04-plan-files.md#status)                                                                          |
| Swimlane                   | A row of the Kanban board, one per owner or milestone. [Swimlanes](08-kanban.md#swimlanes)                                                                                                           |
| Target                     | The date a milestone is due (`target:`). It is late when its forecast is after the target.                                                                                                           |
| Test plan, case, step, run | A file in `tests/` with test cases, their steps, and a dated log of each run with its results. [Tests and punch list](12-tests-and-punch-list.md)                                                    |
| Time off                   | Days a person does not work (`off:`). [team.md](04-plan-files.md#teammd)                                                                                                                             |
| Unassigned                 | The pool that tasks without an owner are scheduled in, 40 hours a week by default.                                                                                                                   |
| WIP limit                  | The most cards a Kanban column should hold; a full column's header turns red. [Move cards](08-kanban.md#move-cards)                                                                                  |
| Work week                  | The working days of the project (`workweek: mon-fri`), or of one person.                                                                                                                             |

---

[← Power-user guide](17-power-user-guide.md) · [Contents](README.md)
