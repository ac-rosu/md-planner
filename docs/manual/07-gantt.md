# 7. Gantt chart

The Gantt chart shows the computed schedule: bars for tasks, roll-ups for parents, sections and
milestones, diamonds for milestone targets, arrows for dependencies, the critical path and the
baseline. You can also plan on it: drag bars, resize them, link them and edit them, and every
change is written to the Markdown as a small, undoable edit.

## Open the Gantt

- **Open Gantt** in the Milestones view toolbar, or in the editor title bar of any plan file.
- **Open Gantt** in a task's context menu: the chart opens with that task selected and scrolled
  into view.
- **Planner: Open Gantt** in the Command Palette, or the **Gantt** button on the dashboard.

The chart opens as an editor tab, so you can split it next to a milestone file (drag the tab to
the side) and watch it update while you type.

![The Gantt chart opened from the Milestones view](images/gantt-vscode.png)

## The layout

![The Gantt chart](images/gantt-overview.png)

| #   | Area            | What it is                                                                           |
| --- | --------------- | ------------------------------------------------------------------------------------ |
| 1   | Toolbar         | Grouping, colours, zoom, view options and undo/redo (below).                         |
| 2   | Task tree       | Groups and tasks with ids and owner initials; click to select, double-click to edit. |
| 3   | Timeline header | Months on top, ISO week numbers below (or days and weeks, depending on the zoom).    |
| 4   | Today line      | The red vertical line.                                                               |
| 5   | Chart           | Bars, roll-ups, diamonds and dependency arrows.                                      |
| 6   | Help line       | A reminder of the mouse and keyboard actions.                                        |

## The toolbar

![The Gantt toolbar](images/gantt-toolbar.png)

| #   | Control       | What it does                                                                                                                                                                                                                                         |
| --- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Group         | **Milestone**: milestone → section → task, with milestone rows and diamonds. **Section**: one group per section (`M2 › Checkout`). **Owner**: one group per person. **Tag**: one group per tag; a task goes under its first (or inherited) tag only. |
| 2   | Colour        | Colour bars by **Owner** (the person's `color`), **Status** or **Milestone**.                                                                                                                                                                        |
| 3   | Zoom          | **Day**, **Week**, **Month** or **Quarter**.                                                                                                                                                                                                         |
| 4   | Fit           | Zooms so that the whole project fits the window.                                                                                                                                                                                                     |
| 5   | Today         | Scrolls to today.                                                                                                                                                                                                                                    |
| 6   | Critical path | Highlights the critical path (bars and arrows in red). On by default.                                                                                                                                                                                |
| 7   | Hide done     | Hides finished tasks.                                                                                                                                                                                                                                |
| 8   | Baseline      | **None**, **Latest** or a specific baseline to draw under the bars. Only shown when a baseline exists.                                                                                                                                               |
| 9   | `⚠ 1 late`    | The number of milestones forecast after their target.                                                                                                                                                                                                |
| 10  | Undo / Redo   | Undo or redo the last edit made in the Gantt (also Cmd+Z / Cmd+Shift+Z).                                                                                                                                                                             |

While a dependency arrow is selected, a **Remove dependency** button appears before Undo.

The chosen grouping, colours, zoom and options are remembered for the workspace.

## Reading the chart

![Bars, roll-ups, diamonds and baselines](images/gantt-anatomy.png)

| Element             | Looks like                                                 | Meaning                                                              |
| ------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| Task bar            | Coloured bar, owner initials inside when it is wide enough | A scheduled leaf task, from its scheduled start to finish.           |
| Done task           | Darker bar in the past                                     | From `@started` to `@done`.                                          |
| Progress fill       | Lighter part at the start of a bar                         | Share of the estimate already done (actual hours, or `@progress`).   |
| Parent roll-up      | Thin bar with end caps                                     | Span of a parent's subtasks; the fill shows hours-weighted progress. |
| Section roll-up     | Thin grey bar with end caps                                | Span of a section's tasks.                                           |
| Milestone roll-up   | Thin bar on the milestone row                              | Span of all the milestone's tasks.                                   |
| Target ◆            | White diamond on the milestone row                         | The milestone's `target` date. Red when the milestone is late.       |
| Forecast ◆ and slip | Second diamond joined by a red line                        | Only for late milestones: the forecast finish, after the target.     |
| Critical path       | Red outline and red arrows                                 | Tasks with the least slack: any delay moves the end date.            |
| Blocked task        | Red dashed outline                                         | Status `[!]`. Still scheduled as if it were not blocked.             |
| Deadline marker     | Short red vertical line after a bar                        | The task's deadline, shown when the task is scheduled after it.      |
| Dependency          | Grey arrow from a bar's end to another bar's start         | `@dep` (finish-to-start).                                            |
| Baseline            | Thin grey bar under a task                                 | Where the task was planned in the chosen baseline.                   |
| `+5d`               | Red label after a bar or milestone                         | Slip against the baseline, in working days.                          |
| Weekend / holiday   | Shaded columns                                             | Non-working days of the project calendar (Day and Week zoom).        |
| `not scheduled`     | Text instead of a bar                                      | The task has no dates; the tooltip and the CodeLens say why.         |

Hover a bar for its details:

![The tooltip of a task bar](images/gantt-tooltip.png)

### Overtime and extra working days

When `team.md` plans overtime or extra working days ([Team load](09-team-load.md#overtime-and-extra-working-days)),
orange marks above a bar show the days on which that task uses them. Summary bars (milestones,
sections, parents, owners) carry the marks of all their tasks, and their tooltip names the tasks:

![Overtime marks, grouped by owner](images/gantt-overtime.png)

A task's tooltip gives the hours and days, for example _4.8 h overtime on 2026-11-02, 2026-11-03,
2026-11-04_ or _4 h on extra working day 2026-11-27_. A person's hours of a day go to their tasks
in priority order, so the overtime of a day belongs to the tasks that got its last hours (and every
hour of an extra working day is overtime).

### The critical path and late milestones

In Month zoom with done tasks hidden and the first milestones collapsed, the end of the sample
project shows the critical path into M5, whose forecast is three working days after its target:

![Critical path and a late milestone](images/gantt-critical.png)

## The task tree

![The task tree on the left](images/gantt-tree.png)

- Click the chevron (or press ← / →) to collapse or expand a group, milestone or parent.
- Each task shows its id and owner initials. Hover a row for the **Reveal in editor** button.
- Click a row to select it. Double-click an open task to edit it; double-click a done task to open
  its line in the editor.

## Planning on the chart

Only **open leaf tasks** can be changed on the chart (not parents, done or cancelled tasks, and
not milestone rows).

### Move a bar → `@start`

Drag a bar left or right. A ghost bar shows the new dates while you drag:

![Dragging a bar to a new start date](images/gantt-drag-move.png)

On release the task gets `@start:<date>` (snapped forward to a working day), a "not before"
constraint. If the task's dependencies finish later than that date, the scheduler still keeps it
after them, and a notice tells you so.

### Resize a bar → `@est`

Drag the right end of a bar:

![Dragging the right end of a bar](images/gantt-drag-resize.png)

The planner computes how many hours the owner can work between the scheduled start (or today) and
the new end, using their capacity and time off, and writes that as the estimate, rounded to half
hours. Hours already spent (`@act`) are added on top; with `@progress` set, the estimate is scaled
so that the remaining part fits.

### Link two bars → `@dep`

Hover a bar: a small dot appears after its right end. Drag the dot onto another task's row:

![Dragging from the dot to the successor](images/gantt-drag-link.png)

The task you drop on gets `@dep:<id of the first task>`. If the first task has no id yet, it gets
one. Links that would create a circular dependency are refused with a message.

### Remove a dependency

Click an arrow to select it, then click **Remove dependency** in the toolbar or press Delete or
Backspace:

![A selected dependency and the Remove dependency button](images/gantt-dependency.png)

### Edit title, owner and estimate

Double-click a bar or a task row, or select it and press **F2**:

![The edit dialog](images/gantt-edit.png)

| #   | Field       | Writes                                                                                                                                                |
| --- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Title       | The task title (attributes, tags and id stay where they are).                                                                                         |
| 2   | Owner       | `@owner` (choose _— none —_ to remove it).                                                                                                            |
| 3   | Estimate    | `@est`: a number with `h`, `d` or `w`.                                                                                                                |
| 4   | Save        | All changes as one edit. Escape or **Cancel** closes without changes.                                                                                 |
| 5   | All fields… | Closes the dialog and opens the full task form: status, dependencies, dates, priority, tags and more ([Edit a task](03-add-and-edit.md#edit-a-task)). |

### The right-click menu

Right-click a bar or a row of the task list for every task action: edit, add a subtask, status,
owner, estimate, timer, move, delete and reveal in the editor. Milestone and section rows offer
**Add task…**, and milestones also **Add section…**, **Edit milestone…** and **Delete milestone…**.

![The context menu of a Gantt task](images/gantt-context-menu.png)

### Undo

Every change on the chart is a normal edit of the milestone file: Cmd+Z in the file undoes it. The
Gantt's own **Undo** and **Redo** buttons (and Cmd+Z / Cmd+Shift+Z while the chart has focus) undo
and redo the chart's edits even when the file is not in front, and refuse if the file was changed
in between.

## Other groupings

Group by **Owner** and colour by **Status** to see each person's sequence of work, with done
(green), in progress (blue), review (purple) and to-do (grey) bars:

![Grouped by owner, coloured by status](images/gantt-owner.png)

## Keyboard

Click a row in the task tree first.

| Keys                | Action                                                    |
| ------------------- | --------------------------------------------------------- |
| ↑ / ↓, Home / End   | Select the previous / next / first / last row.            |
| ← / →               | Collapse / expand a group or parent.                      |
| Space               | Collapse or expand a group or parent.                     |
| Enter               | Reveal the task in the editor (or toggle a group).        |
| F2                  | Edit the selected task.                                   |
| Option+← / Option+→ | Move the task one working day earlier / later (`@start`). |
| Shift+Option+← / →  | Make the task one working day shorter / longer (`@est`).  |
| Delete / Backspace  | Remove the selected dependency.                           |
| Cmd+Z / Cmd+Shift+Z | Undo / redo the last Gantt edit.                          |

---

[← The sidebar](06-sidebar.md) · [Contents](README.md) · [Next: Kanban board →](08-kanban.md)
