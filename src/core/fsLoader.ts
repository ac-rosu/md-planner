// Loads and writes a plan folder with Node's file system. Used by the MCP server, the CLI and tests;
// the extension reads through VS Code instead so that unsaved editor buffers are respected.
// A file that cannot be read is left out with a warning, never stops the whole plan from loading.
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { baselineIds } from "./baseline";
import { PlanIndex } from "./index";
import { SAVE_AS_UTF8 } from "./parser/files";
import { conflictMarkerLines } from "./parser/scan";
import { applyEdits, type TextEdit, TextLines } from "./text";

export interface PlanFolderScan {
  /** The plan files, as plan-relative POSIX paths. */
  files: string[];
  /** Plan files and folders of plan files that could not be read ("" is the plan folder). */
  unreadable: Array<{ path: string; error: unknown; folder: boolean }>;
}

/**
 * The plan files below `planDir`. Hidden files and folders, `reports/` and `baselines/` are
 * skipped; a broken symbolic link counts as missing, and a folder that was seen already (a
 * symbolic link back into the plan) is not read again.
 */
export function scanPlanFolder(planDir: string): PlanFolderScan {
  const files: string[] = [];
  const unreadable: PlanFolderScan["unreadable"] = [];
  const seen = new Set<string>();
  const folderFailed = (rel: string, error: unknown) => {
    if (holdsPlanFiles(rel)) unreadable.push({ path: rel, error, folder: true });
  };
  const walk = (dir: string, rel: string) => {
    let names: string[];
    try {
      const real = realpathSync(dir);
      if (seen.has(real)) return;
      seen.add(real);
      names = readdirSync(dir).sort();
    } catch (err) {
      folderFailed(rel, err);
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      const path = rel ? `${rel}/${name}` : name;
      let folder: boolean;
      try {
        folder = statSync(full).isDirectory();
      } catch (err) {
        if (!isMissing(err) && PlanIndex.isPlanPath(path))
          unreadable.push({ path, error: err, folder: false });
        continue;
      }
      if (folder) {
        if (path === "reports" || path === "baselines") continue;
        walk(full, path);
      } else if (PlanIndex.isPlanPath(path)) {
        files.push(path);
      }
    }
  };
  if (existsSync(planDir)) walk(planDir, "");
  return { files, unreadable };
}

/** Whether a plan-relative folder can hold plan files ("" is the plan folder). */
function holdsPlanFiles(rel: string): boolean {
  return rel === "" || PlanIndex.isPlanPath(`${rel}/x.md`);
}

/** All plan files below `planDir`, as plan-relative POSIX paths. */
export function listPlanFiles(planDir: string): string[] {
  return scanPlanFolder(planDir).files;
}

export function loadPlanIndex(planDir: string): PlanIndex {
  const index = new PlanIndex();
  const { files, unreadable } = scanPlanFolder(planDir);
  for (const u of unreadable) index.markUnreadable(u.path, u.error, u.folder);
  for (const rel of files) {
    try {
      const { text, utf8 } = readText(join(planDir, rel));
      index.update(rel, text, { utf8 });
    } catch (err) {
      if (!isMissing(err)) index.markUnreadable(rel, err);
    }
  }
  index.setUsedIds(baselineIds(readBaselines(join(planDir, "baselines"))));
  return index;
}

/** The JSON files of a baselines folder (none when it is missing or cannot be read). */
function readBaselines(dir: string): Array<{ text: string; name: string }> {
  const out: Array<{ text: string; name: string }> = [];
  try {
    for (const name of readdirSync(dir))
      if (name.endsWith(".json"))
        try {
          out.push({ text: readFileSync(join(dir, name), "utf8"), name });
        } catch {
          // Unreadable: left out, as unreadable plan files are.
        }
  } catch {
    // No baselines folder.
  }
  return out;
}

const STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const LENIENT = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * Decodes a file's bytes as UTF-8, keeping a BOM (like `readFileSync(path, "utf8")`). When they
 * are not valid UTF-8, `utf8` is false and the text is the lenient decoding (with U+FFFD), only
 * good for display: writing it back would replace every é and ü of the file.
 */
export function decodeUtf8(bytes: Uint8Array): { text: string; utf8: boolean } {
  try {
    return { text: STRICT.decode(bytes), utf8: true };
  } catch {
    return { text: LENIENT.decode(bytes), utf8: false };
  }
}

/** Reads a file as UTF-8 (see decodeUtf8). Throws what readFileSync throws. */
export function readText(full: string): { text: string; utf8: boolean } {
  return decodeUtf8(readFileSync(full));
}

/** True for the errors of a file that is not there (also a broken symbolic link). */
export function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Why the planner must not change a file as it is, or undefined: it is not UTF-8 (the edit would
 * replace its accented letters), or it has git merge conflict markers (the edit would land inside
 * the conflict). `path` names the file in the message.
 */
export function editRefusal(path: string, text: string, utf8: boolean): string | undefined {
  if (!utf8)
    return `${path} is not UTF-8, so the planner does not change it (accented letters would be lost). ${SAVE_AS_UTF8}`;
  const conflicts = conflictMarkerLines(TextLines.parse(text));
  if (conflicts.length > 0) {
    const lines = conflicts.map((l) => l + 1);
    const where =
      lines.length > 6
        ? `lines ${lines.slice(0, 6).join(", ")} …`
        : `line${lines.length > 1 ? "s" : ""} ${lines.join(", ")}`;
    return `${path} has git merge conflict markers (${where}). Resolve the conflict first: keep the lines you want and delete the <<<<<<<, ======= and >>>>>>> lines.`;
  }
  return undefined;
}

/**
 * Applies text edits to a plan file on disk and refreshes the index. Returns the new text. Refuses
 * (throws) a file that is not UTF-8 or has merge conflict markers (see editRefusal).
 */
export function applyFileEdits(
  planDir: string,
  index: PlanIndex,
  relPath: string,
  edits: TextEdit[]
): string {
  const full = join(planDir, relPath);
  const current = existsSync(full) ? readText(full) : { text: "", utf8: true };
  const refusal = editRefusal(relPath, current.text, current.utf8);
  if (refusal) throw new Error(refusal);
  const before = current.text;
  const after = applyEdits(before, edits);
  if (after !== before) writeFileSync(full, after, "utf8");
  index.update(relPath, after, { utf8: true });
  return after;
}
