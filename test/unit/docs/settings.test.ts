import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderSettingsDoc } from "../../../scripts/docs/settingsDoc";
import { ROOT } from "../helpers";

describe("settings documentation", () => {
  it("docs/settings.md matches package.json (run node scripts/docs/settings.mjs)", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(readFileSync(join(ROOT, "docs/settings.md"), "utf8")).toBe(renderSettingsDoc(manifest));
  });
});
