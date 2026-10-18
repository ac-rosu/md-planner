// Mocha entry point loaded by @vscode/test-electron inside the VS Code test instance.
import Mocha from "mocha";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function findTests(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...findTests(path));
    else if (name.endsWith(".test.js")) files.push(path);
  }
  return files;
}

export function run(): Promise<void> {
  const grep = process.env.MD_PLANNER_TEST_GREP;
  const mocha = new Mocha({ ui: "bdd", color: true, timeout: 60_000, ...(grep ? { grep } : {}) });
  for (const file of findTests(__dirname)) mocha.addFile(file);
  return new Promise((resolve, reject) => {
    mocha.run((failures) =>
      failures > 0 ? reject(new Error(`${failures} integration test(s) failed`)) : resolve()
    );
  });
}
