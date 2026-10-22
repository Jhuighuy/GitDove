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
/** Most token edits worth finding; beyond it the middle is marked as changed. */
const MAX_EDITS = 256;
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

  // Which tokens of the middle parts are common.
  const ma = ta.slice(pre, ta.length - suf);
  const mb = tb.slice(pre, tb.length - suf);
  const keepA = Array.from<boolean>({ length: ma.length }).fill(false);
  const keepB = Array.from<boolean>({ length: mb.length }).fill(false);
  markCommon(ma, mb, keepA, keepB);

  const prefixLen = ta.slice(0, pre).join("").length;
  const del = ranges(ma, keepA, prefixLen);
  const add = ranges(mb, keepB, prefixLen);
  const changed = (rs: Range[]) => rs.reduce((n, [s, e]) => n + e - s, 0);
  const common = Math.min(a.length - changed(del), b.length - changed(add));
  if (common < MIN_COMMON * Math.max(a.length, b.length)) return null;
  return { del, add };
};

/**
 * Marks the tokens of a longest common subsequence of `a` and `b` in `keepA`
 * and `keepB`, using Myers' O((N+M)D) algorithm, which is fast when the lines
 * differ little. Marks nothing when more than `MAX_EDITS` edits are needed.
 */
const markCommon = (a: string[], b: string[], keepA: boolean[], keepB: boolean[]) => {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const off = max + 1;
  // Furthest x reached on each diagonal k = x - y, and a copy of it before each step.
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  const down = (k: number, d: number) => k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!);
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = down(k, d) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x < n || y < m) continue;
      // Walk back through the steps, marking the diagonal moves.
      for (let e = d; e >= 0; e--) {
        v.set(trace[e]!);
        const diagonal = x - y;
        const prevK = e === 0 ? 0 : down(diagonal, e) ? diagonal + 1 : diagonal - 1;
        const prevX = e === 0 ? 0 : v[off + prevK]!;
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) {
          keepA[--x] = true;
          keepB[--y] = true;
        }
        x = prevX;
        y = prevY;
      }
      return;
    }
  }
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
