// Baselines in plan/baselines/*.json: listing, loading, saving and change notification.
import * as vscode from "vscode";
import {
  type Baseline,
  baselineFileName,
  baselineSlug,
  baselineLookup,
  baselineText,
  createBaseline,
  parseBaseline,
} from "../core/baseline";
import { type BaselineLookup } from "../core/views/gantt";
import { type PlannerState } from "./state";
import { decode, encode } from "./util";
import { type BaselineSource } from "./webviews/ganttPanel";

export class BaselineService implements BaselineSource, vscode.Disposable {
  private baselines = new Map<string, Baseline>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private watcher: vscode.FileSystemWatcher | undefined;

  constructor(private readonly state: PlannerState) {
    this.disposables.push(
      this.emitter,
      state.service.onDidChangeRoot(() => void this.reload())
    );
    void this.reload();
  }

  private folder(): vscode.Uri | undefined {
    const root = this.state.service.root;
    return root ? vscode.Uri.joinPath(root, "baselines") : undefined;
  }

  /** Baseline ids (file names without .json), oldest first. */
  names(): string[] {
    return [...this.baselines.entries()]
      .sort(([, a], [, b]) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name))
      .map(([id]) => id);
  }

  get(id: string | undefined): Baseline | undefined {
    if (id) return this.baselines.get(id);
    const names = this.names();
    return names.length ? this.baselines.get(names[names.length - 1]) : undefined;
  }

  lookup(id: string | undefined): BaselineLookup | undefined {
    const b = this.get(id);
    return b ? baselineLookup(b) : undefined;
  }

  async reload(): Promise<void> {
    this.watcher?.dispose();
    this.baselines.clear();
    const folder = this.folder();
    if (folder) {
      this.watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, "*.json")
      );
      const changed = () => void this.reload();
      this.watcher.onDidCreate(changed);
      this.watcher.onDidChange(changed);
      this.watcher.onDidDelete(changed);
      try {
        for (const [name, type] of await vscode.workspace.fs.readDirectory(folder)) {
          if (!(type & vscode.FileType.File) || !name.endsWith(".json")) continue;
          try {
            const text = decode(
              await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, name))
            );
            this.baselines.set(name.replace(/\.json$/, ""), parseBaseline(text, name));
          } catch (err) {
            this.state.service.log.warn(String(err instanceof Error ? err.message : err));
          }
        }
      } catch {
        // No baselines folder yet.
      }
    }
    this.emitter.fire();
  }

  /** Id (file name without .json) that a baseline with this name gets today. */
  idFor(name: string): string {
    return `${this.state.today}-${baselineSlug(name)}`;
  }

  /** Writes baselines/<date>-<name>.json as an undoable file creation. Returns the id. */
  async save(name: string, overwrite = false): Promise<string | undefined> {
    const folder = this.folder();
    if (!folder) return undefined;
    const baseline = createBaseline(this.state.plan, this.state.schedule, name.trim());
    const file = baselineFileName(baseline);
    const uri = vscode.Uri.joinPath(folder, file);
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(uri, {
      contents: encode(baselineText(baseline)),
      overwrite,
      ignoreIfExists: !overwrite,
    });
    if (!(await vscode.workspace.applyEdit(edit))) return undefined;
    await this.reload();
    return file.replace(/\.json$/, "");
  }

  dispose(): void {
    this.watcher?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

export async function saveBaselineCommand(
  service: BaselineService,
  name?: string
): Promise<string | undefined> {
  const value =
    name ??
    (await vscode.window.showInputBox({
      prompt: "Baseline name",
      placeHolder: "e.g. kickoff, after FDS approval",
      validateInput: (v) => (v.trim() ? undefined : "Enter a name"),
    }));
  if (!value) return undefined;
  let overwrite = false;
  const id = service.idFor(value);
  if (service.names().includes(id)) {
    if (name === undefined) {
      const pick = await vscode.window.showWarningMessage(
        `Baseline ${id}.json already exists.`,
        { modal: true },
        "Overwrite"
      );
      if (pick !== "Overwrite") return undefined;
    }
    overwrite = true;
  }
  const saved = await service.save(value, overwrite);
  if (saved)
    void vscode.window.showInformationMessage(`Planner: baseline saved as baselines/${saved}.json`);
  return saved;
}
