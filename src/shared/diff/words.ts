/** A half-open character range `[start, end)`. */
export type Range = readonly [number, number];

export interface WordDiff {
  /** Changed ranges in the old line. */
  readonly del: readonly Range[];
  /** Changed ranges in the new line. */
  readonly add: readonly Range[];
}

/** Lines longer than this are not compared. */
const MAX_LINE = 1000;
/** Limit on the LCS table size; beyond it the middle is marked as changed. */
const MAX_CELLS = 64 * 64;
/** Emphasis is pointless when less than this share of the line is unchanged. */
const MIN_COMMON = 0.3;

const WORD_RE = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gsu;

const tokenize = (s: string) => s.match(WORD_RE) ?? [];

/**
 * Computes intra-line changes between a deleted and an added line, at word
 * granularity. Returns `null` when the lines are too long or too different
 * for the emphasis to be useful.
 */
export const wordDiff = (a: string, b: string): WordDiff | null => {
  if (a === b || a.length > MAX_LINE || b.length > MAX_LINE) return null;
  const ta = tokenize(a);
  const tb = tokenize(b);

  let pre = 0;
  while (pre < ta.length && pre < tb.length && ta[pre] === tb[pre]) pre++;
  let suf = 0;
  while (
    suf < ta.length - pre &&
    suf < tb.length - pre &&
    ta[ta.length - 1 - suf] === tb[tb.length - 1 - suf]
  ) {
    suf++;
  }

  // Which tokens of the middle parts are common, via an LCS table.
  const ma = ta.slice(pre, ta.length - suf);
  const mb = tb.slice(pre, tb.length - suf);
  const keepA = Array.from<boolean>({ length: ma.length }).fill(false);
  const keepB = Array.from<boolean>({ length: mb.length }).fill(false);
  if (ma.length > 0 && mb.length > 0 && ma.length * mb.length <= MAX_CELLS) {
    const w = mb.length + 1;
    const t = new Uint16Array((ma.length + 1) * w);
    for (let i = ma.length - 1; i >= 0; i--) {
      for (let j = mb.length - 1; j >= 0; j--) {
        t[i * w + j] =
          ma[i] === mb[j]
            ? t[(i + 1) * w + j + 1]! + 1
            : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
      }
    }
    for (let i = 0, j = 0; i < ma.length && j < mb.length;) {
      if (ma[i] === mb[j]) {
        keepA[i++] = true;
        keepB[j++] = true;
      } else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) i++;
      else j++;
    }
  }

  const prefixLen = ta.slice(0, pre).join("").length;
  const del = ranges(ma, keepA, prefixLen);
  const add = ranges(mb, keepB, prefixLen);
  const changed = (rs: Range[]) => rs.reduce((n, [s, e]) => n + e - s, 0);
  const common = Math.min(a.length - changed(del), b.length - changed(add));
  if (common < MIN_COMMON * Math.max(a.length, b.length)) return null;
  return { del, add };
};

/**
 * Converts unkept tokens to character ranges, merging changes separated only
 * by whitespace so the emphasis reads as whole phrases.
 */
const ranges = (tokens: string[], keep: boolean[], offset: number): Range[] => {
  const out: [number, number][] = [];
  let pos = offset;
  tokens.forEach((tok, i) => {
    const start = pos;
    pos += tok.length;
    if (keep[i]) return;
    const last = out.at(-1);
    const gap = i > 0 && /^\s+$/.test(tokens[i - 1]!) ? tokens[i - 1]!.length : 0;
    if (last && (last[1] === start || last[1] === start - gap)) last[1] = pos;
    else out.push([start, pos]);
  });
  return out;
};
