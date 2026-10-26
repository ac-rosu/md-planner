# 16. How scheduling works

Every date you see (CodeLens, Gantt bars, forecasts, late flags, the team load) comes from one
scheduler. Knowing its rules lets you steer the plan on purpose instead of by trial and error.

## Principles

- **Computed, never stored.** The schedule is calculated from the plan files and never written back
  into them. Your Markdown only changes when you, a view or a command changes it. A copy is cached
  in `plan/.planner/schedule.json` for other tools.
- **Deterministic.** The same files and the same "today" always give the same schedule, in the
  extension, the MCP server and the command line.
- **Resource-constrained.** Nobody is booked beyond their capacity. When there is too much work,
  tasks move later.
- **Fast.** The schedule is recomputed about 300 ms after each change; a plan of 2,000 tasks takes
  well under a second.

## The calendar

A day is a **working day** when it is in the project's `workweek` and not a project `holiday`.

Each person has a **daily capacity** for each working day:

- weekly capacity (`32h/week`) spread evenly over the person's working days (their own
  `workweek`, or the project's), or a daily capacity (`4h/day`);
- changed from a date on by `capacityFrom`;
- plus **overtime** during an `overtime:` period: `+8h/week` spread over the working days, or
  `+2h/day` on each;
- zero on `off:` days and project holidays, and on days outside the work week, except **extra
  working days** (`workday:`), which get a normal day's hours or the hours given.

Time off wins: an `off:` day has no capacity even when it is also an overtime or extra working day.

A person without `capacity:` works full time: `hoursPerDay` on every working day.

Tasks without an owner, or with an owner who is not in `team.md`, run in the virtual
**Unassigned** pool with `planner.scheduling.unassignedCapacity` hours per week (40 by default).

## What is scheduled

Only **leaf tasks** (tasks without subtasks) are scheduled. Parents, sections and milestones roll up
their tasks: start = earliest start, finish = latest finish, hours = sum, progress weighted by hours.

| Task                          | Treatment                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| To do, in progress, review    | Its **remaining work** is scheduled from today. In-progress bars start at `@started`.                          |
| Blocked                       | Scheduled as if not blocked (the scheduler cannot know when it unblocks), drawn with a red dashed outline.     |
| Done                          | Not scheduled. With `@started`/`@done` it is drawn in the past, its actual hours spread over its working days. |
| Cancelled                     | Ignored, as are tasks of a cancelled parent or milestone.                                                      |
| Open subtask of a done parent | Ignored.                                                                                                       |
| Without `@est`                | Scheduled with 0 hours: it finishes on the first working day it is ready (and is flagged).                     |

**Remaining work** is `@est − @act`, or `@est × (1 − @progress)` when `@progress` is set, never below
zero.

## Dependencies

- `@dep:T101` is **finish-to-start**: the task can start once T101 is finished.
- A dependency on a parent task means all of its leaf subtasks; a parent's own `@dep` applies to
  all of its subtasks.
- A milestone's `depends: M1` makes every task of the milestone wait for every task of M1.
- **Timing:** a successor with another owner starts on the next day that owner works after the
  predecessor finishes (normally the next working day; an extra working day on a Saturday counts).
  A successor with the same owner may continue on the same day if the person has hours left that
  day.
- **Lag:** `@dep:T101+2d` adds working days after the finish day: T101 finishes on Monday, the
  successor starts on Thursday. Lags in hours (`+4h`) are rounded up to whole days.
- **Cycles** (A waits for B, B waits for A) are rejected: the tasks in the cycle and everything that
  waits for them are not scheduled, and errors point at the `@dep` that closes the loop.

## The scheduling walk

The scheduler walks through the working days from today (or the project start, if that is later).
Each day, for each person:

1. It collects the tasks that are **ready**: all dependencies finished (plus lag), and the `@start`
   date reached. `@start` is a "not before" date: dependencies still win.
2. It orders them:
   1. tasks with a fixed `@start` first,
   2. then by priority: `@prio:high`, `med` (default), `low`,
   3. then by the latest day the task can finish without making anything late, so the tightest
      task goes first. That day counts back from the task's own deadline (`@due`, an inherited
      `@due`, or the milestone target), from its owner's last working day (when `capacityFrom`
      drops to 0h), and from every task that waits for it (that task's latest start). A short
      review that someone else waits for therefore comes before a long task that only has its own
      deadline. The task's own estimate does not change its place, so making a bar longer in the
      Gantt does not move it ahead of the person's other work.
   4. then in file order (milestones by id, then line by line).
3. It gives the person's free hours of that day to the tasks in that order. A task can take several
   days and can share a day with other tasks. It finishes on the day its remaining hours reach zero.
   A task in progress keeps its place in the order, so a person finishes one task before the next
   one of the same urgency instead of switching between them; only a more urgent task that becomes
   ready can take over.

A task that never gets capacity within ten years (for example an owner whose capacity drops to zero
with `capacityFrom`) is reported as **unschedulable**, with whose hours end and when. The tasks that
wait for it are reported too, naming it, so you know which task to give to someone else.

## Analysis

- **Milestone forecast** = the latest finish of its tasks. The milestone is **late** when the
  forecast is after its `target`; the variance is counted in working days after the target, up to and
  including the forecast: due on a Saturday and finished on Monday is 1 day late; finished on the
  Friday before, on target.
- **Slack** is how many working days a task can slip before it delays the latest milestone target
  (or its own deadline). It comes from a backward pass over the scheduled durations (CPM).
- **Critical path**: the tasks with the least slack. The longest chain is highlighted even when
  everything is ahead of plan.
- **Late tasks**: tasks scheduled to finish after their `@due` or their milestone's target.
- **Demand schedule**: the same plan scheduled as early as possible, ignoring capacity. It shows
  raw overload in the team-load view. (The `overbooked` message on a person comes from the real
  schedule: it appears when their workload makes tasks late.)

## Steering the schedule

| You want to …                       | Do this                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Start a task not before a date      | `@start:2026-11-10`, or drag the bar on the Gantt.                                                                          |
| Make a task go first in a busy week | `@prio:high`, or drag the card above a high-priority card on the Kanban board.                                              |
| Let a task wait for others          | `@dep:T101,T102`; add `+2d` for a waiting time (curing, delivery, review).                                                  |
| Make a whole phase wait for another | `depends: M1` in the milestone's properties.                                                                                |
| Warn when a task will miss a date   | `@due:2026-11-20` (or a milestone `target`).                                                                                |
| Plan a part-time colleague          | `capacity: 24h/week`, or `capacity: 4h/day` with `workweek: mon-thu`.                                                       |
| Plan a capacity change              | `capacityFrom: 2027-01-01 32h/week`.                                                                                        |
| Block holidays or a site visit      | `off: 2026-12-22..2027-01-02` (person) or `holidays:` (everyone).                                                           |
| Finish sooner                       | Move work to people with room; split tasks across owners; remove dependencies that are not real; reduce estimates or scope. |
| See why a task is where it is       | Hover its CodeLens or Gantt bar (dates, slack, deadline); check its dependencies and its owner's week in Team load.         |

### Why is my task scheduled so late?

Check, in this order:

1. **Dependencies**: is it waiting for a predecessor, perhaps through a parent or a milestone
   `depends`? (Gantt arrows; Go to Definition on each `@dep`.)
2. **Owner capacity**: is the owner busy with other tasks, part-time, or on leave? (Team load; the
   owner hover shows this week's load.)
3. **Order**: do other ready tasks of the same owner have a fixed start, a higher priority or a
   tighter deadline?
4. **`@start`**: does it, or its parent, have a fixed start date?
5. **Unassigned**: does it run in the unassigned pool, which is shared by all unowned tasks?

---

[← MCP server and command line](15-mcp-and-cli.md) · [Contents](README.md) · [Next: Power-user guide →](17-power-user-guide.md)
