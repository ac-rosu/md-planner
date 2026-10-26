# AI that proposes, you decide

AI commands are off until you pick a provider (`planner.ai.provider`):

- `vscode-lm`: a language model installed in VS Code (for example GitHub Copilot)
- `anthropic`: the Claude API, with the key kept in VS Code's secret storage
- `none`: hides every AI command

Break down a task, estimate, calibrate estimates against your actuals, suggest owners, turn notes
into tasks, draft a status summary or review the schedule. Every change is shown as a **diff with
Accept / Reject**; nothing is written before you accept, and dates always come from the scheduler.
Terms in `planner.ai.redact` (customer names, order numbers) are removed before anything is sent.

**Agents (MCP)**: every planner feature is an MCP tool. New project (or **Planner: Configure MCP
for Claude Code**) adds the server to `.mcp.json`; Copilot agent mode finds it by itself. Describe
the project in plain text and the agent builds the whole plan (team, milestones, tasks,
dependencies) in one validated step, then keeps it up to date with the same rules as the
extension. A change that would break the plan is refused. **Planner: Add the md-planner Skill for
AI Agents** (also done by New project) teaches agents the rules: never write computed dates, keep
task ids, validate after editing a file by hand.
