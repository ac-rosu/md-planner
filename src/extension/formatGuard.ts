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
      vscode.workspace.onDidSaveTextDocument((doc) => void this.check(doc)),
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
    if (pick === off)
      await vscode.workspace
        .getConfiguration("editor", { languageId: "markdown" })
        .update("formatOnSave", false, vscode.ConfigurationTarget.Workspace, true);
    else if (pick === ignore) await this.addToPrettierIgnore();
    else if (pick === never) await this.memento.update(NEVER_KEY, true);
  }

  /** Adds the plan folder (relative to its workspace folder) to `.prettierignore`. */
  private async addToPrettierIgnore(): Promise<void> {
    const root = this.service.root;
    const folder = root ? vscode.workspace.getWorkspaceFolder(root) : undefined;
    if (!root || !folder) return;
    const rel = root.path.slice(folder.uri.path.length).replace(/^\/+/, "") || ".";
    const file = vscode.Uri.joinPath(folder.uri, ".prettierignore");
    const text = await vscode.workspace.fs.readFile(file).then(
      (b) => new TextDecoder().decode(b),
      () => ""
    );
    const line = rel === "." ? "*.md" : `${rel}/`;
    if (text.split(/\r?\n/).includes(line)) return;
    const next = `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(next));
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
