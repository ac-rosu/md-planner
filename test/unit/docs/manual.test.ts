import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../helpers";

// The user manual ships in the extension package and opens in the Markdown preview
// (`Planner: Open user manual`), so its links must stay inside the files that are packaged.
const MANUAL = join(ROOT, "docs", "manual");
const pages = readdirSync(MANUAL).filter((f) => f.endsWith(".md"));
const withoutCode = (text: string) => text.replace(/```[\s\S]*?```/g, "");
const read = (page: string) => withoutCode(readFileSync(join(MANUAL, page), "utf8"));

/** GitHub-style heading anchor: lower case, punctuation removed, spaces as dashes. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\- ]/gu, "")
    .replace(/ /g, "-");
}

const anchors = new Map(
  pages.map((p) => [p, new Set([...read(p).matchAll(/^#+\s+(.*)$/gm)].map((m) => slug(m[1])))])
);

const links = pages.flatMap((page) =>
  [...read(page).matchAll(/\]\(([^)\s]+)\)/g)]
    .map((m) => m[1])
    .filter((target) => !/^[a-z]+:/i.test(target))
    .map((target) => ({ page, target }))
);

describe("user manual", () => {
  it("is packaged", () => {
    const ignore = readFileSync(join(ROOT, ".vscodeignore"), "utf8").split(/\r?\n/);
    expect(ignore).toContain("!docs/manual/**");
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const commands = manifest.contributes.commands.map((c: { command: string }) => c.command);
    expect(commands).toContain("planner.openManual");
    expect(pages).toContain("README.md");
  });

  it("links only to files that exist and are packaged", () => {
    expect(links.length).toBeGreaterThan(100);
    const broken = links.filter(({ page, target }) => {
      const path = target.split("#")[0];
      if (!path) return false;
      const file = normalize(join(MANUAL, dirname(page), decodeURIComponent(path)));
      const rel = relative(ROOT, file).replace(/\\/g, "/");
      const shipped = rel.startsWith("docs/manual/") || rel === "docs/settings.md";
      return !shipped || !existsSync(file);
    });
    expect(broken).toEqual([]);
  });

  it("links only to headings that exist", () => {
    const broken = links.filter(({ page, target }) => {
      const [path, anchor] = target.split("#");
      if (anchor === undefined) return false;
      const set = anchors.get(path || page);
      return set !== undefined && !set.has(anchor);
    });
    expect(broken).toEqual([]);
  });

  it("uses every screenshot", () => {
    const used = new Set(
      links.filter((l) => l.target.startsWith("images/")).map((l) => l.target.slice(7))
    );
    const images = readdirSync(join(MANUAL, "images"));
    expect(images.filter((f) => !used.has(f))).toEqual([]);
  });
});
