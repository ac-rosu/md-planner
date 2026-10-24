# Change Log

## Unreleased

Safer editing, from the pilot users' feedback.

- Clicking a checkbox in the editor no longer changes the status (it changed tasks by accident).
  Hover the checkbox to pick a status, or press Ctrl/Cmd+Alt+X. Turn
  `planner.editor.toggleOnClick` on to get the click back.
- A task moved back to to do loses its `@started` when no time was logged, and a leftover
  `@started` on a to-do task no longer stretches its Gantt bar. A timer stopped within a minute puts
  the task back to to do.
- Kanban: moving a card to another column keeps its priority; only reordering within a column
  changes it.
- A task line copied with its id and given another title gets a new id on save, so dependencies
  keep pointing at the original. Duplicate ids have a quick fix.
- New warnings with quick fixes: lines that look like tasks but are not (`- []`, `-[ ]`,
  `- [ ]Title`, `[ ] Title`), dates outside the project (often a wrong year: the fix offers the
  year that fits), a fixed start after work started or after the milestone target, a due date after
  the milestone target, done tasks without `@done`, leftover `@started`, dependencies on cancelled
  tasks, and tasks depending on themselves, their parent or their subtask.
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
  task with its notes and subtasks (`planner.editor.moveTasksAsBlocks`).
- A move that would make the plan invalid (a dependency loop, a task depending on its new parent)
  asks first.
- Late tasks say what holds them back, following the dependencies to the cause: "Held back by the
  fixed start 2027-10-19 of T461 (via M1)" or "… by Sam having other work first", in the warning,
  the Gantt tooltip and the hovers.
- Gantt: a click with a slight wobble no longer moves a bar, short bars can no longer be resized by
  accident, and a link is only made when you drop on a bar (outlined, with a "T202 waits for T201"
  label while you drag). Bars with a fixed start show a pin, with **Remove fixed start** in their
  context menu.
- A hint points out dependencies that another dependency in the list already covers, with a quick
  fix to remove them; a task without an estimate offers to make the next task its subtask.
- Milestones follow each other: a new milestone depends on the last one (clear it for parallel
  work), starting work while a milestone it depends on is not finished asks first
  (`planner.confirmEarlyStart`), and the editor points out work started early and milestones that
  nothing ties to the one before.
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
