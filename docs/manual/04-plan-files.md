# 4. Plan files

Everything the planner knows lives in plain Markdown files in the plan folder. You can edit them
by hand, with the forms and views ([Add and edit from the UI](03-add-and-edit.md)), through
commands, the AI, the MCP server or the command line; all of them change the same files in the same
way. This chapter is the complete reference of the format.

## The plan folder

| Path                     | Contents                                              | Written by                 |
| ------------------------ | ----------------------------------------------------- | -------------------------- |
| `project.md`             | Name, code, dates, work week, hours per day, holidays | You, forms                 |
| `team.md`                | People: capacity, skills, colour, time off            | You, forms                 |
| `milestones/*.md`        | One file per milestone: sections and tasks            | You, forms, views, AI      |
| `tests/*.md`             | Test plans: test cases, steps, results, run logs      | You, the test runner       |
| `punchlist.md`           | Defects and open points (`^P001` …)                   | You, forms, test runner    |
| `inbox.md`               | Unplanned ideas and requests                          | You, forms                 |
| `baselines/*.json`       | Saved schedule snapshots (commit them)                | **Planner: Save baseline** |
| `.planner/schedule.json` | Cache of the computed schedule (git-ignored)          | The extension              |
| `reports/`               | Exports (git-ignored by default)                      | **Planner: Export…**       |

Only `project.md` is required; every other file is optional.

### Edits are minimal

Whatever changes a file (a form, a click in a view, a drag on the Gantt, a command, an accepted AI
proposal), only the characters that need to change are rewritten. Your comments, free text,
blank lines, unknown attributes, line endings (LF or CRLF), a byte-order mark and trailing spaces
all stay exactly as they were, so git diffs show only the real change. Every edit is a normal VS
Code edit: Cmd+Z undoes it, and the file is marked as modified until saved (views save
automatically, see `planner.autoSave`).

## Property blocks

Files have no YAML front matter. Metadata is written as `key: value` lines directly under a heading:

```markdown
# M2 – Backend

id: M2
target: 2026-12-15
status: active # planned | active | done | cancelled
depends: M1

Free text after the property block is a description and is kept as it is.
```

Rules:

- A property line is `key:` followed by a space (or the end of the line) and the value. A line such
  as `See https://example.com` is not a property, because there is no space after the colon.
- The block is the run of consecutive property lines after the heading. Blank lines are allowed
  only between the heading and the first property; the first other line ends the block.
- `#` (space, hash, space) starts a comment: `capacity: 32h/week # rest goes to lead work`.
- Some keys may be repeated, for example `off:` and `capacityFrom:` in `team.md`. All lines count.
- Dates are always `YYYY-MM-DD`; ranges are `from..to` (both days included).

## project.md

```markdown
# Customer Portal 2.0

code: P-2026-014
start: 2026-10-01
end: 2027-03-31
workweek: mon-fri
hoursPerDay: 8
budget: 800h # hours agreed with the customer
holidays: 2026-12-25, 2026-12-26, 2027-01-01, 2027-04-27
template: software # phase template used by 'New project'

Free description of the project.

## Phases

- Discovery & design → M1
- Backend → M2
```

| Property      | Example                              | Meaning                                                                                                                                                          |
| ------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (heading)     | `# Customer Portal 2.0`              | Project name, shown in views and reports.                                                                                                                        |
| `code`        | `P-2026-014`                         | Project or order number, shown in reports.                                                                                                                       |
| `start`       | `2026-10-01`                         | First day anything can be scheduled.                                                                                                                             |
| `end`         | `2027-03-31`                         | Planned end; the dashboard shows how far the forecast finish is from it.                                                                                         |
| `workweek`    | `mon-fri`, `mon-thu`, `sun-thu`      | Working days of the project.                                                                                                                                     |
| `hoursPerDay` | `8`                                  | Hours in a working day (0–24). Defines `d` in durations.                                                                                                         |
| `budget`      | `800h`, `100d`, `20w`                | Hours budgeted for the whole project. The dashboard compares it with the plan. A decimal comma works (`12,5h`); `1,200h` is refused as ambiguous: write `1200h`. |
| `holidays`    | `2026-12-25, 2026-12-28..2026-12-31` | Non-working days for everybody, comma-separated dates and ranges. `holiday:` also works.                                                                         |
| `template`    | `software`                           | Informational: the template the project was created from.                                                                                                        |
| `## Phases`   | `- Backend → M2`                     | Informational list of phases and their milestones.                                                                                                               |

## team.md

One `##` section per person:

```markdown
# Team

## Alex

id: alex
role: Project lead / backend
capacity: 32h/week # rest goes to lead work
skills: backend, frontend, architecture
color: blue
off: 2026-12-22..2027-01-02

## Sam

role: Backend developer
capacity: 40h/week
off: 2026-11-17..2026-11-21
overtime: 2026-11-02..2026-11-13 +8h/week # catch up on M2 before the holiday

## Jordan

role: DevOps engineer
capacity: 24h/week # part-time on this project
capacityFrom: 2027-01-01 32h/week
skills: infrastructure, integration, rollout
color: orange

## Maria

role: Test engineer
capacity: 4h/day
workweek: mon-thu
workday: 2026-11-27 # extra Friday for the internal test round
skills: test, uat, golive, documentation
color: yellow
```

| Property       | Example                                | Meaning                                                                                                                                                                                             |
| -------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (heading)      | `## Jordan`                            | The person's name.                                                                                                                                                                                  |
| `id`           | `alex`                                 | The id used in `@owner:`. Default: the heading in lower case, spaces as dashes (`## Robin Lee` → `robin-lee`).                                                                                      |
| `role`         | `Backend developer`                    | Shown in views, owner pickers and hovers.                                                                                                                                                           |
| `capacity`     | `32h/week`, `6h/day`                   | Hours available for this project. Default: full time (`hoursPerDay` × working days).                                                                                                                |
| `capacityFrom` | `2027-01-01 24h/week`                  | New capacity from a date on. Repeat for several changes.                                                                                                                                            |
| `workweek`     | `mon-thu`                              | The person's own working days. Weekly capacity is spread over them.                                                                                                                                 |
| `off`          | `2027-02-09`, `2026-11-17..2026-11-21` | Time off: no work is scheduled. Repeat the line for more periods.                                                                                                                                   |
| `overtime`     | `2026-11-02..2026-11-13 +8h/week`      | Extra hours on the person's working days during a period (or one day): `+8h/week` is spread over the working days, `+2h/day` is added to each. The `+` is optional. Repeat for more periods.        |
| `workday`      | `2026-11-27`, `2026-11-28 6h`          | A day the person works although it is a weekend, a holiday or outside their work week: a normal day's hours, or the hours given (`6h`, `0.5d`). A range `from..to` works too. Repeat for more days. |
| `skills`       | `backend, frontend`                    | Used by **AI: Suggest owners**.                                                                                                                                                                     |
| `color`        | `blue`                                 | The person's colour on the Gantt, Kanban and heatmap: `blue`, `green`, `purple`, `orange`, `yellow`, `red`.                                                                                         |

The id `unassigned` is reserved for the virtual pool that runs tasks without an owner.

**Overtime and extra working days** are planned capacity: the scheduler uses them like normal
hours, the team load marks them, and the dashboard and status report add up how much of them is
scheduled. Time off wins over both: an `off` day stays free. The editor warns about entries that
have no effect: overtime in a period without working days, or a `workday` that is already a working
day (use `overtime` for extra hours on a working day).

## Milestone files

Each file in `milestones/` is one milestone. Name files `M<number>-<slug>.md`
(`M2-backend.md`) so they sort in order.

```markdown
# M2 – Backend

id: M2
target: 2026-12-15
status: active
depends: M1

Services and APIs for accounts, checkout and billing.

## Checkout

- [x] Data model & API contract @est:4h @act:5h @owner:alex @done:2026-10-09 ^T101
- [/] Order state machine @est:12h @owner:sam @dep:T101 #checkout ^T102

## Notes

Free text is allowed anywhere and is preserved.
```

| Property  | Example                                  | Meaning                                                                                                                     |
| --------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `id`      | `M2`                                     | Milestone id. Default: the `M<n>` prefix of the file name, else the file name.                                              |
| `target`  | `2026-12-15`                             | Due date. The milestone is _late_ when its forecast (last task finish) is after it.                                         |
| `status`  | `planned`, `active`, `done`, `cancelled` | `active` milestones show a blue icon. `cancelled` cancels all its tasks.                                                    |
| `depends` | `M1` or `M1, M3`                         | Every task of this milestone starts only after all tasks of these milestones are finished. Starting one earlier asks first. |

- Tasks can sit directly under the milestone heading, or under `##` **sections** (work packages such
  as features or components). `###` and deeper headings belong to the enclosing section.
- A milestone without tasks still has a target diamond on the Gantt.
- A heading such as `## Notes` without tasks is just text.

## Tasks

A task is a Markdown checkbox list item:

```text
- [ ] Payment provider integration @est:2d @owner:sam @start:2026-11-10 @prio:high #checkout ^T105
  │ │ └─ title ─────┘ └─ attributes @key:value ──────────────────┘ └ tags ┘ └ id ┘
  │ └ status
  └ list marker (-, *, + or a number such as 1.)
```

### Status

| Checkbox | Status        | Kanban column | How the scheduler treats it                                               |
| -------- | ------------- | ------------- | ------------------------------------------------------------------------- |
| `[ ]`    | To do         | To do         | Scheduled.                                                                |
| `[/]`    | In progress   | Doing         | Remaining work scheduled from today; the bar starts at `@started`.        |
| `[?]`    | Review / test | Review        | Like in progress.                                                         |
| `[!]`    | Blocked       | Blocked       | Scheduled as if it were not blocked, and drawn with a red dashed outline. |
| `[x]`    | Done          | Done          | Not scheduled; drawn in the past from `@started` to `@done`.              |
| `[-]`    | Cancelled     | hidden        | Ignored.                                                                  |

Any other character, such as `[z]`, is treated as to do and reported as a warning.

When the status is changed by the planner (a command, the checkbox hover, the Kanban, the timer),
it also writes dates: to in progress or review adds `@started:<today>` if missing; back to to do
removes `@started` when no time was logged (`@act` or `@progress`); to done adds `@done:<today>`;
leaving done removes `@done`; to blocked writes `@blocked:"reason"` if you give one; leaving
blocked removes `@blocked`. When you type a checkbox yourself, nothing else changes, but the editor
points out a done task without `@done` or a to-do task with a leftover `@started` (a to-do task's
`@started` is ignored by the scheduler).

### Attributes

| Attribute   | Example                                        | Meaning                                                                                                          |
| ----------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `@est`      | `@est:12h`, `2d`, `1.5d`, `1w`                 | Estimate. `d` = `hoursPerDay` hours, `w` = 5 days. A unit is required.                                           |
| `@act`      | `@act:5.5h`                                    | Actual hours spent (typed, or added by the timer and **Log time**).                                              |
| `@owner`    | `@owner:sam`                                   | Person id from `team.md`. Subtasks inherit it.                                                                   |
| `@dep`      | `@dep:T101`, `@dep:T101,T102+2d`               | Finish-to-start dependencies; `+2d` adds a lag in working days. A dependency on a parent means all its subtasks. |
| `@start`    | `@start:2026-11-10`                            | Fixed start: not before this date (dependencies still win). Subtasks inherit it.                                 |
| `@due`      | `@due:2026-11-20`                              | Deadline. A warning appears when the schedule misses it. Subtasks inherit it.                                    |
| `@prio`     | `high`, `med`, `low`                           | Scheduling priority, default `med`. `h`, `m`, `l` and `medium` also work.                                        |
| `@progress` | `@progress:40%`                                | Manual progress. Remaining work becomes estimate × (1 − progress) instead of estimate − actual.                  |
| `@started`  | `@started:2026-10-12`                          | Date work started. Written automatically; you may correct it.                                                    |
| `@done`     | `@done:2026-10-13`                             | Date completed. Written automatically; you may correct it.                                                       |
| `@blocked`  | `@blocked:"waiting for the provider contract"` | Reason for `[!]`.                                                                                                |
| `@test`     | `@test:UAT-01`                                 | Links the task to a test plan.                                                                                   |
| `@eq`       | `@eq:checkout/payment`                         | The component or equipment the task belongs to.                                                                  |
| `@src`      | `@src:src/server/invoices.ts#L8`               | Origin of a promoted code TODO. Cmd+click opens the code line.                                                   |
| `#tag`      | `#frontend #checkout`                          | Free tags, for filters, grouping and estimate statistics.                                                        |
| `^id`       | `^T105`                                        | Stable task id; must be the last token on the line.                                                              |
| anything    | `@security:high`                               | Unknown attributes are kept and shown as custom fields in tooltips.                                              |

Rules for writing a task line:

- Values with spaces need double quotes: `@blocked:"waiting for the payment provider contract"`.
- `@word` without a colon is plain text, so e-mail addresses in titles are safe.
- The **title** is all the other words of the line; attributes and tags may appear anywhere.
- When the planner adds an attribute, it places it in a fixed order after the title (`@est @act
@progress @owner @dep @start @due @prio @started @done @blocked …`) and before tags and the id.
  Attributes you wrote are never moved.

### Subtasks and notes

```markdown
- [/] Order state machine @est:12h @owner:sam @dep:T101 ^T102
  - [x] State transitions @est:6h @act:7h ^T103
  - [ ] Order events schema @est:6h ^T104
        Notes indented under a task are its description.
        Use the CloudEvents format.
```

- **Subtasks** are checkbox items indented under a task, to any depth.
- **Notes** are indented lines that are not checkboxes. Blank lines inside notes are allowed; a line
  that is not indented ends the list. Notes appear in tooltips and are sent to the AI as context.
- Only **leaf tasks** (tasks without subtasks) are scheduled. Parents roll up: start = earliest
  subtask start, finish = latest finish, hours = sum, progress weighted by hours.
- A parent without its own `@est` uses the sum of its subtasks' estimates.
- A parent **with** its own `@est` gives a budget to its subtasks: subtasks without an estimate
  share what the estimated ones leave (minus time logged on the parent itself). So you can split
  `@est:3d` into subtasks and estimate them later; the three days stay in the schedule. When every
  subtask has an estimate and they add up to less, the rest is not scheduled: the editor warns and
  offers to add a subtask for the rest or to set `@est` to the subtasks' total. When they add up
  to more, their estimates are used.
- A parent marked done makes its open subtasks irrelevant (they are not scheduled). A cancelled
  parent cancels its subtasks (the editor points out open subtasks under a cancelled task, as
  they are not scheduled either). Finishing a parent from the planner asks what happens to its open
  subtasks (finish them too, cancel them, or leave them), and the editor warns about a done parent
  with open subtasks.
- When you change a status from the planner, parents follow their subtasks
  (`planner.parentStatus`, on by default): a to-do parent goes in progress when a subtask starts,
  is done when its last subtask is done, and reopens when a subtask of a done parent reopens.

### Ids

- Task ids are `T` plus a number (`^T101`), unique in the whole plan; punch items use `P` and at
  least three digits (`^P001`).
- When you save a milestone file or the punch list, tasks without an id get the next free number,
  continuing the highest one in the plan and keeping its zero padding (`T013` after `T012`). Turn
  this off with `planner.autoAssignIds`; then **Planner: Assign IDs** adds them on demand.
- Never reuse or renumber ids by hand: rename them with **F2** in the editor, which updates every
  `@dep` that points to the id ([Rename](05-editor.md#rename-a-task-id)).

### Remaining work

For open tasks, remaining work = `@est` − `@act`, or `@est` × (1 − `@progress`) when `@progress`
is set, never below zero. A task with more actual hours than estimated therefore has no remaining
work left in the schedule; raise its estimate if work remains.

## Test plans (tests/)

```markdown
# Acceptance test – Checkout

id: UAT-01
type: acceptance # acceptance | FAT | SAT | IT | unit
milestone: M4
eq: checkout
witness: Customer key users

## TC-01 Successful purchase

pre: Signed-in customer with an empty cart

- [x] Add a product and open the cart → total with VAT shown @result:pass
- [x] Pay with a test card → confirmation within 2 s @result:fail @note:"confirmation after 3.5 s" @punch:P007
- [ ] Order appears in the order history

## TC-02 Declined card

- [ ] Declined card → clear error message, the cart is kept

## Run 2026-10-12

tester: Alex
witness: internal dry run
result: 1 pass, 1 fail, 0 n.a., 2 open (4 steps)
failed: TC-01
punch: P007
```

| Element         | Meaning                                                                                |
| --------------- | -------------------------------------------------------------------------------------- |
| `id`            | Test plan id (default: the file name). Tasks link to it with `@test:UAT-01`.           |
| `type`          | `acceptance`, `FAT`, `SAT`, `IT` or `unit`.                                            |
| `milestone`     | The milestone the test belongs to.                                                     |
| `eq`            | Component or equipment under test.                                                     |
| `witness`       | Default witness for runs and the report's signature block.                             |
| `## TC-01 …`    | A test case. Its id is the first word when it looks like an id (`TC-01`), else a slug. |
| `pre:`          | Pre-condition of the case, shown in the runner and the report.                         |
| step checkboxes | Steps. A recorded step is ticked and gets `@result:pass`, `fail` or `na`.              |
| `@note:"…"`     | Note on the step.                                                                      |
| `@punch:P007`   | The punch item raised from this step.                                                  |
| `## Run <date>` | Run log written by **Finish run…** in the test runner.                                 |

## punchlist.md

```markdown
# Punch list

- [/] Cart is not cleared after a cancelled payment @sev:A @owner:sam @due:2026-10-23 @from:UAT-01/TC-01 ^P003
- [!] VAT rates differ from the finance spreadsheet @sev:B @owner:alex @blocked:"waiting for finance" ^P004
- [ ] Error text for an expired card is missing @sev:C @owner:priya #notifications ^P002
```

Punch items use the same statuses as tasks, plus:

| Attribute        | Meaning                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| `@sev`           | Severity: `A` blocks acceptance, `B` must be fixed before SAT, `C` may wait until after handover. |
| `@from`          | The test case it came from: `UAT-01/TC-01`.                                                       |
| `@owner`, `@due` | As for tasks.                                                                                     |

Punch items are not scheduled; they appear in the Punch List view, on the punch-list board and in
reports.

## inbox.md

```markdown
# Inbox

- [ ] Ask the payment provider for production access #customer
- [ ] Capacity plan for the database cluster @owner:jordan #infrastructure
```

The inbox is a quick-capture list. Its items are not scheduled and need no id. When you decide to
do one, use **Plan into milestone…** in the Inbox view: it moves the line into a milestone as a
task with a new id ([Inbox](06-sidebar.md#inbox)).

---

[← Tutorial](02-tutorial.md) · [Contents](README.md) · [Next: The editor →](05-editor.md)
