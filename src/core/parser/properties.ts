// Property blocks: `key: value` lines directly under a heading, before any other content.
// In a property line, ` # ` (space-hash-space) starts a comment.
import { type PropertyBlock, type PropertyEntry } from "../model";
import { range, type TextLines } from "../text";

const PROPERTY = /^([A-Za-z][A-Za-z0-9_-]*):(?=[ \t]|$)/;

export function matchProperty(text: string, line: number): PropertyEntry | undefined {
  const m = PROPERTY.exec(text);
  if (!m) return undefined;
  const key = m[1];
  const colonEnd = key.length + 1;
  let rest = text.slice(colonEnd);
  let valueStart = colonEnd;
  // Skip whitespace after the colon.
  const ws = /^[ \t]*/.exec(rest)![0];
  valueStart += ws.length;
  rest = rest.slice(ws.length);

  let comment: string | undefined;
  let valueText = rest;
  if (rest.startsWith("# ") || rest === "#") {
    comment = rest.slice(1).trim();
    valueText = "";
  } else {
    const c = /[ \t]#(?:[ \t]|$)/.exec(rest);
    if (c) {
      comment = rest.slice(c.index + 2).trim();
      valueText = rest.slice(0, c.index);
    }
  }
  const trimmed = valueText.replace(/[ \t]+$/, "");
  return {
    key,
    value: trimmed,
    comment,
    line,
    keyRange: range(line, 0, key.length),
    valueRange: range(line, valueStart, valueStart + trimmed.length),
  };
}

/**
 * Reads the property block that follows the heading on `headingLine` (or starts at the top of the
 * file when headingLine is -1). Blank lines between the heading and the first property are allowed;
 * the block ends at the first line that is not a property.
 */
export function readPropertyBlock(lines: TextLines, headingLine: number): PropertyBlock {
  const entries: PropertyEntry[] = [];
  let i = headingLine + 1;
  while (i < lines.lineCount && lines.line(i).trim() === "") i++;
  let insertLine = headingLine + 1;
  while (i < lines.lineCount) {
    const entry = matchProperty(lines.line(i), i);
    if (!entry) break;
    entries.push(entry);
    i++;
    insertLine = i;
  }
  return { headingLine, entries, insertLine };
}

export function getProp(block: PropertyBlock, key: string): PropertyEntry | undefined {
  const lower = key.toLowerCase();
  return block.entries.find((e) => e.key.toLowerCase() === lower);
}

export function getProps(block: PropertyBlock, key: string): PropertyEntry[] {
  const lower = key.toLowerCase();
  return block.entries.filter((e) => e.key.toLowerCase() === lower);
}

export function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
