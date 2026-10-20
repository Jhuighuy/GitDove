import type { DiffLineKind, FileDiff } from "@shared/domain";

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
}

export type Row =
  | { readonly type: "hunk"; readonly hunk: number }
  | { readonly type: "line"; readonly id: number }
  /** A split view row; -1 marks an empty cell. */
  | { readonly type: "split"; readonly left: number; readonly right: number };

export interface DiffModel {
  readonly diff: FileDiff;
  readonly lines: readonly Line[];
  /** Id of each hunk's first line. */
  readonly hunkStart: readonly number[];
  readonly unified: readonly Row[];
  readonly split: readonly Row[];
  /** Old (0) and new (1) file contents covered by the hunks, for highlighting. */
  readonly sides: readonly [string[], string[]];
  /** Side indices where a hunk starts, i.e. where highlighting state resets. */
  readonly resets: readonly [number[], number[]];
  /** Longest line, in characters. */
  readonly width: number;
  /** Widest line number, in digits. */
  readonly gutter: number;
}

export const buildModel = (diff: FileDiff): DiffModel => {
  const lines: Line[] = [];
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
        if (d >= 0 && a >= 0 && lines[d]!.kind === "del" && lines[a]!.kind === "add") {
          (lines[d] as { pair: number }).pair = a;
          (lines[a] as { pair: number }).pair = d;
        }
      }
      dels = [];
      adds = [];
    };

    hunk.lines.forEach((l, index) => {
      const id = lines.length;
      let side: 0 | 1 = 1;
      let sideIndex = -1;
      if (l.kind === "del") {
        side = 0;
        sideIndex = sides[0].push(l.text) - 1;
      } else if (l.kind === "add") {
        sideIndex = sides[1].push(l.text) - 1;
      } else if (l.kind === "context") {
        sides[0].push(l.text);
        sideIndex = sides[1].push(l.text) - 1;
      }
      lines.push({ id, hunk: h, index, ...l, pair: -1, side, sideIndex });
      unified.push({ type: "line", id });
      if (l.text.length > width) width = l.text.length;

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
