# Settings

All settings of Markdown Project Planner are under `planner.*` (Settings → Extensions →
Markdown Project Planner). Workspace settings (`.vscode/settings.json`) are the usual place,
so the whole team shares them.

<!-- Generated from package.json by `node scripts/docs/settings.mjs`. Do not edit. -->

## General

### `planner.planFolder`

Folder with the plan files, relative to the workspace folder (or absolute).

Type: string · default: `"plan"`

### `planner.me`

Your person id from `team.md`. Shown first in **My Work / Team**. Empty = the first person in `team.md`.

Type: string · default: `""`

### `planner.autoAssignIds`

Add missing task ids (`^T…`) when a milestone file or the punch list is saved, and give a new id to a task line that was copied with its id and then given another title.

Type: boolean · default: `true`

### `planner.autoAssignIdsOnAutoSave`

Also add missing ids when VS Code auto-saves after a delay (off, so ids do not appear while you type).

Type: boolean · default: `false`

### `planner.autoSave`

Save the plan files after an edit made from a view (tree, Gantt, Kanban …). Edits stay undoable either way.

Type: boolean · default: `true`

### `planner.confirmEarlyStart`

Ask before a task is started or finished while a milestone its milestone depends on (`depends:`) is not finished. Turn off if your milestones often overlap; the editor still points out work started early.

Type: boolean · default: `true`

### `planner.parentStatus`

How a parent task's status follows its subtasks when a status is changed from the planner (commands, checkbox hover, Kanban, timer, task form, MCP). Finishing a task with open subtasks always asks whether to finish them too, cancel them or keep them open.

Type: string · default: `"auto"`

- `"auto"`: A to-do parent goes in progress when one of its subtasks starts, is done when its last subtask is done, and reopens when a subtask of a done parent reopens.
- `"off"`: A parent's status only changes when you change it.

### `planner.templatesFolder`

Folder with your own project templates (one sub-folder per template, Markdown files with `{{name}}`, `{{start}}`, `{{end}}`, `{{date:0.5}}` … placeholders). Relative to the first workspace folder or absolute.

Type: string · default: `""`

## Editor

### `planner.editor.toggleOnClick`

Clicking inside a task's checkbox `[ ]` in the editor cycles its status (to do → in progress → review → done) and writes `@started`/`@done`. Off by default: a click meant to place the cursor changed the task. Hover the checkbox to change the status, or use **Planner: Cycle status** (Ctrl/Cmd+Alt+X).

Type: boolean · default: `false`

### `planner.editor.moveTasksAsBlocks`

**Alt+Up** / **Alt+Down** on a task line move the task with its notes and subtasks past the task above or below it at the same level. VS Code's own Move Line Up/Down moves only the line, which hands subtasks to another task. Other lines move as usual.

Type: boolean · default: `true`

### `planner.codeLens.enabled`

Show CodeLens above milestone headings.

Type: boolean · default: `true`

### `planner.codeLens.tasks`

Show the scheduled dates and slack above each task.

Type: boolean · default: `true`

### `planner.codeLens.actions`

Show clickable actions next to the CodeLens: owner and **Edit** on tasks, **Add task**, **Add section** and **Edit milestone** on milestones, **Add person**, **Edit person**, **Add time off**, **Plan overtime** and **Add working day** in `team.md`, **Edit project settings** in `project.md`, **Capture to inbox** and **Plan into milestone…** in `inbox.md`, **Add punch item** in `punchlist.md`, **Open in test runner** in test plans. The schedule CodeLens stays.

Type: boolean · default: `true`

## Scheduling and diagnostics

### `planner.scheduling.unassignedCapacity`

Capacity in hours per week of the virtual **Unassigned** pool that runs tasks without `@owner`.

Type: number · default: `40` · minimum: 0

### `planner.diagnostics.overbooked`

Show an info diagnostic on a person in `team.md` when their workload makes tasks late: their open work, until when it is planned, and the tasks that finish after their deadline because of it.

Type: boolean · default: `true`

## Kanban

### `planner.kanban.wipLimits`

Work-in-progress limit per Kanban column, e.g. `{ "doing": 4, "review": 3 }`. Columns over their limit are shown in red.

Type: object · default: `{}`

## Time tracking

### `planner.time.roundingMinutes`

Timer time is rounded up to this many minutes before it is added to `@act` (at most 60). When the rounded time is more than a working day, stopping the timer asks first.

Type: number · default: `15` · minimum: 1 · maximum: 60

## TODOs in code

### `planner.todos.keywords`

Comment keywords collected in **TODOs in Code** (upper case, whole words, followed by `:`, `(…)` or a space).

Type: array · default: `["TODO","FIXME"]`

### `planner.todos.include`

Glob of files searched for TODO comments (the plan folder is always skipped).

Type: string · default: `"**/*.{ts,tsx,js,jsx,mjs,cjs,vue,svelte,py,java,kt,cs,go,rs,rb,php,swift,c,h,cpp,hpp,sql,sh,md,scl,st}"`

### `planner.todos.exclude`

Glob of files never searched for TODO comments.

Type: string · default: `"**/{node_modules,.git,dist,out,build,target,coverage,vendor,.venv,.vscode-test}/**"`

### `planner.todos.maxFiles`

Maximum number of files searched for TODO comments.

Type: number · default: `2000` · minimum: 1

## Export

### `planner.export.branding`

Branding of exported reports: `{ "company": "Example Corp", "accentColor": "#0f766e", "logo": "docs/logo.png" }` (logo relative to the workspace folder; PNG, JPEG, GIF, SVG or WebP, embedded in the report).

Type: object · default: `{}`

### `planner.export.periodDays`

Length of the reporting period in days ("done this period" and "planned next period").

Type: number · default: `7` · minimum: 1

### `planner.export.ganttWeeks`

Weeks shown in the report's Gantt and team load sections.

Type: number · default: `12` · minimum: 1

### `planner.export.author`

Author shown in reports. Empty = the name of `planner.me`.

Type: string · default: `""`

### `planner.export.browserPath`

Path to Microsoft Edge or Google Chrome for PDF export. Empty = detect automatically; without a browser the HTML report is written instead.

Type: string · default: `""`

### `planner.export.csvDelimiter`

Field delimiter of the CSV export (`;` suits Excel in many European locales).

Type: string · default: `","`

- `","`
- `";"`
- `"\t"`

### `planner.export.openAfterExport`

Open the exported file after `Planner: Export…`.

Type: boolean · default: `true`

## AI

### `planner.ai.provider`

AI provider for the `Planner AI` commands. AI only proposes changes: every change is shown as a diff to accept or reject, and the scheduler (not the AI) computes all dates.

Type: string · default: `"vscode-lm"`

- `"vscode-lm"`: VS Code Language Model API: any installed model provider, e.g. GitHub Copilot.
- `"anthropic"`: Claude API directly; the key is stored with "Planner: Set API key".
- `"none"`: No AI: AI commands are hidden; everything else works.

### `planner.ai.vscodeModel`

Model family for the `vscode-lm` provider (for example `gpt-4o` or `claude-sonnet-4`). Empty = the first available model.

Type: string · default: `""`

### `planner.ai.model`

Claude model id for the `anthropic` provider.

Type: string · default: `"claude-sonnet-5-5"`

### `planner.ai.redact`

Terms removed from prompts before they are sent (customer names …). Literal, case-insensitive terms, or `/regex/flags`.

Type: array · default: `[]`

## MCP server

### `planner.mcp.configureOnNewProject`

**New project** also writes `.mcp.json` with the md-planner MCP server and the agent skill (`.claude/skills/md-planner/SKILL.md`), so Claude Code and other agents can build and update the plan right away (same as **Planner: Configure MCP for Claude Code** and **Planner: Add the md-planner Skill for AI Agents**).

Type: boolean · default: `true`
