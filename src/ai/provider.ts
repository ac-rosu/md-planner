// AI provider interface. Providers return raw text that must be one JSON object matching the
// request's schema; callers parse and validate it before anything becomes a proposal.

export type JsonSchema = { [key: string]: unknown };

export interface AiRequest {
  /** Short name for logs, e.g. "estimate". */
  purpose: string;
  system: string;
  prompt: string;
  schema: JsonSchema;
  maxTokens?: number;
}

export interface AiProvider {
  /** Human-readable provider/model name for logs and messages. */
  readonly label: string;
  complete(request: AiRequest, signal?: AbortSignal): Promise<string>;
}

/** An AI failure with a message meant for the user. */
export class AiError extends Error {}

/** Parses a JSON object from a reply (tolerates code fences and prose around it). */
export function parseJsonReply(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to extraction.
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fence ? fence[1] : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      // Reported below.
    }
  }
  throw new AiError("The AI reply was not valid JSON.");
}

/**
 * Removes configured terms (customer names …) before a prompt leaves the machine. Patterns are
 * literal, case-insensitive terms, or `/regex/flags`.
 */
export function redact(text: string, patterns: readonly string[]): string {
  let out = text;
  for (const p of patterns) {
    if (!p) continue;
    const m = /^\/(.+)\/([gimsuy]*)$/.exec(p);
    let re: RegExp;
    try {
      re = m
        ? new RegExp(m[1], m[2].includes("g") ? m[2] : m[2] + "g")
        : new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    } catch {
      continue;
    }
    out = out.replace(re, "[redacted]");
  }
  return out;
}
