// Project templates for create_project. The built-in templates are bundled into the server by
// scripts/build.mjs (the server may run from a copy outside the extension folder); a folder of
// custom templates can be read from disk, as with the planner.templatesFolder setting.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

declare const PLANNER_TEMPLATES: Record<string, Record<string, string>> | undefined;

export const TEMPLATE_DESCRIPTIONS: Record<string, string> = {
  empty: "Project settings and an empty team, inbox and punch list: add everything yourself",
  blank: "One milestone, no tasks; the lead in the team",
  software:
    "Discovery & design → backend and frontend → acceptance test → launch, with task skeletons and an acceptance test plan",
};

/** Every file below `dir` (dotfiles included) as { relative POSIX path: text }. */
export function readTemplateDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(dir, full).split(sep).join("/")] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

/** The built-in templates (bundled, else read from the repository's templates/ folder). */
export function builtInTemplates(): Record<string, Record<string, string>> {
  const bundled = typeof PLANNER_TEMPLATES === "undefined" ? undefined : PLANNER_TEMPLATES;
  let out: Record<string, Record<string, string>> = bundled ?? {};
  if (!bundled) {
    const dir = [join(__dirname, "..", "templates"), join(process.cwd(), "templates")].find((d) =>
      existsSync(d)
    );
    if (dir)
      for (const name of readdirSync(dir))
        if (statSync(join(dir, name)).isDirectory()) out[name] = readTemplateDir(join(dir, name));
  }
  if (out.blank) {
    // "empty": the blank template without its milestone and without a team member.
    const empty = Object.fromEntries(
      Object.entries(out.blank).filter(([path]) => !path.startsWith("milestones/"))
    );
    empty["team.md"] = "# Team\n";
    out = { empty, ...out };
  }
  return out;
}

/** Built-in templates plus the sub-folders of `customFolder`. */
export function availableTemplates(
  customFolder?: string
): Array<{ name: string; description: string; files: Record<string, string> }> {
  const all = Object.entries(builtInTemplates()).map(([name, files]) => ({
    name,
    description: TEMPLATE_DESCRIPTIONS[name] ?? "Built-in template",
    files,
  }));
  if (customFolder && existsSync(customFolder))
    for (const name of readdirSync(customFolder).sort()) {
      const dir = join(customFolder, name);
      if (statSync(dir).isDirectory())
        all.push({ name, description: `Custom template (${dir})`, files: readTemplateDir(dir) });
    }
  return all;
}
