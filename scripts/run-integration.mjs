// Runs the integration tests inside a real VS Code instance (@vscode/test-electron).
// The sample project is copied to a temporary workspace so tests can edit files freely.
import { runTests } from "@vscode/test-electron";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const vscodeVersion = process.env.VSCODE_TEST_VERSION ?? "stable";
// Optional Mocha filter: `npm run test:integration -- --grep "Gantt"`.
const grepAt = process.argv.indexOf("--grep");
const grep = grepAt > 0 ? (process.argv[grepAt + 1] ?? "") : "";

// When this script runs inside a VS Code terminal, these variables would make the test instance
// start as plain Node or attach to the host window.
for (const key of Object.keys(process.env)) {
  if (key === "ELECTRON_RUN_AS_NODE" || key.startsWith("VSCODE_")) delete process.env[key];
}
const workspace = mkdtempSync(join(tmpdir(), "md-planner-it-"));
cpSync(join(root, "examples/customer-portal"), workspace, { recursive: true });
// A fresh profile per run: no state from earlier runs, and no walkthrough or welcome page taking
// the focus from the editors the tests drive.
const userData = mkdtempSync(join(tmpdir(), "md-planner-it-user-"));
mkdirSync(join(userData, "User"), { recursive: true });
writeFileSync(
  join(userData, "User", "settings.json"),
  JSON.stringify({
    "workbench.startupEditor": "none",
    "workbench.welcomePage.walkthroughs.openOnInstall": false,
    // In the sample, M1 is still open while M2 is under way: the question before starting M2 work
    // is a modal dialog that tests cannot answer. The test that covers it turns it back on.
    "planner.confirmEarlyStart": false,
  })
);

let exitCode = 0;
try {
  await runTests({
    version: vscodeVersion,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, "out/test/integration/index.js"),
    launchArgs: [
      workspace,
      `--user-data-dir=${userData}`,
      "--disable-extensions",
      "--disable-workspace-trust",
      "--skip-welcome",
    ],
    extensionTestsEnv: { MD_PLANNER_TEST_WORKSPACE: workspace, MD_PLANNER_TEST_GREP: grep },
  });
} catch (err) {
  console.error("Integration tests failed:", err instanceof Error ? err.message : err);
  exitCode = 1;
} finally {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
}
process.exit(exitCode);
