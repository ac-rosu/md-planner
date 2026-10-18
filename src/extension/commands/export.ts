// `Planner: Export…`: pick formats and report sections, write plan/reports/<date>-<name>.<ext>,
// open the result.
import * as vscode from "vscode";
import {
  EXPORT_FORMATS,
  type ExportFormat,
  exportFormatOf,
  logoDataUri,
  REPORT_SECTIONS,
  type ReportSection,
  runExport,
} from "../../export/index";
import { type Branding } from "../../export/html/report";
import { type BaselineService } from "../baselines";
import { type PlannerState } from "../state";
import { config, exists } from "../util";

export interface ExportArgs {
  formats?: ExportFormat[];
  sections?: ReportSection[];
  summary?: string;
  testPlan?: string;
  /** Open the first file afterwards (default `planner.export.openAfterExport`). */
  open?: boolean;
  name?: string;
}

/** Supplies a drafted status summary (the AI provider in Phase 8); undefined = not available. */
export type SummaryDrafter = () => Promise<string | undefined>;

export async function exportCommand(
  state: PlannerState,
  baselines: BaselineService,
  memento: vscode.Memento,
  args: ExportArgs = {},
  draftSummary?: SummaryDrafter
): Promise<vscode.Uri[]> {
  const root = state.service.root;
  if (!root) {
    void vscode.window.showErrorMessage("Planner: no plan folder in this workspace.");
    return [];
  }
  const c = config();

  // 1. Formats
  let formats = args.formats;
  if (!formats) {
    const last = (memento.get<string[]>("export.formats") ?? ["html"]).map(exportFormatOf);
    const picks = await vscode.window.showQuickPick(
      EXPORT_FORMATS.map((f) => ({
        label: f.label,
        detail: f.detail,
        id: f.id,
        picked: last.includes(f.id),
      })),
      { canPickMany: true, placeHolder: "Export formats", title: "Planner: Export" }
    );
    if (!picks || picks.length === 0) return [];
    formats = picks.map((p) => p.id);
    await memento.update("export.formats", formats);
  }

  // 2. Sections of the status report
  let sections = args.sections;
  if (!sections && (formats.includes("html") || formats.includes("pdf"))) {
    const last =
      memento.get<ReportSection[]>("export.sections") ?? REPORT_SECTIONS.map((s) => s.id);
    const picks = await vscode.window.showQuickPick(
      REPORT_SECTIONS.map((s) => ({ label: s.label, id: s.id, picked: last.includes(s.id) })),
      { canPickMany: true, placeHolder: "Sections of the status report", title: "Planner: Export" }
    );
    if (!picks) return [];
    sections = picks.map((p) => p.id);
    await memento.update("export.sections", sections);
  }

  // 3. Summary
  let summary = args.summary;
  if (summary === undefined && sections?.includes("summary")) {
    const last = memento.get<string>("export.summary") ?? "";
    let initial = last;
    if (draftSummary) {
      const choice = await vscode.window.showQuickPick(
        [
          {
            label: "$(sparkle) Draft with AI",
            description: "from the computed metrics; you can edit it next",
            id: "ai",
          },
          {
            label: "$(edit) Write it myself",
            description: last ? "starts from the last summary" : undefined,
            id: "manual",
          },
          { label: "$(circle-slash) No summary", id: "none" },
        ],
        { placeHolder: "Status summary", title: "Planner: Export" }
      );
      if (!choice) return [];
      if (choice.id === "none") initial = "";
      if (choice.id === "ai") initial = (await draftSummary()) ?? last;
      if (choice.id === "none") summary = "";
    }
    if (summary === undefined) {
      const text = await vscode.window.showInputBox({
        title: "Status summary (5–8 sentences, optional)",
        prompt: "Edit the summary for the report. Leave empty for none.",
        value: initial,
      });
      if (text === undefined) return [];
      summary = text;
    }
    await memento.update("export.summary", summary);
  }

  // 4. Test plan for the test report
  let testPlan = args.testPlan;
  if (
    !testPlan &&
    (formats.includes("test-report") || formats.includes("test-report-pdf")) &&
    state.plan.tests.length > 1
  ) {
    const pick = await vscode.window.showQuickPick(
      state.plan.tests.map((t) => ({ label: t.id, description: t.title, id: t.id })),
      { placeHolder: "Test plan for the test report" }
    );
    if (!pick) return [];
    testPlan = pick.id;
  }

  // 5. Generate
  const me = c.get<string>("me", "") || state.plan.people[0]?.id;
  const author = c.get<string>("export.author", "") || state.plan.personById(me)?.name || undefined;
  const branding = await readBranding(root);
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Planner: exporting…" },
    () =>
      runExport(state.plan, state.schedule, state.demand, {
        formats: formats!,
        sections,
        summary,
        periodDays: c.get<number>("export.periodDays", 7),
        ganttWeeks: c.get<number>("export.ganttWeeks", 12),
        author,
        branding,
        baseline: baselines.get(undefined),
        testPlan,
        csvDelimiter: c.get<string>("export.csvDelimiter", ",") || ",",
        browserPath: c.get<string>("export.browserPath", "") || undefined,
        name: args.name,
      })
  );

  // 6. Write to plan/reports/
  const reports = vscode.Uri.joinPath(root, "reports");
  await vscode.workspace.fs.createDirectory(reports);
  const written: vscode.Uri[] = [];
  for (const f of result.files) {
    const uri = vscode.Uri.joinPath(reports, f.name);
    await vscode.workspace.fs.writeFile(
      uri,
      typeof f.data === "string" ? new TextEncoder().encode(f.data) : f.data
    );
    written.push(uri);
  }
  for (const w of result.warnings) void vscode.window.showWarningMessage(`Planner: ${w}`);
  state.service.log.info(`Exported ${written.map((u) => u.path.split("/").pop()).join(", ")}`);

  // 7. Open
  if (written.length && (args.open ?? c.get<boolean>("export.openAfterExport", true))) {
    const first = written[0];
    if (/\.(csv|xml)$/i.test(first.path))
      await vscode.window.showTextDocument(first, { preview: true });
    else await vscode.env.openExternal(first);
  }
  if (written.length) {
    void vscode.window
      .showInformationMessage(
        `Planner: exported ${written.length} file(s) to ${vscode.workspace.asRelativePath(reports)}.`,
        "Reveal in Explorer"
      )
      .then((choice) => {
        if (choice) void vscode.commands.executeCommand("revealInExplorer", written[0]);
      });
  }
  return written;
}

/** `planner.export.branding` with the logo file read and embedded. */
async function readBranding(planRoot: vscode.Uri): Promise<Branding | undefined> {
  const b = config().get<{ company?: string; accentColor?: string; logo?: string }>(
    "export.branding",
    {}
  );
  if (!b || (!b.company && !b.accentColor && !b.logo)) return undefined;
  const branding: Branding = {
    company: b.company || undefined,
    accentColor: b.accentColor || undefined,
  };
  if (b.logo) {
    const folder =
      vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.joinPath(planRoot, "..");
    const uri =
      b.logo.startsWith("/") || /^[A-Za-z]:[\\/]/.test(b.logo)
        ? vscode.Uri.file(b.logo)
        : vscode.Uri.joinPath(folder, ...b.logo.split(/[\\/]/));
    if (await exists(uri)) {
      branding.logoDataUri = logoDataUri(await vscode.workspace.fs.readFile(uri), uri.path);
      if (!branding.logoDataUri)
        void vscode.window.showWarningMessage(
          `Planner: the logo ${b.logo} is not a PNG, JPEG, GIF, SVG or WebP image.`
        );
    } else {
      void vscode.window.showWarningMessage(`Planner: logo file not found: ${b.logo}`);
    }
  }
  return branding;
}
