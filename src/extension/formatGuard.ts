// Plan files are edited character by character; a formatter that rewrites them on save (format on
// save with Prettier and the like) can change task lines and how subtasks nest. This notices when
// a save changed a plan file beyond the planner's own save edits, and offers to stop it.
import * as vscode from "vscode";
import { sameExceptTrailingSpace } from "../core/text";
import { type PlanService } from "./planService";

const NEVER_KEY = "planner.formatGuard.never";

export class FormatGuard implements vscode.Disposable {
  /** Plan paths whose last save was rewritten by something else (also a test hook). */
  readonly reformatted: string[] = [];
  private readonly expected = new Map<string, string>();
  private asked = false;
  private readonly disposables: vscode.Disposable[];

  constructor(
    private readonly service: PlanService,
    private readonly memento: vscode.Memento
  ) {
    this.disposables = [
      vscode.workspace.onWillSaveTextDocument((e) => {
        if (this.service.isPlanDocument(e.document))
          this.expected.set(e.document.uri.toString(), e.document.getText());
      }),
      vscode.workspace.onDidSaveTextDocument(
        (doc) =>
          void this.check(doc).catch((err) =>
            this.service.log.warn(
              `Format guard: ${err instanceof Error ? err.message : String(err)}`
            )
          )
      ),
    ];
  }

  /** The text the planner's own save edits (ids) produce: what the saved file should be. */
  expect(doc: vscode.TextDocument, text: string): void {
    this.expected.set(doc.uri.toString(), text);
  }

  private async check(doc: vscode.TextDocument): Promise<void> {
    const key = doc.uri.toString();
    const expected = this.expected.get(key);
    this.expected.delete(key);
    if (expected === undefined || sameExceptTrailingSpace(expected, doc.getText())) return;
    const rel = this.service.relPath(doc.uri) ?? doc.uri.fsPath;
    this.reformatted.push(rel);
    if (this.asked || this.memento.get<boolean>(NEVER_KEY)) return;
    this.asked = true;
    const editor = vscode.workspace.getConfiguration("editor", doc);
    const onSave = editor.get<boolean>("formatOnSave", false);
    const formatter = editor.get<string>("defaultFormatter");
    const off = "Turn off format on save for Markdown here";
    const ignore = "Add the plan folder to .prettierignore";
    const never = "Don't ask again";
    const actions = [
      ...(onSave ? [off] : []),
      ...(formatter?.toLowerCase().includes("prettier") ? [ignore] : []),
      never,
    ];
    const who = onSave
      ? `format on save${formatter ? ` with ${formatter}` : ""}`
      : "another extension, on save";
    const pick = await vscode.window.showWarningMessage(
      `Planner: ${rel} was reformatted when it was saved (${who}). A formatter can change task lines and how subtasks nest; the planner only changes the characters an edit needs.`,
      ...actions
    );
    if (pick === off) await this.turnOffFormatOnSave();
    else if (pick === ignore) await this.addToPrettierIgnore();
    else if (pick === never) await this.memento.update(NEVER_KEY, true);
  }

  /**
   * Turns off format on save for Markdown in the workspace settings (also a test hook). VS Code
   * refuses when .vscode/settings.json has an error or unsaved changes; then the user is told why,
   * with the file a click away. True when it was turned off.
   */
  async turnOffFormatOnSave(): Promise<boolean> {
    try {
      await vscode.workspace
        .getConfiguration("editor", { languageId: "markdown" })
        .update("formatOnSave", false, vscode.ConfigurationTarget.Workspace, true);
      return true;
    } catch (err) {
      const open = "Open Workspace Settings";
      const why = err instanceof Error ? err.message : String(err);
      this.service.log.warn(`Could not turn off format on save: ${why}`);
      const pick = await vscode.window.showErrorMessage(
        `Planner: could not turn off format on save for Markdown: ${why} Fix the workspace settings (.vscode/settings.json), or set "editor.formatOnSave": false under "[markdown]" there yourself.`,
        open
      );
      if (pick === open)
        await vscode.commands.executeCommand("workbench.action.openWorkspaceSettingsFile");
      return false;
    }
  }

  /**
   * Adds the plan folder (relative to its workspace folder) to `.prettierignore`, creating the file
   * when needed (also a test hook). One WorkspaceEdit, so it can be undone and an open editor of
   * the file shows it; saved at once, as Prettier reads the file from disk.
   */
  async addToPrettierIgnore(): Promise<void> {
    const root = this.service.root;
    const folder = root ? vscode.workspace.getWorkspaceFolder(root) : undefined;
    if (!root || !folder) return;
    const rel = root.path.slice(folder.uri.path.length).replace(/^\/+/, "") || ".";
    const file = vscode.Uri.joinPath(folder.uri, ".prettierignore");
    const doc = await vscode.workspace.openTextDocument(file).then(
      (d) => d,
      () => undefined
    );
    const text = doc?.getText() ?? "";
    const line = rel === "." ? "*.md" : `${rel}/`;
    if (text.split(/\r?\n/).includes(line)) return;
    const eol = doc?.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const edit = new vscode.WorkspaceEdit();
    if (!doc) edit.createFile(file, { ignoreIfExists: true });
    edit.insert(
      file,
      doc?.positionAt(text.length) ?? new vscode.Position(0, 0),
      `${text && !text.endsWith("\n") ? eol : ""}${line}${eol}`
    );
    if (!(await vscode.workspace.applyEdit(edit))) return;
    await (await vscode.workspace.openTextDocument(file)).save();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
