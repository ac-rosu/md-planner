# 10. Dashboard and baselines

The dashboard answers the questions a project lead asks every week: are we on track, what is late
or blocked, how good are our estimates, and how much has the plan moved since we agreed it.
Baselines are the snapshots that make the last question answerable.

## Open the dashboard

- **Open dashboard** in the Milestones view toolbar, or **Planner: Open dashboard**.
- Click the **overdue / blocked** counter in the status bar.

## Key figures and milestones

![KPIs and milestone cards](images/dashboard-top.png)

| #   | Element       | Meaning                                                                                                |
| --- | ------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | Baseline      | The baseline the trends compare with (default: the latest). _none saved_ until you save one.           |
| 2   | Save baseline | Saves the current schedule as a new baseline ([below](#baselines)).                                    |
| 3   | Gantt         | Opens the Gantt chart.                                                                                 |
| 4   | Kanban        | Opens the Kanban board.                                                                                |
| 5   | Team load     | Opens the team-load heatmap.                                                                           |
| 6   | Key figures   | See the table below. Figures that need attention are red.                                              |
| 7   | Progress bar  | Hours-weighted progress of the milestone, with tasks done/total and hours left.                        |
| 8   | Target        | The milestone's `target`.                                                                              |
| 9   | Forecast      | When its last task is scheduled to finish, with `N d ahead`, `on target` or `N d late` (working days). |
| 10  | vs baseline   | How far the forecast moved since the baseline: `+7 d slip`, `2 d gained` or `unchanged`.               |

A late milestone card has a red top border, like M5 in the picture.

| Key figure        | How it is computed                                                                                                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete          | Each task's progress weighted by its estimate: done tasks count fully, open tasks by the share already worked (`@act` or `@progress`). Cancelled tasks are left out. Big tasks count more than small ones. |
| Forecast finish   | The last scheduled finish of the project, compared with `end` in `project.md`.                                                                                                                             |
| Remaining work    | Remaining hours of all open tasks, and the number of milestones.                                                                                                                                           |
| Late milestones   | Milestones whose forecast is after their target.                                                                                                                                                           |
| Blocked           | Tasks with status `[!]`.                                                                                                                                                                                   |
| Open punch items  | Open punch items with the count per severity. Red when any A item is open.                                                                                                                                 |
| Failed test steps | Test steps with `@result:fail`.                                                                                                                                                                            |
| Planned overtime  | Hours of overtime and extra working days the schedule uses from this week on, with the people who work them ([Team load](09-team-load.md#overtime-and-extra-working-days)).                                |

## Burn-up and estimate accuracy

![Burn-up chart and estimate accuracy](images/dashboard-charts.png)

The **burn-up** shows, in hours:

- **scope** (grey dashed): the current total estimate. It has no history: when you add work, the
  whole line moves up.
- **done** (green): hours of tasks completed, by their `@done` date.
- **forecast** (blue dashed): the scheduled finishes plus work already done, up to the end.
- **today** (red).

Choose **Whole project** or one milestone in the selector.

**Estimate accuracy** compares actual hours with estimates for completed tasks that have both
`@est` and `@act`, per person and per tag (a parent's tags count for its subtasks). `act/est` above
100 % (red when over 110 %) means the work took longer than estimated; below 100 % (green under
90 %) means it took less. `n` is the number of tasks: trust a ratio more when `n` is larger. The
same statistics drive **AI: Calibrate estimates** ([AI assistant](14-ai-assistant.md)).

## Lists, tests and punch items

![Attention lists, test status and punch items](images/dashboard-lists.png)

| List               | Contains                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Overdue            | Open leaf tasks whose deadline (`@due`, inherited `@due`, or the milestone target) has passed.                               |
| Blocked            | Blocked tasks with their reason and owner.                                                                                   |
| Starting this week | Tasks scheduled to start in the current ISO week, with start date, owner and hours.                                          |
| Unassigned         | Open tasks without an owner.                                                                                                 |
| Unestimated        | Open leaf tasks without an estimate.                                                                                         |
| Critical path      | The chain of tasks that sets the end date, with their dates and owners.                                                      |
| Planned overtime   | Tasks that use overtime or extra working days from this week on: hours, owner and ISO weeks (only shown when there are any). |

Each list shows its count and up to twelve items; click an item to open it in the editor.

**Tests** shows one bar per test plan: pass (green), fail (red), n.a. and open, with the date of the
last run. **Open punch items** shows the split by severity, the open, closed and overdue counts, and
a **Board** button for the punch-list board.

## Baselines

A baseline is a snapshot of the plan's dates at a moment you choose: after the kick-off, after the
stakeholders sign off the specification, after a re-plan. Comparing with it shows how far each task and milestone
has moved.

### Save a baseline

Run **Planner: Save baseline…** (or click **Save baseline** on the dashboard) and type a name:

![The baseline name prompt](images/baseline-save.png)

The planner writes `baselines/<today>-<name>.json` with the scheduled start, finish and hours of
every task (by id) and the forecast of every milestone. Saving with a name that already exists
today asks before overwriting. The file creation is undoable, and the file is meant to be committed
to git together with the plan.

> [!TIP]
> Baselines record tasks by id, so give every task an id before you save one (ids are added on
> save by default).

### Compare with a baseline

| Where     | How                                                                                                                                                      |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gantt     | **Baseline** in the toolbar: _Latest_ or a specific one. A thin bar under each task shows the baseline dates, and `+Nd` labels the slip in working days. |
| Dashboard | **Baseline** in the toolbar. Each milestone card shows `vs <baseline>`: slip or gain of its forecast.                                                    |
| Report    | The status report's milestone table has a `vs <baseline>` column, from the latest baseline.                                                              |

To delete a baseline, delete its JSON file.

---

[← Team load](09-team-load.md) · [Contents](README.md) · [Next: Time tracking →](11-time-tracking.md)
