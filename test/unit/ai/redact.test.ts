// planner.ai.redact: a pattern that is not a valid regular expression stops the request instead
// of being skipped, so the term it was meant to remove is never sent.
import { describe, expect, it } from "vitest";
import { AiError, redact } from "../../../src/ai/provider";

describe("redaction with an invalid pattern", () => {
  it("refuses to send, naming the pattern and the setting", () => {
    const run = () => redact("Portal for Acme Corp", ["/Acme(Corp/i"]);
    expect(run).toThrow(AiError);
    expect(run).toThrow(/planner\.ai\.redact/);
    expect(run).toThrow(/"\/Acme\(Corp\/i"/);
    expect(run).toThrow(/nothing was sent/i);
    expect(() => redact("x", ["acme", "/45\\d{8}/", "/([/"])).toThrow(AiError);
    expect(() => redact("x", ["/a/gg"])).toThrow(AiError);
  });

  it("still applies valid patterns as before", () => {
    expect(redact("Portal Acme Corp", ["/acme\\s+corp/i", "portal"])).toBe("[redacted] [redacted]");
    expect(redact("x", ["", "/x/"])).toBe("[redacted]");
  });
});
