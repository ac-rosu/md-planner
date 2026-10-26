# Change Log

## Unreleased

Safer editing, from the pilot users' feedback.

- Clicking a checkbox in the editor no longer changes the status (it changed tasks by accident).
  Hover the checkbox to pick a status, or press Ctrl/Cmd+Alt+X; like typing, the change is not
  saved until you save, and Ctrl/Cmd+Z undoes it. Turn `planner.editor.toggleOnClick` on to get the
  click back.
- A task moved back to to do loses its `@started` when no time was logged, and a leftover
  `@started` on a to-do task no longer stretches its Gantt bar (with logged time, the MS Project
  export still writes it as the actual start). A timer stopped within a minute puts back what
  starting it changed: the task is to do again, and its parents are as they were (a done parent it
  reopened is done again, with its own `@done`).
- Kanban: moving a card to another column keeps its priority; only reordering within a column
  changes it.
- A task line copied with its id and given another title gets a new id on save, so dependencies
  keep pointing at the original. Copied with its subtasks, they get new ids too, and dependencies
  within the copy follow them. Duplicate ids have a quick fix (a punch item gets a new P id).
- A copied line that kept its id is a task of its own: the status (also from the checkbox hover),
  owner, estimate, the task form, moves and the timer change the copy under the cursor or in the
  view. Before, they changed the first task with that id, possibly in another file, and a status
  change could garble that task's line. Gantt bars whose id another task has are not changed until
  each has its own id (an arrow out of one can still be removed). The timer follows its line while
  you edit; when the line is copied next to it, the hours go to the task by its id and title, and
  when the copies cannot be told apart, nothing is logged and the message gives the hours.
- New warnings with quick fixes: lines that look like tasks but are not (`- []`, `-[ ]`,
  `- [ ]Title`, `[ ] Title`), dates outside the project (often a wrong year: the fix offers the
  year that fits), a fixed start after work started or after the milestone target, a due date after
  the milestone target, done tasks without `@done`, leftover `@started`, dependencies on cancelled
  tasks, tasks depending on themselves, their parent or their subtask (not for cancelled work,
  whose dependencies are ignored), and open subtasks of a cancelled task, which are not scheduled
  (cancel them too, move them out, or reopen the task).
- Subtasks no longer make work disappear: a parent's `@est` is a budget, shared by its subtasks
  that have no estimate yet. When the subtasks' estimates leave part of it unscheduled, a warning
  offers to add a subtask for the rest or to set `@est` to their total.
- Parents follow their subtasks: in progress when one starts, done with the last one, reopened
  when one reopens (`planner.parentStatus`). Finishing a task with open subtasks asks whether to
  finish them too, cancel them or leave them open; warnings point out a done parent with open
  subtasks.
- Reorganize tasks without breaking the outline: Move up / down, Indent, Outdent (context menus,
  Option+arrows in the Milestones view), drag and drop in the Milestones view (dropping onto a task
  asks: before, after or as a subtask), and Option+↑ / ↓ on a task line in a plan file moves the
  task with its notes and subtasks (`planner.editor.moveTasksAsBlocks`), also the tasks of every
  cursor and selection. Moves within a file change only the moved lines, and a task without an id
  stays under the cursor (and selected in the tree) press after press.
- A move that would make the plan invalid (a dependency loop, a task depending on its new parent)
  asks first, and so does one that would take open work out of the schedule: under a cancelled or
  done task, or into a cancelled milestone. MCP `move_task` refuses those.
- The schedule does the work that others wait for first. Each person takes the task with the
  latest possible finish that is soonest, counted back from its deadline, from the tasks that wait
  for it, and from its owner's last working day (`capacityFrom: … 0h`). Before, a short review that
  a colleague waited for could be left to the end because it had no deadline of its own. A task in
  progress keeps its place, so people no longer switch between tasks of the same urgency and the
  Gantt bars are shorter.
- Gantt drags do what they show. Resizing a bar writes an estimate that ends it on the day you drop
  it on, next to the owner's other work (it assumed they worked on nothing else, so the bar spilled
  into the next week): a longer bar gets the most work that still ends there, a shorter one the
  work it gets by then. When a shorter bar does not end there even so, nothing is written and the
  notice says why ("T3 cannot end by Tue 2026-10-06 with only the work it gets by that day: then it
  waits longer for T1, as Sam's other work comes first").
  Resizing a subtask that shares its parent's `@est` changes the parent's `@est` by as much, in the
  same edit, so the other subtasks keep their hours. A resize takes about one schedule, so it stays
  quick on big plans. Making a bar longer no longer pushes it ahead of the person's other work. The
  ghost bar counts working days, and the notice after a move or resize gives the new end, why a
  bar starts later than where it was dropped (what it waits for, the owner's other work or time
  off), and the other tasks that move, and why: they wait for it, they are the same person's other
  work, or their milestone waits for this one ("Also moves T430 (+2 d), which waits for it; Sam's
  other work: T515 (−5 d); 25 tasks of M2–M5, which wait for M1 to finish").
- Gantt: click an arrow to follow it: it is drawn on top in the accent colour, the bars it connects
  are outlined, the other arrows fade, and the help line says "T122 waits for T121". Clicking a
  bar does the same for all arrows into and out of that task ("T491 waits for T411, T413; T416
  waits for T491"). Hovering an arrow names both tasks; Esc or a click on empty space shows all
  arrows again. Arrows of tasks that finish on the same day no longer lie on top of each other,
  and their corners are rounded.
- Gantt: pinch on the trackpad, or Ctrl/Cmd + scroll wheel, zooms the timeline smoothly around
  the pointer, from several years down to single days. The zoom is remembered like the others.
  **Fit** uses the panel's current width after a resize, and **Open in Gantt** on a chart that is
  already open scrolls to the task at once.
- Project budget in hours: `budget: 800h` in `project.md` (or the **Budget** field of the project
  form, or **Set budget…** on the dashboard). The dashboard shows it against the planned (sum of
  estimates), logged and forecast hours, as a key figure, a budget panel (meter, per milestone,
  tasks taking longer than estimated) and a line in the burn-up. When the forecast is over the
  budget, it says why: estimates above the budget, tasks over their estimate (blocked ones marked),
  open tasks without an estimate; `project.md` gets a warning, and the status report and the AI
  status summary include it. MCP: `update_project` sets the budget, `get_plan_overview` reports
  the hours. Work in cancelled milestones and on cancelled tasks counts only the hours logged on
  it, and hours logged on a parent task count once. The meter shows the logged hours, work done
  without logged hours (hatched), the work left and the part over the budget. `budget:` takes a
  decimal comma (`12,5h`) and thousands separators that cannot be decimals (`1,200,000h`); `1,200h`
  is refused as ambiguous, and the warning names both readings.
- Blocked tasks say what they hold up: the work that waits for them and how long they can stay
  blocked before something moves ("2 tasks (24 h) wait for it · can stay blocked until
  2026-10-26"), or that they already delay the plan; on the dashboard, in the status report's risks
  and the AI summary. When the owner's hours end (`capacityFrom: … 0h`), the date leaves them the
  time for the work and for their own tasks that wait for it: "(Alex has no working hours from
  2026-10-19 on)", "must be unblocked now" or "already too late". An empty `@blocked` reads
  as no reason given.
- Late tasks say what holds them back, following the dependencies to the cause: "Held back by the
  fixed start 2027-10-19 of T461 (via M1)" or "… by Sam having other work first", in the warning,
  the Gantt tooltip and the hovers. A fixed start is named only when it really holds the task back,
  not when the people after it would be busy with other work anyway (that work is named then, and
  counted in the person's workload note).
- Gantt: a click with a slight wobble no longer moves a bar, short bars can no longer be resized by
  accident, and a link is only made when you drop on a bar (outlined, with a "T202 waits for T201"
  label while you drag). Bars with a fixed start show a pin, with **Remove fixed start** in their
  context menu.
- A hint points out dependencies that another dependency in the list already covers (only open
  work counts), with a quick fix to remove them; a task without an estimate offers to make the next
  task its subtask, as an edit in the editor like the other quick fixes.
- Milestones follow each other: a new milestone depends on the last one (clear it for parallel
  work), starting work while a milestone it depends on is not finished asks first
  (`planner.confirmEarlyStart`), and the editor points out work started early and milestones that
  nothing ties to the one before (one that an earlier milestone waits for is tied; the fix never
  makes a loop).
- Overload is reported once per person, on their heading in `team.md`, and only when their
  workload makes tasks late, in plain words: their open work, how long it takes with the capacity
  in force ("about 3 weeks at 40h a week, then 20h a week from 2026-10-26", or how much fits before
  their hours end), until when it is planned, and which tasks miss their deadline because of it.
  Tasks that cannot be scheduled say whose working hours end and when, and the tasks waiting for
  them name that task instead of blaming their own owner. Dates and periods in `team.md` after the
  project end are flagged, each on its own, with a quick fix for the year that moves a whole period.
- Every Gantt edit shows what changed ("T417: estimate 80h → 122.5h") with an **Undo** button, and
  so does **Remove fixed start**; a drag that changes nothing says so, without one. When format on
  save (Prettier and the like) rewrites a plan file, the planner says so and offers to turn it off
  for Markdown or to add the plan folder to `.prettierignore` (an edit that can be undone).
- Faster: the schedule of a 2,000-task plan takes about 7 ms (about 35 ms in 1.0.0), and
  explaining tasks that cannot be scheduled no longer costs most of a second per change when
  someone's hours end.
- The Gantt shows tasks in the order they start, as a cascade (**Order: Schedule**, the default;
  **Files** keeps the order of the plan files, which are never reordered).

## 1.0.0

- Initial release.
- Plan projects in a `plan/` folder of Markdown files: the project calendar, a team with capacity,
  time off, overtime and extra working days, milestones with sections, tasks with estimates,
  owners, dependencies (with lag), fixed starts, deadlines, priorities, tags and notes, an inbox
  and a punch list. The files stay plain text, and every change is a minimal edit of the
  characters that change.
- A deterministic, resource-constrained scheduler with critical path, slack, milestone forecasts
  and a demand view. The schedule is computed, never written into the files.
- Sidebar views: Milestones, My Work / Team, Inbox, Punch List, Tests and TODOs in Code, with
  filters, row buttons and context menus.
- Add and edit everything from forms: tasks, subtasks, sections, milestones, people, time off,
  overtime, the project calendar, inbox notes and punch items. Deleting a milestone or removing a
  person offers Undo.
- Editor support for plan files: completion, hovers, go to definition, references and rename for
  task ids, diagnostics with quick fixes, CodeLens with the schedule and actions, and status
  cycling with a click on the checkbox.
- Gantt chart (drag to move, resize and link; baselines and slip; grouping and colours), Kanban
  board (swimlanes, WIP limits, a punch-list board), team-load heatmap and a dashboard with KPIs,
  burn-up charts and estimate accuracy.
- Test plans (acceptance, FAT, SAT, integration, unit) with a test runner, run logs, punch items
  raised from failed steps and a test report with a signature block.
- Time tracking with a timer or manual logging, and baselines to compare the plan over time.
- Exports: HTML and PDF status report with your branding, Excel, MS Project XML, CSV and test
  reports; a command-line tool for CI.
- Optional AI assistant (VS Code language models or the Claude API): break down, estimate,
  calibrate, suggest owners, plan from text, status summary and schedule review, always shown as
  a diff to accept or reject.
- MCP server with tools for every command, so agents such as Claude Code or Copilot agent mode can
  build the plan from a plain-text description and keep it up to date.
- Project templates `software` (the default) and `blank`, plus your own; a getting-started
  walkthrough and a user manual inside the extension (**Planner: Open user manual**).
- Accessible webviews: keyboard navigation, ARIA labels, light, dark and high-contrast themes.
