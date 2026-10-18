// Publishes plan diagnostics to the Problems panel.
import * as vscode from "vscode";
import { type Issue } from "../../core/model";
import { type PlannerState } from "../state";
import { config, toRange, toSeverity } from "../util";

export class PlanDiagnostics implements vscode.Disposable {
  readonly collection = vscode.languages.createDiagnosticCollection("planner");
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly state: PlannerState) {
    this.disposables.push(
      this.collection,
      state.onDidUpdate(() => this.update())
    );
  }

  update(): void {
    const service = this.state.service;
    this.collection.clear();
    if (!service.root) return;
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const issue of this.state.issues({
      missingIds: !config().get<boolean>("autoAssignIds", true),
    })) {
      const list = byFile.get(issue.file) ?? [];
      list.push(toDiagnostic(issue));
      byFile.set(issue.file, list);
    }
    for (const [file, diagnostics] of byFile) this.collection.set(service.uri(file), diagnostics);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

export function toDiagnostic(issue: Issue): vscode.Diagnostic {
  const d = new vscode.Diagnostic(toRange(issue.range), issue.message, toSeverity(issue.severity));
  d.source = "planner";
  d.code = issue.code;
  return d;
}
