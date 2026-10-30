// Hover, go to definition, find references and rename for task ids and other references.
import * as vscode from "vscode";
import { formatHours } from "../../core/duration";
import { STATUS_LABEL, STATUSES } from "../../core/model";
import { matchCheckbox } from "../../core/parser/taskLine";
import {
  definitionOf,
  isValidTaskId,
  type Location,
  type Reference,
  referenceAt,
  referencesOf,
} from "../../core/navigation";
import { milestoneStats, openTasksOf } from "../../core/queries";
import { estimateHours, remainingHours } from "../../core/rollup";
import { renameIdProblem, renameTaskId, sharedIdProblem } from "../../core/writer";
import { itemAtLine, type TaskArg } from "../commands/args";
import { type PlanService } from "../planService";
import { type PlannerState } from "../state";
import { md, toRange } from "../util";
import { statusCodicon } from "../views/common";

function refAt(
  service: PlanService,
  document: vscode.TextDocument,
  position: vscode.Position
): Reference | undefined {
  if (!service.isPlanDocument(document)) return undefined;
  return referenceAt(document.lineAt(position.line).text, position.line, position.character);
}

function toLocation(service: PlanService, loc: Location): vscode.Location {
  return new vscode.Location(service.uri(loc.file), toRange(loc.range));
}

export class PlanHoverProvider implements vscode.HoverProvider {
  constructor(private readonly state: PlannerState) {}

  /** Hovering a task's checkbox offers the other statuses as links (a click on it does nothing). */
  private statusHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | undefined {
    const service = this.state.service;
    if (!service.isPlanDocument(document)) return undefined;
    const cb = matchCheckbox(document.lineAt(position.line).text);
    if (!cb || position.character < cb.statusCol - 1 || position.character > cb.statusCol + 1)
      return undefined;
    const rel = service.relPath(document.uri);
    const t = rel === undefined ? undefined : itemAtLine(this.state.plan, rel, position.line);
    if (!t || t.line !== position.line || t.kind === "step") return undefined;
    // This line, not the id (a copied line keeps it); a change from the editor is not saved.
    const arg: TaskArg = { file: t.file, line: t.line, fromEditor: true };
    const out = new vscode.MarkdownString(undefined, true);
    out.supportThemeIcons = true;
    out.isTrusted = { enabledCommands: ["planner.setStatus"] };
    const links = STATUSES.filter((s) => s !== t.status).map((s) => {
      const args = encodeURIComponent(JSON.stringify([arg, s]));
      return `[$(${statusCodicon(s)}) ${STATUS_LABEL[s]}](command:planner.setStatus?${args} "Set the status to ${STATUS_LABEL[s]}")`;
    });
    out.appendMarkdown(`$(${statusCodicon(t.status)}) **${STATUS_LABEL[t.status]}** · `);
    out.appendMarkdown(`Set to ${links.join(" · ")}`);
    const at = (c: number) => new vscode.Position(position.line, c);
    return new vscode.Hover(out, new vscode.Range(at(cb.statusCol - 1), at(cb.statusCol + 2)));
  }

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const status = this.statusHover(document, position);
    if (status) return status;
    const ref = refAt(this.state.service, document, position);
    if (!ref) return undefined;
    const plan = this.state.plan;
    const out = new vscode.MarkdownString(undefined, true);
    out.supportThemeIcons = true;
    switch (ref.kind) {
      case "task":
      case "punch": {
        const t = ref.kind === "task" ? plan.taskById(ref.id) : plan.punchById(ref.id);
        if (!t) {
          out.appendMarkdown(
            `$(warning) Unknown ${ref.kind === "task" ? "task" : "punch item"} **${md(ref.id)}**`
          );
          break;
        }
        out.appendMarkdown(`**${md(ref.id)} · ${md(t.title)}**\n\n`);
        const rows: string[] = [`${STATUS_LABEL[t.status]}`];
        const m = plan.milestoneById(t.milestoneId);
        if (m) rows.push(`${md(m.title)}${t.section ? ` › ${md(t.section)}` : ""}`);
        const owner = t.owner ?? undefined;
        if (owner) rows.push(`Owner: ${md(plan.personById(owner)?.name ?? owner)}`);
        const est = estimateHours(t);
        if (est !== undefined)
          rows.push(
            `Estimate ${formatHours(est)}` +
              (t.act !== undefined ? ` · actual ${formatHours(t.act)}` : "") +
              ` · remaining ${formatHours(remainingHours(t))}`
          );
        if (t.sev) rows.push(`Severity ${t.sev}`);
        if (t.due) rows.push(`Due ${t.due}`);
        if (t.blocked) rows.push(`Blocked: ${md(t.blocked)}`);
        rows.push(...this.state.tooltipLines(t));
        out.appendMarkdown(rows.join("  \n"));
        break;
      }
      case "person": {
        const p = plan.personById(ref.id);
        if (!p) {
          out.appendMarkdown(`$(warning) **${md(ref.id)}** is not in team.md`);
          break;
        }
        const open = openTasksOf(plan, p.id);
        const remaining = open.reduce((s, t) => s + remainingHours(t), 0);
        out.appendMarkdown(`**${md(p.name)}**${p.role ? ` · ${md(p.role)}` : ""}\n\n`);
        const rows = [
          `Capacity ${p.capacityHours}h/${p.capacityPer}`,
          `${open.length} open tasks · ${formatHours(remaining)} remaining`,
        ];
        const load = this.state.weekLoad(p.id);
        if (load)
          rows.push(
            `This week: ${load.label}${load.over ? " $(warning) over capacity" : ""}${load.overtime ? ` (${load.overtime})` : ""}`
          );
        if (p.skills.length) rows.push(`Skills: ${md(p.skills.join(", "))}`);
        out.appendMarkdown(rows.join("  \n"));
        break;
      }
      case "test": {
        const tp = plan.testById(ref.id);
        if (!tp) {
          out.appendMarkdown(`$(warning) Unknown test plan **${md(ref.id)}**`);
          break;
        }
        const steps = tp.cases.flatMap((c) => c.steps);
        const pass = steps.filter((s) => s.result === "pass").length;
        const fail = steps.filter((s) => s.result === "fail").length;
        out.appendMarkdown(
          `**${md(tp.title)}**\n\n${tp.cases.length} cases · ${steps.length} steps · ${pass} pass · ${fail} fail · ${steps.length - pass - fail} open`
        );
        break;
      }
      case "testCase": {
        const tp = plan.testById(ref.testId);
        const c = tp?.cases.find((x) => x.id.toLowerCase() === ref.caseId.toLowerCase());
        if (!c) return undefined;
        out.appendMarkdown(
          `**${md(c.id)} ${md(c.title)}**\n\n${c.steps.length} steps${c.pre ? `  \nPre: ${md(c.pre)}` : ""}`
        );
        break;
      }
      case "milestone": {
        const m = plan.milestoneById(ref.id);
        if (!m) {
          out.appendMarkdown(`$(warning) Unknown milestone **${md(ref.id)}**`);
          break;
        }
        const s = milestoneStats(m);
        out.appendMarkdown(
          `**${md(m.title)}**\n\n${s.done}/${s.total} tasks · ${Math.round(s.progress * 100)}%${m.target ? ` · target ${m.target}` : ""}`
        );
        break;
      }
      case "tag": {
        const n = plan.tasks.filter((t) => t.tags.some((x) => x.tag === ref.tag)).length;
        out.appendMarkdown(`**#${md(ref.tag)}** · ${n} tasks`);
        break;
      }
      case "source":
        out.appendMarkdown(
          `Source: \`${md(ref.path)}\`${ref.line !== undefined ? ` line ${ref.line + 1}` : ""} — Ctrl/Cmd+click to open`
        );
        break;
    }
    return new vscode.Hover(out, toRange(ref.range));
  }
}

export class PlanDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly service: PlanService) {}

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Location | undefined {
    const ref = refAt(this.service, document, position);
    if (!ref) return undefined;
    if (ref.kind === "source") return sourceLocation(document, ref.path, ref.line);
    const loc = definitionOf(this.service.plan, ref);
    return loc ? toLocation(this.service, loc) : undefined;
  }
}

export class PlanReferenceProvider implements vscode.ReferenceProvider {
  constructor(private readonly service: PlanService) {}

  provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext
  ): vscode.Location[] | undefined {
    const ref = refAt(this.service, document, position);
    if (!ref) return undefined;
    const plan = this.service.plan;
    let locs = referencesOf(plan, ref);
    if (!context.includeDeclaration) {
      const def = definitionOf(plan, ref);
      const isDef = (l: Location & { isDefinition?: boolean }) =>
        l.isDefinition === true ||
        (def !== undefined &&
          l.file === def.file &&
          l.range.start.line === def.range.start.line &&
          l.range.start.character === def.range.start.character);
      locs = locs.filter((l) => !isDef(l));
    }
    return locs.map((l) => toLocation(this.service, l));
  }
}

export class PlanRenameProvider implements vscode.RenameProvider {
  constructor(private readonly service: PlanService) {}

  prepareRename(
    document: vscode.TextDocument,
    position: vscode.Position
  ): { range: vscode.Range; placeholder: string } {
    const ref = refAt(this.service, document, position);
    if (!ref || ref.kind !== "task") throw new Error("Only task ids (^T…) can be renamed.");
    if (!this.service.plan.taskById(ref.id)) throw new Error(`Unknown task id ${ref.id}.`);
    // A copied line keeps the id: renaming would change every copy and every dependency.
    const shared = sharedIdProblem(this.service.plan, ref.id);
    if (shared) throw new Error(shared);
    return { range: toRange(ref.range), placeholder: ref.id };
  }

  async provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string
  ): Promise<vscode.WorkspaceEdit> {
    const ref = refAt(this.service, document, position);
    if (!ref || ref.kind !== "task") throw new Error("Only task ids can be renamed.");
    const plan = this.service.plan;
    const id = newName.trim().replace(/^\^/, "");
    if (!isValidTaskId(id)) throw new Error(`"${newName}" is not a valid id (e.g. T142).`);
    const problem = renameIdProblem(plan, ref.id, id);
    if (problem) throw new Error(problem);
    const changes = renameTaskId(plan, ref.id, id);
    // The rename edits every file that names the id, also ones not open: the same rules as any
    // planner edit (no file that is not UTF-8; a conflicted one only when the user says so).
    const touched = [...new Set(changes.map((fe) => fe.path))];
    const notUtf8 = touched.find((p) => this.service.untouchable(p) === "not UTF-8");
    if (notUtf8)
      throw new Error(`${notUtf8} names ${ref.id} but is not UTF-8; save it as UTF-8 first.`);
    if (!(await this.service.mayChange(touched))) throw new Error("Rename cancelled.");
    const edit = new vscode.WorkspaceEdit();
    for (const fe of changes) {
      for (const e of fe.edits)
        edit.replace(this.service.uri(fe.path), toRange(e.range), e.newText);
    }
    return edit;
  }
}

/** Resolves a workspace-relative `@src` path against the workspace folder of the plan file. */
export function sourceLocation(
  document: vscode.TextDocument,
  path: string,
  line?: number
): vscode.Location | undefined {
  const folder =
    vscode.workspace.getWorkspaceFolder(document.uri) ?? vscode.workspace.workspaceFolders?.[0];
  if (!folder || !path) return undefined;
  const uri = vscode.Uri.joinPath(folder.uri, ...path.split("/"));
  return new vscode.Location(uri, new vscode.Position(line ?? 0, 0));
}
