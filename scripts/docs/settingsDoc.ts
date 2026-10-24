// Renders docs/settings.md from the `contributes.configuration` of package.json, so the settings
// reference never drifts from the manifest (a unit test compares the two).
//   node scripts/docs/settings.mjs   (re-generates docs/settings.md)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Setting {
  type?: string | string[];
  default?: unknown;
  description?: string;
  markdownDescription?: string;
  enum?: unknown[];
  enumDescriptions?: string[];
  markdownEnumDescriptions?: string[];
  minimum?: number;
  maximum?: number;
}

interface Manifest {
  displayName: string;
  contributes: { configuration: { properties: Record<string, Setting> } };
}

const GROUPS: Array<[string, (key: string) => boolean]> = [
  [
    "General",
    (k) =>
      /^planner\.(planFolder|me|autoSave|autoAssignIds\w*|confirmEarlyStart|parentStatus|templatesFolder)$/.test(
        k
      ),
  ],
  ["Editor", (k) => /^planner\.(editor|codeLens)\./.test(k)],
  ["Scheduling and diagnostics", (k) => /^planner\.(scheduling|diagnostics)\./.test(k)],
  ["Kanban", (k) => k.startsWith("planner.kanban.")],
  ["Time tracking", (k) => k.startsWith("planner.time.")],
  ["TODOs in code", (k) => k.startsWith("planner.todos.")],
  ["Export", (k) => k.startsWith("planner.export.")],
  ["AI", (k) => k.startsWith("planner.ai.")],
  ["MCP server", (k) => k.startsWith("planner.mcp.")],
];

function value(v: unknown): string {
  return `\`${JSON.stringify(v)}\``;
}

export function renderSettingsDoc(manifest: Manifest): string {
  const props = manifest.contributes.configuration.properties;
  const keys = Object.keys(props);
  const lines = [
    "# Settings",
    "",
    `All settings of ${manifest.displayName} are under \`planner.*\` (Settings → Extensions →`,
    `${manifest.displayName}). Workspace settings (\`.vscode/settings.json\`) are the usual place,`,
    "so the whole team shares them.",
    "",
    "<!-- Generated from package.json by `node scripts/docs/settings.mjs`. Do not edit. -->",
  ];
  const seen = new Set<string>();
  for (const [title, test] of GROUPS) {
    const group = keys.filter((k) => test(k) && !seen.has(k));
    if (group.length === 0) continue;
    lines.push("", `## ${title}`);
    for (const key of group) {
      seen.add(key);
      const s = props[key];
      const type = Array.isArray(s.type) ? s.type.join(" | ") : (s.type ?? "any");
      lines.push("", `### \`${key}\``, "", (s.markdownDescription ?? s.description ?? "").trim());
      const facts = [`Type: ${type}`, `default: ${value(s.default)}`];
      if (s.minimum !== undefined) facts.push(`minimum: ${s.minimum}`);
      if (s.maximum !== undefined) facts.push(`maximum: ${s.maximum}`);
      lines.push("", `${facts.join(" · ")}`);
      if (s.enum) {
        const notes = s.markdownEnumDescriptions ?? s.enumDescriptions ?? [];
        lines.push("", ...s.enum.map((e, i) => `- ${value(e)}${notes[i] ? `: ${notes[i]}` : ""}`));
      }
    }
  }
  const rest = keys.filter((k) => !seen.has(k));
  if (rest.length) throw new Error(`settings without a documentation group: ${rest.join(", ")}`);
  return lines.join("\n") + "\n";
}

if (require.main === module) {
  const root = process.argv[2];
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Manifest;
  writeFileSync(join(root, "docs", "settings.md"), renderSettingsDoc(manifest));
  console.log("docs/settings.md written");
}
