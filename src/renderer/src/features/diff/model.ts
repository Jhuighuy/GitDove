import type { DiffLineKind, FileDiff } from "@shared/domain";
import {
  type Conflict,
  conflictPart,
  type ConflictPart,
  findConflicts,
} from "@shared/diff/conflicts";

/** One diff line, flattened across hunks. */
export interface Line {
  /** Index in `DiffModel.lines`. */
  readonly id: number;
  readonly hunk: number;
  /** Index within the hunk. */
  readonly index: number;
  readonly kind: DiffLineKind;
  readonly oldNo: number | null;
  readonly newNo: number | null;
  readonly text: string;
  /** Id of the line this one replaces or is replaced by, or -1. */
  readonly pair: number;
  /** Index into `DiffModel.sides[side]` used for highlighting, or -1. */
  readonly side: 0 | 1;
  readonly sideIndex: number;
  /** The part of a block of conflict markers the line is in, if any. */
  readonly conflict: ConflictPart | null;
}

export type Row =
  | { readonly type: "hunk"; readonly hunk: number }
  | { readonly type: "line"; readonly id: number }
  /** The actions on a block of conflict markers, above its first line. */
  | { readonly type: "conflict"; readonly conflict: number }
  /** A split view row; -1 marks an empty cell. */
  | { readonly type: "split"; readonly left: number; readonly right: number };

/** Most lines shown: beyond about 1.6M rows the view would exceed the browser's height limit. */
export const MAX_LINES = 1_000_000;
/** Lines are shown up to this many characters. */
export const MAX_TEXT = 10_000;
/** Columns a tab advances to a multiple of; the view sets the same `tab-size`. */
export const TAB_SIZE = 4;

export interface DiffModel {
  /** The diff shown; cut short (and marked truncated) beyond `MAX_LINES`. */
  readonly diff: FileDiff;
  readonly lines: readonly Line[];
  /** Id of each hunk's first line. */
  readonly hunkStart: readonly number[];
  /** Blocks of conflict markers, in a conflicted file's working tree diff. */
  readonly conflicts: readonly Conflict[];
  readonly unified: readonly Row[];
  readonly split: readonly Row[];
  /** Old (0) and new (1) file contents covered by the hunks, for highlighting. */
  readonly sides: readonly [string[], string[]];
  /** Side indices where a hunk starts, i.e. where highlighting state resets. */
  readonly resets: readonly [number[], number[]];
  /** Widest line, in columns (`ch`), up to about `MAX_TEXT`. */
  readonly width: number;
  /** Widest line number, in digits. */
  readonly gutter: number;
}

/** Columns a code point takes in a monospace font: wide East Asian characters take two. */
const columns = (cp: number) =>
  cp >= 0x300 && cp < 0x370
    ? 0
    : (cp >= 0x1100 && cp <= 0x115f) ||
        (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
        (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe30 && cp <= 0xfe4f) ||
        (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6) ||
        (cp >= 0x1f300 && cp <= 0x1f64f) ||
        (cp >= 0x1f900 && cp <= 0x1f9ff) ||
        (cp >= 0x20000 && cp <= 0x3fffd)
      ? 2
      : 1;

/** Width of a line's shown text, in columns, expanding tabs. */
export const displayWidth = (text: string): number => {
  let width = 0;
  const end = Math.min(text.length, MAX_TEXT);
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c === 9) width += TAB_SIZE - (width % TAB_SIZE);
    else if (c < 0x300) width++;
    else {
      const cp = text.codePointAt(i)!;
      if (cp > 0xffff) i++;
      width += columns(cp);
    }
  }
  return width;
};

/** `diff` with its hunks cut after `max` lines in total. */
export const capLines = (diff: FileDiff, max = MAX_LINES): FileDiff => {
  let left = max;
  const hunks = [];
  for (const hunk of diff.hunks) {
    if (left <= 0) break;
    hunks.push(hunk.lines.length <= left ? hunk : { ...hunk, lines: hunk.lines.slice(0, left) });
    left -= hunk.lines.length;
  }
  // Cut short when a hunk was shortened or left out (the budget can end between hunks).
  const cut = left < 0 || hunks.length < diff.hunks.length;
  return cut ? { ...diff, hunks, truncated: true } : diff;
};

export const buildModel = (full: FileDiff): DiffModel => {
  const diff = capLines(full);
  const conflicts = findConflicts(diff);
  const lines: Line[] = [];
  /** The first conflict that does not end before the line being added. */
  let next = 0;
  const hunkStart: number[] = [];
  const unified: Row[] = [];
  const split: Row[] = [];
  const sides: [string[], string[]] = [[], []];
  const resets: [number[], number[]] = [[], []];
  let width = 0;
  let maxNo = 0;

  diff.hunks.forEach((hunk, h) => {
    hunkStart.push(lines.length);
    unified.push({ type: "hunk", hunk: h });
    split.push({ type: "hunk", hunk: h });
    resets[0].push(sides[0].length);
    resets[1].push(sides[1].length);
    maxNo = Math.max(maxNo, hunk.oldStart + hunk.oldLines, hunk.newStart + hunk.newLines);

    // Deletions and additions of the current block of changes.
    let dels: number[] = [];
    let adds: number[] = [];
    const flushBlock = () => {
      for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
        const d = dels[i] ?? -1;
        const a = adds[i] ?? -1;
        split.push({ type: "split", left: d, right: a });
        // A conflict marker replaces no line: its words are not compared.
        const words = (id: number, kind: DiffLineKind) =>
          lines[id]!.kind === kind && lines[id]!.conflict !== "marker";
        if (d >= 0 && a >= 0 && words(d, "del") && words(a, "add")) {
          (lines[d] as { pair: number }).pair = a;
          (lines[a] as { pair: number }).pair = d;
        }
      }
      dels = [];
      adds = [];
    };

    hunk.lines.forEach((l, index) => {
      const id = lines.length;
      // Conflicts are in order: a cursor finds the one a line is in.
      while (next < conflicts.length) {
        const c = conflicts[next]!;
        if (c.hunk > h || (c.hunk === h && c.end >= index)) break;
        next++;
      }
      const block = conflicts[next]?.hunk === h ? conflicts[next]! : null;
      if (block?.start === index) {
        // Split rows of the lines before go before the actions.
        flushBlock();
        unified.push({ type: "conflict", conflict: next });
        split.push({ type: "conflict", conflict: next });
      }
      const conflict = block ? conflictPart(block, index) : null;
      const side: 0 | 1 = l.kind === "del" ? 0 : 1;
      let sideIndex = -1;
      // Conflict markers are not code, and highlighted as code they would throw off the lines
      // after them too (e.g. a quote in a commit subject).
      if (conflict !== "marker") {
        if (l.kind === "del") {
          sideIndex = sides[0].push(l.text) - 1;
        } else if (l.kind === "add") {
          sideIndex = sides[1].push(l.text) - 1;
        } else if (l.kind === "context") {
          sides[0].push(l.text);
          sideIndex = sides[1].push(l.text) - 1;
        }
      }
      lines.push({ id, hunk: h, index, ...l, pair: -1, side, sideIndex, conflict });
      unified.push({ type: "line", id });
      // A line is at most TAB_SIZE columns per character wide.
      if (l.text.length * TAB_SIZE > width) width = Math.max(width, displayWidth(l.text));

      if (l.kind === "context") {
        flushBlock();
        split.push({ type: "split", left: id, right: id });
      } else if (l.kind === "del") {
        if (adds.length > 0) flushBlock();
        dels.push(id);
      } else if (l.kind === "add") {
        adds.push(id);
      } else {
        // A "\ No newline" marker follows the line it belongs to.
        const prev = lines[id - 1];
        if (prev?.kind === "del") dels.push(id);
        else if (prev?.kind === "add") adds.push(id);
        else {
          flushBlock();
          split.push({ type: "split", left: id, right: id });
        }
      }
    });
    flushBlock();
  });

  return {
    diff,
    lines,
    hunkStart,
    conflicts,
    unified,
    split,
    sides,
    resets,
    width,
    gutter: String(maxNo).length,
  };
};

/** Whether a line can be selected for line-level staging. */
export const isChange = (l: Line) => l.kind === "add" || l.kind === "del";
