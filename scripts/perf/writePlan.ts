// Writes the generated 2,000-task plan (test/fixtures/largePlan.ts) to a folder.
//   node writePlan.cjs <plan folder>
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { largePlanFiles } from "../../test/fixtures/largePlan";

const [dir] = process.argv.slice(2);
for (const [path, text] of Object.entries(largePlanFiles())) {
  const file = join(dir, ...path.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
