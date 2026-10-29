// What careless users and tools do to plan files: merge conflicts, unreadable files, other
// encodings, wrong-case and hidden names. The plan still loads, says what is wrong, and the
// planner does not make it worse. Well-formed plans are not affected.
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../../src/cli/index";
import {
  applyFileEdits,
  decodeUtf8,
  editRefusal,
  listPlanFiles,
  loadPlanIndex,
  scanPlanFolder,
} from "../../../src/core/fsLoader";
import { PlanIndex } from "../../../src/core/index";
import { classifyPlanPath, describeReadError } from "../../../src/core/parser/files";
import { conflictMarkerLines } from "../../../src/core/parser/scan";
import { TextLines } from "../../../src/core/text";
import { setAttr } from "../../../src/core/writer";
import { addPerson, captureInbox } from "../../../src/core/writer/entities";
import { FIXTURES, indexFrom, md, SAMPLE_PLAN, TODAY } from "../helpers";

const PROJECT = md("# P", "", "start: 2026-10-01");

/** A plan folder in a temporary directory with the given files (text, or bytes). */
function folder(files: Record<string, string | Uint8Array>): string {
  const dir = join(mkdtempSync(join(tmpdir(), "planner-robust-")), "plan");
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

/** Symbolic links need a privilege on Windows: those tests are skipped there. */
function trySymlink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path);
    return true;
  } catch {
    return false;
  }
}

/** Latin-1 bytes of a text (every character below U+0100). */
function latin1(text: string): Uint8Array {
  return Uint8Array.from([...text].map((c) => c.charCodeAt(0)));
}

const CONFLICTED = md(
  "# M1 – Build",
  "",
  "id: M1",
  "",
  "- [ ] Shared task @est:1h ^T1",
  "<<<<<<< HEAD",
  "- [ ] Ours @est:2h ^T2",
  "=======",
  "- [ ] Theirs @est:3h ^T3",
  ">>>>>>> feature",
  "- [ ] Last @est:1h ^T4"
);

describe("git merge conflict markers", () => {
  it("are errors on each marker line, in every kind of plan file", () => {
    const index = indexFrom({
      "project.md": PROJECT,
      "milestones/M1.md": CONFLICTED,
      "team.md": md(
        "# Team",
        "",
        "<<<<<<< ours",
        "## Alex",
        "|||||||",
        "=======",
        "## Sam",
        ">>>>>>> theirs"
      ),
    });
    const conflicts = index.plan.issues.filter((i) => i.code === "merge-conflict");
    expect(conflicts.map((i) => `${i.file}:${i.range.start.line}`)).toEqual([
      "milestones/M1.md:5",
      "milestones/M1.md:7",
      "milestones/M1.md:9",
      "team.md:2",
      "team.md:4",
      "team.md:5",
      "team.md:7",
    ]);
    expect(conflicts.every((i) => i.severity === "error")).toBe(true);
    expect(conflicts[0].range).toEqual({
      start: { line: 5, character: 0 },
      end: { line: 5, character: "<<<<<<< HEAD".length },
    });
    expect(index.conflictLines("milestones/M1.md")).toEqual([5, 7, 9]);
    // The file is read as before: both sides' tasks are there (and reported), nothing is lost.
    expect(index.plan.tasks.map((t) => t.id)).toEqual(["T1", "T2", "T3", "T4"]);
    expect(index.get("milestones/M1.md")!.lines.serialize()).toBe(CONFLICTED);
  });

  it("are not a setext underline or a table row in a file without conflict", () => {
    const text = md("# M1", "", "Notes", "=======", "", "|||||||", "  <<<<<<< not at the start");
    expect(conflictMarkerLines(TextLines.parse(text))).toEqual([]);
    expect(conflictMarkerLines(TextLines.parse(md("<<<<<<<< eight", ">>>>>>>>")))).toEqual([]);
    // One leftover marker is enough.
    expect(conflictMarkerLines(TextLines.parse(md("- [ ] a", ">>>>>>> feature")))).toEqual([1]);
    expect(conflictMarkerLines(TextLines.parse("x\r\n<<<<<<< HEAD\r\n=======\r\n"))).toEqual([
      1, 2,
    ]);
    const plan = indexFrom({ "milestones/M1.md": text }).plan;
    expect(plan.issues.filter((i) => i.code === "merge-conflict")).toEqual([]);
  });

  it("make the file refuse edits on disk", () => {
    const dir = folder({ "project.md": PROJECT, "milestones/M1.md": CONFLICTED });
    const index = loadPlanIndex(dir);
    const t = index.plan.taskById("T1")!;
    expect(() =>
      applyFileEdits(dir, index, t.file, setAttr(index.get(t.file)!.lines, t, "owner", "alex"))
    ).toThrow(
      "milestones/M1.md has git merge conflict markers (lines 6, 8, 10). Resolve the conflict first"
    );
    expect(readFileSync(join(dir, "milestones/M1.md"), "utf8")).toBe(CONFLICTED);
    expect(editRefusal("x.md", md("# x", "", "- [ ] a"), true)).toBeUndefined();
  });
});

describe("files that cannot be read", () => {
  const isRoot = process.getuid?.() === 0;

  it.skipIf(isRoot || process.platform === "win32")(
    "are left out with a warning instead of stopping the load",
    () => {
      const dir = folder({
        "project.md": PROJECT,
        "milestones/M1.md": md("# M1", "", "- [ ] a @est:1h ^T1"),
        "milestones/M2.md": md("# M2", "", "- [ ] b @est:1h ^T2"),
        "tests/private/UAT-9.md": md("# UAT-9"),
      });
      chmodSync(join(dir, "milestones/M2.md"), 0o000);
      chmodSync(join(dir, "tests/private"), 0o000);
      try {
        const index = loadPlanIndex(dir);
        expect(index.paths).toEqual(["milestones/M1.md", "project.md"]);
        expect(index.plan.tasks.map((t) => t.id)).toEqual(["T1"]);
        const warnings = index.plan.issues.filter((i) => i.code === "unreadable-file");
        expect(warnings.map((i) => [i.file, i.severity, i.range.start.line])).toEqual([
          ["milestones/M2.md", "warning", 0],
          ["tests/private", "warning", 0],
        ]);
        expect(warnings[0].message).toBe(
          "Could not read this file (permission denied (EACCES)); it is left out of the plan."
        );
        expect(warnings[1].message).toMatch(/^Could not read this folder \(permission denied/);
      } finally {
        chmodSync(join(dir, "milestones/M2.md"), 0o644);
        chmodSync(join(dir, "tests/private"), 0o755);
      }
    }
  );

  it("skip broken symbolic links and do not follow folder links in circles", (ctx) => {
    const dir = folder({
      "project.md": PROJECT,
      "milestones/M1.md": md("# M1", "", "- [ ] a @est:1h ^T1"),
    });
    if (
      !trySymlink(join(dir, "milestones/gone.md"), join(dir, "milestones/M9-broken.md")) ||
      !trySymlink(dir, join(dir, "milestones/loop")) ||
      !trySymlink("M8-self.md", join(dir, "milestones/M8-self.md"))
    )
      return ctx.skip();
    const scan = scanPlanFolder(dir);
    expect(scan.files).toEqual(["milestones/M1.md", "project.md"]);
    // A link to itself is not missing: it cannot be read.
    expect(scan.unreadable.map((u) => u.path)).toEqual(["milestones/M8-self.md"]);
    const index = loadPlanIndex(dir);
    expect(index.plan.tasks.map((t) => t.id)).toEqual(["T1"]);
    expect(index.plan.issues.map((i) => i.code)).toContain("unreadable-file");
    expect(listPlanFiles(dir)).toEqual(scan.files);
  });

  it("describe their error briefly", () => {
    expect(
      describeReadError(
        Object.assign(new Error("EACCES: permission denied, open '/p/x.md'"), { code: "EACCES" })
      )
    ).toBe("permission denied (EACCES)");
    expect(
      describeReadError({
        code: "NoPermissions",
        message:
          "Unable to read file '/p/x.md' (NoPermissions (FileSystemError): Error: EACCES: permission denied, open '/p/x.md')",
      })
    ).toBe("permission denied (EACCES)");
    expect(describeReadError({ code: "Unavailable", message: "Unavailable" })).toBe(
      "the file is not available"
    );
    expect(describeReadError("odd")).toBe("odd");
  });
});

describe("files that are not UTF-8", () => {
  const text = md("# M1 – Café", "", "- [ ] Über die Brücke @est:1h ^T1");

  it("are read for display, marked not-utf8, and not edited", () => {
    const dir = folder({ "project.md": PROJECT, "milestones/M1.md": latin1(text) });
    const index = loadPlanIndex(dir);
    expect(index.notUtf8("milestones/M1.md")).toBe(true);
    expect(index.plan.taskById("T1")?.title).toBe("�ber die Br�cke");
    const issue = index.plan.issues.find((i) => i.code === "not-utf8")!;
    expect(issue).toMatchObject({ file: "milestones/M1.md", severity: "error" });
    expect(issue.message).toContain(
      "Save it as UTF-8: Reopen with Encoding → Latin-1 (or the file's encoding), then Save with Encoding → UTF-8."
    );
    const t = index.plan.taskById("T1")!;
    expect(() =>
      applyFileEdits(dir, index, t.file, setAttr(index.get(t.file)!.lines, t, "owner", "alex"))
    ).toThrow("milestones/M1.md is not UTF-8");
    expect(readFileSync(join(dir, "milestones/M1.md"))).toEqual(Buffer.from(latin1(text)));
  });

  it("keeps the mark until the file is read as UTF-8 again", () => {
    const index = new PlanIndex();
    index.update("milestones/M1.md", text, { utf8: false });
    const v = index.version;
    // An editor buffer does not say: the mark stays.
    expect(index.update("milestones/M1.md", text + "x\n")).toBe(true);
    expect(index.notUtf8("milestones/M1.md")).toBe(true);
    expect(index.plan.issues.map((i) => i.code)).toEqual(["not-utf8"]);
    // The same text, now UTF-8 on disk: a new parse without the error.
    expect(index.update("milestones/M1.md", text + "x\n", { utf8: true })).toBe(true);
    expect(index.version).toBeGreaterThan(v);
    expect(index.plan.issues).toEqual([]);
    expect(index.update("milestones/M1.md", text + "x\n", { utf8: true })).toBe(false);
    index.update("milestones/M1.md", text, { utf8: false });
    index.remove("milestones/M1.md");
    expect(index.notUtf8("milestones/M1.md")).toBe(false);
  });

  it("leaves UTF-8 with a BOM, plain ASCII and every round-trip fixture byte-identical", () => {
    const fixtures = [
      "bom.md",
      "crlf-no-final-newline.md",
      "mixed-eol.md",
      "odd-spacing.md",
      "unicode.md",
    ];
    const files: Record<string, Uint8Array> = { "project.md": Buffer.from(PROJECT, "ascii") };
    for (const f of fixtures)
      files[`milestones/${f}`] = readFileSync(join(FIXTURES, "roundtrip", f));
    const dir = folder(files);
    const index = loadPlanIndex(dir);
    for (const [rel, bytes] of Object.entries(files)) {
      expect(index.notUtf8(rel)).toBe(false);
      expect(Buffer.from(index.get(rel)!.lines.serialize(), "utf8")).toEqual(Buffer.from(bytes));
    }
    expect(index.get("milestones/bom.md")!.lines.bom).toBe(true);
    expect(decodeUtf8(Buffer.from("﻿é", "utf8"))).toEqual({ text: "﻿é", utf8: true });
    expect(decodeUtf8(Uint8Array.from([0x63, 0xe9]))).toEqual({ text: "c�", utf8: false });
  });
});

describe("plan file names", () => {
  it("are classified ignoring case, keeping the path as it is", () => {
    expect(classifyPlanPath("Project.md")).toBe("project");
    expect(classifyPlanPath("TEAM.MD")).toBe("team");
    expect(classifyPlanPath("Inbox.md")).toBe("inbox");
    expect(classifyPlanPath("PunchList.md")).toBe("punch");
    expect(classifyPlanPath("Milestones/M1.md")).toBe("milestone");
    expect(classifyPlanPath("Tests/UAT-1.md")).toBe("test");
    expect(classifyPlanPath("Reports/x.md")).toBeUndefined();
    // Left alone: a README in milestones/ is a milestone file, as before.
    expect(classifyPlanPath("milestones/README.md")).toBe("milestone");
  });

  it("skip hidden files and folders", () => {
    for (const p of [
      "milestones/._M1.md",
      "milestones/.trash/x.md",
      "milestones/.#M1.md",
      ".planner/x.md",
      ".project.md",
      "tests/.cache/UAT.md",
    ])
      expect(classifyPlanPath(p), p).toBeUndefined();
    const index = new PlanIndex();
    expect(index.update("milestones/._M1.md", "\u0000\u0005binary")).toBe(false);
    expect(index.plan.milestones).toEqual([]);
  });

  it("are read in any case, and writers use the files as they are named", () => {
    const index = indexFrom({
      "Project.md": md("# Wrong case", "", "hoursPerDay: 6"),
      "Team.md": md("# Team", "", "## Alex", "", "id: alex"),
      "Milestones/M1-a.md": md("# M1 – A", "", "id: M1", "", "- [ ] a @est:1d ^T1"),
      "Inbox.md": md("# Inbox", "", "- [ ] idea"),
    });
    const plan = index.plan;
    expect(plan.project.hoursPerDay).toBe(6);
    expect(plan.project.file).toBe("Project.md");
    expect(plan.taskById("T1")?.est).toBe(6);
    expect(plan.file("team.md")?.path).toBe("Team.md");
    expect(plan.file("Team.md")?.path).toBe("Team.md");
    expect(plan.file("milestones/m1-a.md")?.path).toBe("Milestones/M1-a.md");
    expect(addPerson(plan, { name: "Sam" })).toMatchObject({ edits: [{ path: "Team.md" }] });
    expect(captureInbox(plan, "x")).toMatchObject({ edits: [{ path: "Inbox.md" }] });
    expect(index.canonicalPath("milestones/M2-b.md")).toBe("Milestones/M2-b.md");
    expect(index.canonicalPath("milestones/sub/M3.md")).toBe("Milestones/sub/M3.md");
    expect(index.canonicalPath("team.md")).toBe("Team.md");
    expect(index.canonicalPath("tests/UAT-1.md")).toBe("tests/UAT-1.md");
    expect(index.canonicalPath("../src/x.ts")).toBe("../src/x.ts");
  });

  it("change nothing for a plan with the usual names", () => {
    const index = indexFrom({
      "project.md": PROJECT,
      "team.md": md("# Team"),
      "milestones/M1.md": md("# M1"),
    });
    for (const p of [
      "project.md",
      "team.md",
      "milestones/M1.md",
      "milestones/M2-new.md",
      "inbox.md",
    ])
      expect(index.canonicalPath(p)).toBe(p);
    expect(index.plan.file("inbox.md")).toBeUndefined();
  });

  it("make `planner validate --strict` see a plan with wrong-case names", async () => {
    const dir = folder({
      "Project.md": PROJECT,
      "Milestones/M1.md": md("# M1", "", "id: M1", "", "- [ ] a ^T1"),
    });
    let out = "";
    const code = await main(["validate", "--plan", dir, "--today", TODAY], {
      out: (t) => (out += t),
      err: () => undefined,
    });
    expect(out).toMatch(/2 files, 1 tasks/);
    expect(code).toBe(0);
  });
});

describe("folders", () => {
  it("lists every path at or below a folder, for a folder deleted at once", () => {
    const index = indexFrom({
      "project.md": PROJECT,
      "milestones/M1.md": md("# M1"),
      "milestones/sub/M2.md": md("# M2"),
      "milestones-old/M3.md": md("# M3"),
    });
    index.markUnreadable("milestones/M4.md", new Error("EACCES: permission denied, open 'x'"));
    expect(index.pathsUnder("milestones")).toEqual([
      "milestones/M1.md",
      "milestones/M4.md",
      "milestones/sub/M2.md",
    ]);
    expect(index.pathsUnder("Milestones/")).toEqual([]);
    expect(index.pathsUnder("Milestones/", true)).toHaveLength(3);
    expect(index.pathsUnder("milestones/M1.md")).toEqual(["milestones/M1.md"]);
    expect(index.remove("milestones/M4.md")).toBe(true);
    expect(index.plan.issues.map((i) => i.code)).not.toContain("unreadable-file");
  });

  it("loads the sample as before", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "planner-robust-sample-")), "plan");
    cpSync(SAMPLE_PLAN, dir, { recursive: true });
    const index = loadPlanIndex(dir);
    expect(index.plan.issues.map((i) => i.code)).not.toContain("unreadable-file");
    expect(index.paths).toEqual(listPlanFiles(SAMPLE_PLAN));
  });
});
