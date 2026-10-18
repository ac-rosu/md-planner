// Tokenizer for checkbox list items:  `- [/] Title text @est:12h @owner:mark #tag ^T102`
import { type Range, range } from "../text";

/** `- [ ] `, `* [x]`, `1. [/]` … captures indent, marker, gap, status char and what follows. */
const CHECKBOX = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)\[([^\]\r\n])\](?=[ \t]|$)/;
const PLAIN_LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const ATTR_KEY = /^[A-Za-z][A-Za-z0-9_-]*/;
const TAG = /^[\p{L}\p{N}_][\p{L}\p{N}_/-]*/u;
const ID = /^\^[A-Za-z0-9_-]+$/;

export type Token =
  | { kind: "space"; text: string; start: number; end: number }
  | { kind: "text"; text: string; start: number; end: number }
  | {
      kind: "attr";
      key: string;
      value: string;
      quoted: boolean;
      start: number;
      end: number;
      valueStart: number;
      valueEnd: number;
    }
  | { kind: "tag"; tag: string; start: number; end: number }
  | { kind: "id"; id: string; start: number; end: number };

export interface CheckboxLine {
  indentText: string;
  marker: string;
  statusChar: string;
  statusCol: number;
  /** Column right after the closing `]`. */
  contentStart: number;
  tokens: Token[];
}

export function matchCheckbox(text: string): CheckboxLine | undefined {
  const m = CHECKBOX.exec(text);
  if (!m) return undefined;
  const statusCol = m[1].length + m[2].length + m[3].length + 1;
  const contentStart = statusCol + 2;
  return {
    indentText: m[1],
    marker: m[2],
    statusChar: m[4],
    statusCol,
    contentStart,
    tokens: tokenize(text, contentStart),
  };
}

export function isPlainListItem(text: string): boolean {
  return PLAIN_LIST_ITEM.test(text);
}

/** Splits the content of a task line into space, text, attribute, tag and id tokens. */
export function tokenize(text: string, from: number): Token[] {
  const tokens: Token[] = [];
  let i = from;
  const n = text.length;
  while (i < n) {
    const start = i;
    if (text[i] === " " || text[i] === "\t") {
      while (i < n && (text[i] === " " || text[i] === "\t")) i++;
      tokens.push({ kind: "space", text: text.slice(start, i), start, end: i });
      continue;
    }
    const ch = text[i];
    if (ch === "@") {
      const attr = readAttr(text, i);
      if (attr) {
        tokens.push(attr);
        i = attr.end;
        continue;
      }
    } else if (ch === "#") {
      const m = TAG.exec(text.slice(i + 1));
      if (m) {
        const end = i + 1 + m[0].length;
        tokens.push({ kind: "tag", tag: m[0], start, end });
        i = end;
        continue;
      }
    }
    while (i < n && text[i] !== " " && text[i] !== "\t") i++;
    tokens.push({ kind: "text", text: text.slice(start, i), start, end: i });
  }
  // The stable id is the last non-space token on the line.
  for (let k = tokens.length - 1; k >= 0; k--) {
    const t = tokens[k];
    if (t.kind === "space") continue;
    if (t.kind === "text" && ID.test(t.text)) {
      tokens[k] = { kind: "id", id: t.text.slice(1), start: t.start, end: t.end };
    }
    break;
  }
  return tokens;
}

function readAttr(text: string, at: number): Token | undefined {
  const keyMatch = ATTR_KEY.exec(text.slice(at + 1));
  if (!keyMatch) return undefined;
  const key = keyMatch[0];
  const colon = at + 1 + key.length;
  if (text[colon] !== ":") return undefined;
  const valueStart = colon + 1;
  if (text[valueStart] === '"') {
    // Quoted value: runs to the next unescaped quote.
    let j = valueStart + 1;
    let value = "";
    while (j < text.length && text[j] !== '"') {
      if (text[j] === "\\" && (text[j + 1] === '"' || text[j + 1] === "\\")) {
        value += text[j + 1];
        j += 2;
      } else {
        value += text[j];
        j++;
      }
    }
    const closed = j < text.length;
    const after = j + 1;
    if (closed && (after >= text.length || text[after] === " " || text[after] === "\t")) {
      return {
        kind: "attr",
        key,
        value,
        quoted: true,
        start: at,
        end: after,
        valueStart: valueStart + 1,
        valueEnd: j,
      };
    }
    // Unterminated or glued quote: fall through and read as an unquoted value.
  }
  let j = valueStart;
  while (j < text.length && text[j] !== " " && text[j] !== "\t") j++;
  return {
    kind: "attr",
    key,
    value: text.slice(valueStart, j),
    quoted: false,
    start: at,
    end: j,
    valueStart,
    valueEnd: j,
  };
}

/** Formats an attribute token, quoting values that contain whitespace or quotes. */
export function formatAttr(key: string, value: string): string {
  return `@${key}:${formatAttrValue(value)}`;
}

export function formatAttrValue(value: string): string {
  if (value === "" || /[\s"]/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

export function tokenRange(line: number, t: { start: number; end: number }): Range {
  return range(line, t.start, t.end);
}
