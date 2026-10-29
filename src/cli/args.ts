// Command-line arguments: parsing, the known options and checks of their values. Every mistake is
// reported as one line (exit code 2), never as a stack trace.

export interface ParsedArgs {
  command?: string;
  flags: Map<string, string | true>;
  positional: string[];
}

/** Options without a value. */
export const SWITCHES = new Set(["json", "strict", "help", "version"]);

/** Options that take a value, for every command. */
export const VALUE_OPTIONS = new Set(["plan", "today", "mode", "unassigned-capacity"]);

/** Options of `planner export` that take a value. */
export const EXPORT_OPTIONS = new Set([
  "format",
  "out",
  "sections",
  "summary",
  "period",
  "weeks",
  "test",
  "baseline",
  "author",
  "company",
  "accent",
  "logo",
  "browser",
  "delimiter",
]);

/** Free text that may be empty (`--summary ""`). */
const MAY_BE_EMPTY = new Set(["summary", "author", "company"]);

/**
 * `--name value`, `--name=value` and switches. A switch never takes the next argument as its value,
 * so `planner --json validate` runs `validate`.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
      else if (!SWITCHES.has(a.slice(2)) && i + 1 < argv.length && !argv[i + 1].startsWith("--"))
        flags.set(a.slice(2), argv[++i]);
      else flags.set(a.slice(2), true);
    } else {
      positional.push(a);
    }
  }
  return { command: positional.shift(), flags, positional };
}

/** The first unknown option, option without its value or unexpected argument, as a message. */
export function argumentError(args: ParsedArgs): string | undefined {
  for (const [name, value] of args.flags) {
    if (SWITCHES.has(name)) continue;
    if (!VALUE_OPTIONS.has(name) && !EXPORT_OPTIONS.has(name))
      return `Unknown option --${name} (see: planner help${args.command === "export" ? " export" : ""}).`;
    if (value === true || (value === "" && !MAY_BE_EMPTY.has(name)))
      return `Option --${name} needs a value.`;
  }
  // `planner help export` names the command to explain; other commands take no arguments.
  const extra = args.command === "help" ? args.positional.slice(1) : args.positional;
  if (extra.length)
    return `Unexpected argument "${extra[0]}"${args.command === "help" ? "" : " (options start with --, e.g. --plan <dir>)"}.`;
  return undefined;
}

/** The value of an option given as text, else undefined. */
export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

/**
 * A number option: its default when not given, else the number, or an error message when it is
 * not a number of at least `min` (and whole, with `integer`).
 */
export function numberFlag(
  args: ParsedArgs,
  name: string,
  fallback: number,
  rule: { min: number; integer?: boolean; expected: string }
): number | { error: string } {
  const text = stringFlag(args, name);
  if (text === undefined) return fallback;
  const n = (rule.integer ? /^\d+$/ : /^\d+(\.\d+)?$/).test(text.trim()) ? Number(text) : NaN;
  if (!Number.isFinite(n) || n < rule.min)
    return { error: `Invalid --${name} ${text} (expected ${rule.expected}).` };
  return n;
}

/** A short reason for a failed file operation (`permission denied`), without a stack trace. */
export function fsReason(err: unknown): string {
  switch ((err as { code?: unknown } | undefined)?.code) {
    case "EACCES":
    case "EPERM":
      return "permission denied";
    case "ENOENT":
      return "not found";
    case "ENOTDIR":
      return "a part of the path is a file, not a folder";
    case "EISDIR":
      return "it is a folder";
    case "EEXIST":
      return "it already exists";
    case "EROFS":
      return "read-only file system";
    case "ENOSPC":
      return "no space left on the device";
    default:
      return (err instanceof Error ? err.message : String(err)).split("\n")[0];
  }
}
