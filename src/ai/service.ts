// AI service: picks the provider from the settings, keeps the Claude API key in SecretStorage,
// redacts prompts, logs every request and response, and parses the JSON reply.
import * as vscode from "vscode";
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from "./anthropic";
import { AiError, type AiProvider, type AiRequest, parseJsonReply, redact } from "./provider";
import { VscodeLmProvider } from "./vscodeLm";

export const API_KEY_SECRET = "planner.anthropicApiKey";

export type ProviderSetting = "vscode-lm" | "anthropic" | "none";

export class AiService implements vscode.Disposable {
  readonly log = vscode.window.createOutputChannel("Planner AI", { log: true });
  private override: AiProvider | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly secrets: vscode.SecretStorage) {
    this.disposables.push(
      this.log,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("planner.ai")) void this.updateContext();
      })
    );
    void this.updateContext();
  }

  get setting(): ProviderSetting {
    return vscode.workspace
      .getConfiguration("planner")
      .get<ProviderSetting>("ai.provider", "vscode-lm");
  }

  get enabled(): boolean {
    return this.override !== undefined || this.setting !== "none";
  }

  /** Replaces the configured provider (used by tests and by extensions that bring their own). */
  useProvider(provider: AiProvider | undefined): void {
    this.override = provider;
    void this.updateContext();
  }

  async setApiKey(): Promise<boolean> {
    const key = await vscode.window.showInputBox({
      title: "Claude API key",
      prompt: "Kept in VS Code's encrypted storage; only sent to the Claude API.",
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().length < 10 ? "Paste an API key" : undefined),
    });
    if (!key) return false;
    await this.secrets.store(API_KEY_SECRET, key.trim());
    void vscode.window.showInformationMessage("Planner: Claude API key saved.");
    return true;
  }

  async provider(): Promise<AiProvider> {
    if (this.override) return this.override;
    const c = vscode.workspace.getConfiguration("planner");
    switch (this.setting) {
      case "anthropic": {
        const apiKey = await this.secrets.get(API_KEY_SECRET);
        if (!apiKey) {
          const pick = await vscode.window.showWarningMessage(
            "Planner: no Claude API key is stored.",
            "Set API key"
          );
          if (pick) await this.setApiKey();
          const again = await this.secrets.get(API_KEY_SECRET);
          if (!again) throw new AiError("No Claude API key.");
          return new AnthropicProvider({
            apiKey: again,
            model: c.get<string>("ai.model", DEFAULT_ANTHROPIC_MODEL),
          });
        }
        return new AnthropicProvider({
          apiKey,
          model: c.get<string>("ai.model", DEFAULT_ANTHROPIC_MODEL),
        });
      }
      case "vscode-lm":
        return new VscodeLmProvider(c.get<string>("ai.vscodeModel", "") || undefined);
      default:
        throw new AiError('AI is turned off (planner.ai.provider is "none").');
    }
  }

  /** Sends a request (redacted, logged, cancellable) and returns the parsed JSON reply. */
  async run(request: AiRequest): Promise<{ reply: unknown; model: string }> {
    const provider = await this.provider();
    const patterns = vscode.workspace.getConfiguration("planner").get<string[]>("ai.redact", []);
    const sent: AiRequest = {
      ...request,
      system: redact(request.system, patterns),
      prompt: redact(request.prompt, patterns),
    };
    this.log.info(
      `→ ${request.purpose} via ${provider.label}\n--- system ---\n${sent.system}\n--- prompt ---\n${sent.prompt}`
    );
    const text = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Planner AI: ${request.purpose}…`,
        cancellable: true,
      },
      (_progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        return provider.complete(sent, controller.signal);
      }
    );
    this.log.info(`← ${request.purpose}\n${text}`);
    return { reply: parseJsonReply(text), model: provider.label };
  }

  private updateContext(): Thenable<unknown> {
    return vscode.commands.executeCommand("setContext", "planner.aiEnabled", this.enabled);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
