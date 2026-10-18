// Provider on the VS Code Language Model API (vscode.lm), e.g. GitHub Copilot's models.
import * as vscode from "vscode";
import { AiError, type AiProvider, type AiRequest } from "./provider";

export class VscodeLmProvider implements AiProvider {
  private chosen: string | undefined;

  constructor(private readonly family: string | undefined) {}

  get label(): string {
    return `VS Code language model${this.chosen ? ` (${this.chosen})` : this.family ? ` (${this.family})` : ""}`;
  }

  async complete(request: AiRequest, signal?: AbortSignal): Promise<string> {
    const models = await vscode.lm.selectChatModels(this.family ? { family: this.family } : {});
    const model = models[0];
    if (!model) {
      throw new AiError(
        this.family
          ? `No VS Code language model of family "${this.family}" is available (planner.ai.vscodeModel).`
          : 'No VS Code language model is available. Install a model provider such as GitHub Copilot, or set planner.ai.provider to "anthropic".'
      );
    }
    this.chosen = model.name;
    // The LM API has no system role: instructions, task and schema go into one user message.
    const message = vscode.LanguageModelChatMessage.User(
      `${request.system}\n\n${request.prompt}\n\nReply with exactly one JSON object that matches this JSON Schema. No prose, no code fences.\n${JSON.stringify(request.schema)}`
    );
    const source = new vscode.CancellationTokenSource();
    signal?.addEventListener("abort", () => source.cancel());
    try {
      const response = await model.sendRequest(
        [message],
        { justification: "Markdown Project Planner asks the model for a planning proposal." },
        source.token
      );
      let text = "";
      for await (const chunk of response.text) text += chunk;
      if (!text.trim()) throw new AiError("The language model returned no answer.");
      return text;
    } catch (err) {
      if (err instanceof AiError) throw err;
      if (err instanceof vscode.LanguageModelError) {
        throw new AiError(
          err.code === vscode.LanguageModelError.NoPermissions.name
            ? "Access to the language model was not granted."
            : err.code === vscode.LanguageModelError.Blocked.name
              ? "The language model request was blocked."
              : `Language model error: ${err.message}`
        );
      }
      throw new AiError(err instanceof Error ? err.message : String(err));
    } finally {
      source.dispose();
    }
  }
}
