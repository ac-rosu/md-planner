// Golden round-trip tests: parse → write gives byte-identical files on every fixture, every sample
// plan file and every template, in LF, CRLF, BOM and no-final-newline variants.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { matchCheckbox } from "../../../src/core/parser/taskLine";
import { classifyPlanPath, parseFileAs } from "../../../src/core/parser/files";
import { TextLines } from "../../../src/core/text";
import { TaskLineEditor } from "../../../src/core/writer";
import { FIXTURES, ROOT, SAMPLE_PLAN, walkFiles } from "../helpers";
import { relative } from "node:path";

const sources = [
  ...walkFiles(`${FIXTURES}/roundtrip`, (r) => r.endsWith(".md")),
  ...walkFiles(SAMPLE_PLAN, (r) => r.endsWith(".md")),
  ...walkFiles(`${ROOT}/templates`, (r) => r.endsWith(".md")),
];

function variants(text: string): Record<string, string> {
  const lf = text.replace(/\r\n?/g, "\n");
  return {
    original: text,
    crlf: lf.replace(/\n/g, "\r\n"),
    bom: "﻿" + text,
    noFinalNewline: text.replace(/(\r\n|\n|\r)+$/, ""),
    trailingBlankLines: text + "\n\n\n",
  };
}

describe("golden round trip", () => {
  it("covers fixtures, the sample project and templates", () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  for (const path of sources) {
    const rel = relative(ROOT, path);
    const bytes = readFileSync(path);
    const text = bytes.toString("utf8");

    it(`${rel}: utf-8 decode is lossless`, () => {
      expect(Buffer.from(text, "utf8").equals(bytes)).toBe(true);
    });

    for (const [name, variant] of Object.entries(variants(text))) {
      it(`${rel} (${name}): parse → serialize is byte-identical`, () => {
        const kind = classifyPlanPath(rel.replace(/^.*?plan\//, "")) ?? "milestone";
        const parsed = parseFileAs("x.md", variant, kind);
        expect(parsed.lines.serialize()).toBe(variant);
        // A no-op edit of every checkbox line reproduces it exactly.
        for (const item of parsed.items) {
          const line = parsed.lines.line(item.line);
          expect(new TaskLineEditor(line).toString()).toBe(line);
          expect(new TaskLineEditor(line).toEdit(item.line)).toBeUndefined();
        }
      });
    }
  }

  it("keeps per-line endings in mixed files", () => {
    const text = "a\r\nb\nc\rd";
    const lines = TextLines.parse(text);
    expect(lines.lines.map((l) => l.eol)).toEqual(["\r\n", "\n", "\r", ""]);
    expect(lines.serialize()).toBe(text);
    expect(lines.eol).toBe("\n");
  });

  it("strips the BOM from positions but restores it on serialize", () => {
    const lines = TextLines.parse("﻿- [ ] a");
    expect(lines.line(0)).toBe("- [ ] a");
    expect(matchCheckbox(lines.line(0))?.statusCol).toBe(3);
    expect(lines.serialize()).toBe("﻿- [ ] a");
  });
});

describe("inverse edits", () => {
  it("restores the original text exactly, also with CRLF and multi-line edits", async () => {
    const { invertEdits, applyEdits } = await import("../../../src/core/text");
    const cases: Array<
      [
        string,
        Array<{
          range: {
            start: { line: number; character: number };
            end: { line: number; character: number };
          };
          newText: string;
        }>,
      ]
    > = [
      [
        "a b c\nd e f\n",
        [
          {
            range: { start: { line: 0, character: 2 }, end: { line: 0, character: 3 } },
            newText: "BB",
          },
          {
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
            newText: "x\ny\n",
          },
        ],
      ],
      [
        "one\r\ntwo\r\nthree",
        [
          {
            range: { start: { line: 0, character: 1 }, end: { line: 2, character: 2 } },
            newText: "NE",
          },
        ],
      ],
      [
        "﻿- [ ] t @est:4h ^T1\n",
        [
          {
            range: { start: { line: 0, character: 15 }, end: { line: 0, character: 16 } },
            newText: "8",
          },
        ],
      ],
    ];
    for (const [source, edits] of cases) {
      const { text, inverse } = invertEdits(source, edits);
      expect(text).toBe(applyEdits(source, edits));
      expect(applyEdits(text, inverse)).toBe(source);
    }
  });
});
