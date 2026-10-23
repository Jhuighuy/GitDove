import type { DiffHunk, DiffLine, FileDiff } from "../domain";
import { buildPatch } from "./patch";

/**
 * A block of conflict markers in a conflicted file's working tree diff:
 *
 * ```
 * <<<<<<< current
 * (current lines)
 * ||||||| base        (diff3 and zdiff3 styles only)
 * (base lines)
 * =======
 * (incoming lines)
 * >>>>>>> incoming
 * ```
 *
 * Marker positions are line indices in hunk `hunk`. The working tree has every line of the
 * block, so a block always falls within one hunk.
 */
export interface Conflict {
  readonly hunk: number;
  readonly start: number;
  /** The base section's marker, or -1. */
  readonly base: number;
  readonly separator: number;
  readonly end: number;
  /** What the markers name the sides, e.g. `HEAD` and a branch. */
  readonly current: string;
  readonly incoming: string;
}

export type ConflictChoice = "current" | "incoming" | "both";

export type ConflictPart = "marker" | "current" | "base" | "incoming";

/** Whether a line is in the working tree file. */
const inFile = (l: DiffLine) => l.newNo !== null;

/** The marker's label if `text` is a marker of `char` repeated `size` times, else null. */
const marker = (text: string, char: string, size: number): string | null => {
  const t = text.endsWith("\r") ? text.slice(0, -1) : text;
  if (t.length < size || t.charCodeAt(size) === char.charCodeAt(0)) return null;
  for (let i = 0; i < size; i++) if (t[i] !== char) return null;
  if (t.length === size) return "";
  return t[size] === " " ? t.slice(size + 1) : null;
};

/** A start marker: seven `<` by default, but the `conflict-marker-size` attribute can change it. */
const START_RE = /^(<+)(?: |\r?$)/;

const findInHunk = (hunk: DiffHunk, h: number, out: Conflict[]) => {
  const lines = hunk.lines;
  for (let i = 0; i < lines.length; i++) {
    const size = inFile(lines[i]!) ? START_RE.exec(lines[i]!.text)?.[1]?.length : undefined;
    if (size === undefined) continue;
    const current = marker(lines[i]!.text, "<", size)!;
    let base = -1;
    let separator = -1;
    // Scans to the end marker; another start marker first abandons this block for that one.
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (!inFile(l)) continue;
      if (marker(l.text, "<", size) !== null) {
        i = j - 1;
        break;
      }
      if (separator < 0) {
        if (base < 0 && marker(l.text, "|", size) !== null) base = j;
        else if (l.text.replace(/\r$/, "") === "=".repeat(size)) separator = j;
        continue;
      }
      const incoming = marker(l.text, ">", size);
      if (incoming === null) continue;
      out.push({ hunk: h, start: i, base, separator, end: j, current, incoming });
      i = j;
      break;
    }
  }
};

/** The blocks of conflict markers in `diff`, in order. Only a conflicted file's diff has them. */
export const findConflicts = (diff: FileDiff): Conflict[] => {
  if (diff.readOnly !== "conflict") return [];
  const out: Conflict[] = [];
  diff.hunks.forEach((hunk, h) => findInHunk(hunk, h, out));
  return out;
};

/** Which part of `c` line `index` of its hunk is in, if any. */
export const conflictPart = (c: Conflict, index: number): ConflictPart | null => {
  if (index < c.start || index > c.end) return null;
  if (index === c.start || index === c.base || index === c.separator || index === c.end) {
    return "marker";
  }
  if (index > c.separator) return "incoming";
  return c.base >= 0 && index > c.base ? "base" : "current";
};

/** Whether `choice` keeps line `index` of the block. */
const keeps = (c: Conflict, index: number, choice: ConflictChoice): boolean => {
  const part = conflictPart(c, index);
  return (
    part === null ||
    (part === "current" && choice !== "incoming") ||
    (part === "incoming" && choice !== "current")
  );
};

/**
 * A patch for the working tree that resolves conflicts: each block keeps the side(s) chosen and
 * loses its markers and base section. The rest of each hunk is context, so the patch applies
 * only to the file the diff was made from.
 */
export const resolvePatch = (
  diff: FileDiff,
  choices: readonly { readonly conflict: Conflict; readonly choice: ConflictChoice }[],
): string | null => {
  // The working tree file, as the old side of a diff that drops the lines the choices remove.
  const hunks = diff.hunks.map((hunk, h): DiffHunk => {
    const here = choices.filter((c) => c.conflict.hunk === h);
    const lines: DiffLine[] = [];
    let no = hunk.newStart;
    hunk.lines.forEach((l, i) => {
      // A "\ No newline" marker stays with the line before it.
      if (l.kind === "meta") {
        if (lines.at(-1) && hunk.lines[i - 1] && inFile(hunk.lines[i - 1]!)) lines.push(l);
        return;
      }
      if (!inFile(l)) return;
      const kept = here.every((c) => keeps(c.conflict, i, c.choice));
      lines.push({ kind: kept ? "context" : "del", oldNo: no++, newNo: null, text: l.text });
    });
    const kept = lines.filter((l) => l.kind === "context").length;
    const removed = lines.filter((l) => l.kind === "del").length;
    return {
      header: "",
      oldStart: hunk.newStart,
      oldLines: kept + removed,
      newStart: hunk.newStart,
      newLines: kept,
      lines,
    };
  });
  const file: FileDiff = { path: diff.path, oldPath: null, binary: false, hunks, truncated: false };
  return buildPatch(file, () => true, false);
};
