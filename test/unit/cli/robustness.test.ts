// The CLI with careless input: wrong paths, broken baselines, bad option values. Every mistake is
// one clear line on stderr with exit code 2, never a stack trace; valid calls work as before.
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main, parseArgs } from "../../../src/cli/index";
import { SAMPLE_PLAN, TODAY } from "../helpers";

async function run(...argv: string[]) {
  let out = "";
  let err = "";
  const code = await main(argv, { out: (t) => (out += t), err: (t) => (err += t) });
  return { code, out, err };
}

/** Exit code 2 with exactly one line on stderr matching `message`, nothing on stdout. */
async function usageError(argv: string[], message: RegExp) {
  const r = await run(...argv);
  expect(r.code, argv.join(" ")).toBe(2);
  expect(r.err.trimEnd().split("\n"), argv.join(" ")).toHaveLength(1);
  expect(r.err.trimEnd(), argv.join(" ")).toMatch(message);
  expect(r.err).not.toMatch(/\n\s+at /);
  expect(r.out).toBe("");
}

const temp = () => mkdtempSync(join(tmpdir(), "planner-cli-robust-"));

/** A copy of the sample plan that the test may change. */
function samplePlanCopy(): string {
  const dir = join(temp(), "plan");
  cpSync(SAMPLE_PLAN, dir, { recursive: true });
  return dir;
}

describe("cli: plan folder", () => {
  it("rejects a file, a missing folder and a folder without project.md", async () => {
    const dir = temp();
    const file = join(dir, "notes.txt");
    writeFileSync(file, "x");
    await usageError(["validate", "--plan", file], /^Not a folder: .*notes\.txt/);
    await usageError(["validate", "--plan", join(file, "plan")], /^Plan folder not found: /);
    await usageError(
      ["validate", "--plan", join(dir, "nope"), "--strict"],
      /^Plan folder not found/
    );
    // An existing folder without plan files: before, "0 files, 0 tasks: 0 error(s)" and exit 0.
    mkdirSync(join(dir, "empty"));
    await usageError(
      ["validate", "--plan", join(dir, "empty"), "--strict"],
      /^No plan in .*empty \(no project\.md\)\.$/
    );
    // Milestones without project.md (the one required file) are not a plan either.
    mkdirSync(join(dir, "partial", "milestones"), { recursive: true });
    writeFileSync(join(dir, "partial", "milestones", "M1.md"), "# M1\n\n- [ ] A ^T1\n");
    await usageError(
      ["schedule", "--plan", join(dir, "partial")],
      /^No plan in .*partial \(no project\.md\)\.$/
    );
    await usageError(
      ["export", "--plan", join(dir, "partial"), "--format", "csv"],
      /^No plan in .*partial/
    );
  });
});

describe("cli: output folder", () => {
  it("reports an --out that is a file or cannot be created in one line", async () => {
    const dir = temp();
    const file = join(dir, "taken");
    writeFileSync(file, "x");
    await usageError(
      ["export", "--plan", SAMPLE_PLAN, "--today", TODAY, "--format", "csv", "--out", file],
      /^Not a folder: .*taken \(--out expects the output folder\)\.$/
    );
    await usageError(
      ["export", "--plan", SAMPLE_PLAN, "--format", "csv", "--out", join(file, "sub")],
      /^Cannot create the output folder .*taken[/\\]sub: a part of the path is a file/
    );
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports an --out without write permission in one line",
    async () => {
      const dir = temp();
      const locked = join(dir, "locked");
      mkdirSync(locked);
      chmodSync(locked, 0o555);
      try {
        await usageError(
          ["export", "--plan", SAMPLE_PLAN, "--format", "csv", "--out", join(locked, "sub")],
          /^Cannot create the output folder .*: permission denied\.$/
        );
        await usageError(
          ["export", "--plan", SAMPLE_PLAN, "--today", TODAY, "--format", "csv", "--out", locked],
          /^Cannot write .*2026-10-14-tasks\.csv: permission denied\.$/
        );
      } finally {
        chmodSync(locked, 0o755);
      }
    }
  );

  it("keeps file names inside the output folder whatever a test plan id contains", async () => {
    const plan = samplePlanCopy();
    writeFileSync(
      join(plan, "tests", "evil.md"),
      "# Evil\n\nid: ../../../../escaped\n\n## TC-01 Step\n\n- [ ] Do it\n"
    );
    const out = join(temp(), "a", "b", "out");
    const r = await run(
      ...["export", "--plan", plan, "--today", TODAY, "--format", "test-report"],
      ...["--test", "../../../../escaped", "--out", out]
    );
    expect(r.code).toBe(0);
    expect(readdirSync(out)).toEqual(["2026-10-14-.-.-.-.-escaped-report.html"]);
    expect(readdirSync(join(out, "..", ".."))).toEqual(["b"]);
  });
});

describe("cli: baselines", () => {
  const broken = () => {
    const plan = samplePlanCopy();
    writeFileSync(join(plan, "baselines", "2026-10-20-broken.json"), "{ not json");
    writeFileSync(
      join(plan, "baselines", "2026-10-21-numbers.json"),
      JSON.stringify({
        name: "n",
        date: "2026-10-21",
        tasks: {},
        milestones: { M1: { forecast: 1 } },
      })
    );
    writeFileSync(join(plan, "baselines", "2026-10-22-other.json"), '{"some":"config"}');
    return plan;
  };

  it("skips invalid baseline files with a one-line warning each", async () => {
    const plan = broken();
    const out = temp();
    const r = await run(
      ...["export", "--plan", plan, "--today", TODAY, "--format", "csv,html", "--out", out]
    );
    expect(r.code).toBe(0);
    expect(r.err.trimEnd().split("\n")).toEqual([
      "warning: baselines/2026-10-20-broken.json is not valid JSON; skipped.",
      "warning: baselines/2026-10-21-numbers.json is not a planner baseline (milestone M1: forecast must be text); skipped.",
      "warning: baselines/2026-10-22-other.json is not a planner baseline; skipped.",
    ]);
    expect(readdirSync(out).sort()).toEqual([
      "2026-10-14-status-report.html",
      "2026-10-14-tasks.csv",
    ]);
    // The latest valid baseline (the kickoff) still gives the milestone trend.
    const named = await run(
      ...["export", "--plan", plan, "--today", TODAY, "--format", "html", "--out", out],
      ...["--baseline", "2026-10-07-kickoff"]
    );
    expect(named.code).toBe(0);
  });

  it("refuses to use an invalid baseline that is asked for by name", async () => {
    const plan = broken();
    const r = await run(
      ...["export", "--plan", plan, "--today", TODAY, "--format", "html", "--out", temp()],
      ...["--baseline", "2026-10-21-numbers"]
    );
    expect(r.code).toBe(2);
    expect(r.err.trimEnd().split("\n").at(-1)).toBe(
      "Cannot use baseline 2026-10-21-numbers: baselines/2026-10-21-numbers.json is not a planner baseline (milestone M1: forecast must be text)."
    );
    const unknown = await run(
      ...["export", "--plan", plan, "--format", "html", "--out", temp(), "--baseline", "nope"]
    );
    expect(unknown.code).toBe(2);
    expect(unknown.err.trimEnd().split("\n").at(-1)).toBe(
      "Unknown baseline nope (2026-10-07-kickoff)."
    );
  });
});

describe("cli: option values", () => {
  const exp = ["export", "--plan", SAMPLE_PLAN, "--today", TODAY, "--format", "html"];

  it("rejects numbers that are not numbers, negative or zero", async () => {
    await usageError([...exp, "--weeks", "abc"], /^Invalid --weeks abc \(expected a whole number/);
    await usageError([...exp, "--weeks", "0"], /^Invalid --weeks 0/);
    await usageError([...exp, "--weeks", "2.5"], /^Invalid --weeks 2\.5/);
    await usageError([...exp, "--period", "-5"], /^Invalid --period -5 \(expected a whole number/);
    await usageError([...exp, "--period", "1e3"], /^Invalid --period 1e3/);
    for (const v of ["abc", "-40", ""])
      await usageError(
        ["validate", "--plan", SAMPLE_PLAN, "--unassigned-capacity", v],
        v
          ? /^Invalid --unassigned-capacity .* \(expected hours per week, 0 or more\)\.$/
          : /needs a value/
      );
  });

  it("rejects options without their value, unknown values and unknown options", async () => {
    const plan = ["--plan", SAMPLE_PLAN];
    await usageError(["validate", ...plan, "--today"], /^Option --today needs a value\.$/);
    await usageError(
      ["validate", "--today", "--plan", SAMPLE_PLAN],
      /^Option --today needs a value/
    );
    await usageError(["validate", "--plan"], /^Option --plan needs a value\.$/);
    await usageError(["validate", "--plan="], /^Option --plan needs a value\.$/);
    await usageError(
      ["schedule", ...plan, "--mode", "bogus"],
      /^Invalid --mode bogus \(expected capacity or demand\)\.$/
    );
    await usageError(
      ["validate", ...plan, "--stict"],
      /^Unknown option --stict \(see: planner help\)\.$/
    );
    await usageError(
      [...exp, "--fromat", "csv"],
      /^Unknown option --fromat \(see: planner help export\)\.$/
    );
    await usageError(["validate", "plan"], /^Unexpected argument "plan" \(options start with --/);
    await usageError([...exp, "--delimiter", ""], /^Option --delimiter needs a value\.$/);
    await usageError(
      [...exp, "--delimiter", "||"],
      /^Invalid --delimiter \|\| \(expected one character/
    );
    await usageError(
      [...exp, "--accent", "red"],
      /^Invalid --accent red \(expected a colour like #0f766e\)\.$/
    );
    await usageError([...exp, "--logo", temp()], /^Cannot read the logo .*: it is a folder\.$/);
    const bmp = join(temp(), "logo.bmp");
    writeFileSync(bmp, "BM");
    await usageError(
      [...exp, "--logo", bmp],
      /^Unsupported logo .*logo\.bmp \(PNG, JPEG, GIF, SVG or WebP\)\.$/
    );
    await usageError([...exp, "--logo", join(temp(), "missing.png")], /^Logo file not found: /);
  });

  it("keeps every valid call working", async () => {
    const plan = ["--plan", SAMPLE_PLAN, "--today", TODAY];
    for (const argv of [
      ["validate", ...plan, "--unassigned-capacity", "0"],
      ["validate", ...plan, "--unassigned-capacity", "37.5"],
      ["validate", ...plan, "--unassigned-capacity=40", "--json"],
      ["schedule", ...plan, "--mode", "demand", "--json"],
      ["schedule", ...plan, "--mode=capacity"],
      ["--json", "validate", ...plan],
    ]) {
      const r = await run(...argv);
      expect(r.code, argv.join(" ")).toBe(0);
      expect(r.err, argv.join(" ")).toBe("");
    }
    // A switch does not swallow the next argument: `--json validate` runs validate as JSON.
    expect(JSON.parse((await run("--json", "validate", ...plan)).out)).toMatchObject({ errors: 0 });
    expect((await run("--help", "export")).out).toMatch(/^Usage: planner export/);
    expect((await run("help", "export")).out).toMatch(/^Usage: planner export/);
    expect(parseArgs(["--strict", "validate"]).command).toBe("validate");

    const out = temp();
    const r = await run(
      ...["export", ...plan, "--format", "csv,html", "--out", out, "--period", "14"],
      ...["--weeks", "8", "--delimiter", ";", "--accent", "#0f766e", "--summary", ""],
      ...["--sections", "header,summary,milestones", "--baseline", "2026-10-07-kickoff"]
    );
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(readdirSync(out).sort()).toEqual([
      "2026-10-14-status-report.html",
      "2026-10-14-tasks.csv",
    ]);
    expect(existsSync(join(out, "2026-10-14-tasks.csv"))).toBe(true);
  });
});
