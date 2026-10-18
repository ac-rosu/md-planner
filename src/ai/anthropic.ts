// Direct Claude API provider (@anthropic-ai/sdk). Structured output through
// `output_config.format` (JSON schema); refusals and truncation are reported, never parsed.
import Anthropic from "@anthropic-ai/sdk";
import { AiError, type AiProvider, type AiRequest } from "./provider";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set([
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
]);

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
  /** Injected client (tests); a real client is created otherwise. */
  client?: Pick<Anthropic, "beta">;
  timeoutMs?: number;
}

export class AnthropicProvider implements AiProvider {
  private readonly model: string;
  private client: Pick<Anthropic, "beta"> | undefined;

  constructor(private readonly options: AnthropicProviderOptions) {
    this.model = options.model || DEFAULT_ANTHROPIC_MODEL;
    this.client = options.client;
  }

  get label(): string {
    return `Claude API (${this.model})`;
  }

  async complete(request: AiRequest, signal?: AbortSignal): Promise<string> {
    const client = (this.client ??= new Anthropic({
      apiKey: this.options.apiKey,
      timeout: this.options.timeoutMs ?? 300_000,
      maxRetries: 2,
    }));
    const fallback = FALLBACK_MODELS.has(this.model);
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await client.beta.messages.create(
        {
          model: this.model,
          max_tokens: request.maxTokens ?? 16000,
          system: request.system,
          messages: [{ role: "user", content: request.prompt }],
          output_config: { format: { type: "json_schema", schema: request.schema } },
          ...(fallback
            ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
            : {}),
        },
        { signal }
      );
    } catch (err) {
      throw toAiError(err);
    }
    if (response.stop_reason === "refusal") {
      const category = response.stop_details?.category;
      throw new AiError(
        `The model declined this request${category ? ` (${category})` : ""}. Nothing was changed.`
      );
    }
    if (response.stop_reason === "max_tokens") {
      throw new AiError("The AI reply was cut off (too long). Try a smaller selection.");
    }
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (!text.trim()) throw new AiError("The AI returned no answer.");
    return text;
  }
}

function toAiError(err: unknown): AiError {
  if (err instanceof Anthropic.AuthenticationError)
    return new AiError('The Claude API key was rejected. Run "Planner: Set API key".');
  if (err instanceof Anthropic.PermissionDeniedError)
    return new AiError("The Claude API key has no access to this model (planner.ai.model).");
  if (err instanceof Anthropic.NotFoundError)
    return new AiError("Unknown Claude model (planner.ai.model).");
  if (err instanceof Anthropic.RateLimitError)
    return new AiError("The Claude API is rate-limiting requests; try again in a moment.");
  if (err instanceof Anthropic.BadRequestError)
    return new AiError(`The Claude API rejected the request: ${err.message}`);
  if (err instanceof Anthropic.APIUserAbortError) return new AiError("Cancelled.");
  if (err instanceof Anthropic.APIConnectionTimeoutError)
    return new AiError("The Claude API did not answer in time.");
  if (err instanceof Anthropic.APIConnectionError)
    return new AiError("Could not reach the Claude API (network).");
  if (err instanceof Anthropic.APIError)
    return new AiError(`Claude API error ${err.status ?? ""}: ${err.message}`);
  return new AiError(err instanceof Error ? err.message : String(err));
}
