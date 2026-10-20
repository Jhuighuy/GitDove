import type { DiffLine, DiffLineKind, FileDiff } from "../domain";

/** Tells whether line `line` of hunk `hunk` takes part in the patch. */
export type LinePredicate = (hunk: number, line: number) => boolean;

const C_ESCAPES: Readonly<Record<string, string>> = {
  "\x07": "\\a",
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\v": "\\v",
  "\f": "\\f",
  "\r": "\\r",
  '"': '\\"',
  "\\": "\\\\",
};

/**
 * Formats `prefix + path` the way git does in patch headers: C-quoted when the
 * path has quotes, backslashes, control or non-ASCII characters.
 */
export const quotePath = (prefix: string, path: string): string => {
  // oxlint-disable-next-line no-control-regex
  if (!/["\\\x00-\x1f\x7f-￿]/.test(path)) return prefix + path;
  let out = '"' + prefix;
  for (const ch of path) {
    const esc = C_ESCAPES[ch];
    if (esc) out += esc;
    else if (ch < " " || ch === "\x7f") out += octal(ch.codePointAt(0)!);
    else if (ch > "\x7f") for (const b of new TextEncoder().encode(ch)) out += octal(b);
    else out += ch;
  }
  return out + '"';
};

const octal = (b: number) => "\\" + b.toString(8).padStart(3, "0");

interface Line {
  readonly kind: DiffLineKind;
  readonly text: string;
  /** Index in the hunk. */
  readonly index: number;
  /** Text of a following `\\ No newline at end of file` marker. */
  readonly meta: string | null;
}

/** Splits hunk lines into context lines and blocks of consecutive changes. */
const units = (lines: readonly DiffLine[]): (Line | Line[])[] => {
  const out: (Line | Line[])[] = [];
  let last: { -readonly [K in keyof Line]: Line[K] } | null = null;
  lines.forEach((l, index) => {
    if (l.kind === "meta") {
      if (last) last.meta = l.text;
      return;
    }
    last = { kind: l.kind, text: l.text, index, meta: null };
    const prev = out.at(-1);
    if (l.kind === "context") out.push(last);
    else if (Array.isArray(prev)) prev.push(last);
    else out.push([last]);
  });
  return out;
};

/** File header lines for a patch of `diff`. */
const fileHeader = (diff: FileDiff): string[] => {
  const oldPath = diff.oldPath ?? diff.path;
  const a = quotePath("a/", oldPath);
  const b = quotePath("b/", diff.path);
  // Like git, terminate names containing spaces with a tab so they parse unambiguously.
  const tab = (p: string) => (p.includes(" ") ? "\t" : "");
  return [`diff --git ${a} ${b}`, `--- ${a}${tab(oldPath)}`, `+++ ${b}${tab(diff.path)}`];
};

/**
 * Builds a patch for `git apply` containing only the selected changed lines.
 *
 * With `reverse` false the patch applies forward on top of the diff's old side
 * (staging lines from an unstaged diff). With `reverse` true it is meant for
 * `git apply --reverse` against the diff's new side (unstaging from a staged
 * diff, or discarding from an unstaged one).
 *
 * Unselected changes are neutralized: a line that exists on the side the patch
 * applies to becomes context, and a line that does not is dropped. Context and
 * `\ No newline` markers are kept as needed. Returns `null` when no changed
 * line is selected.
 */
export const buildPatch = (
  diff: FileDiff,
  selected: LinePredicate,
  reverse: boolean,
): string | null => {
  const out = fileHeader(diff);
  // Lines added minus lines removed by the hunks emitted so far.
  let delta = 0;
  let any = false;

  diff.hunks.forEach((hunk, h) => {
    if (!hunk.lines.some((l, i) => (l.kind === "add" || l.kind === "del") && selected(h, i))) {
      return;
    }
    const body: string[] = [];
    const emit = (sign: string, l: Line) => {
      body.push(sign + l.text);
      if (l.meta !== null) body.push(`\\ ${l.meta}`);
    };
    for (const unit of units(hunk.lines)) {
      if (!Array.isArray(unit)) {
        emit(" ", unit);
        continue;
      }
      // Within a block of changes, pair the i-th deletion with the i-th
      // addition so that a selected replacement stays in place relative to the
      // unselected lines that turn into context.
      const dels = unit.filter((l) => l.kind === "del");
      const adds = unit.filter((l) => l.kind === "add");
      const pending: Line[] = [];
      const flush = () => {
        for (const l of pending) if (l.kind === "del") emit("-", l);
        for (const l of pending) if (l.kind === "add") emit("+", l);
        pending.length = 0;
      };
      for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
        for (const l of [dels[i], adds[i]]) {
          if (!l) continue;
          if (selected(h, l.index)) {
            pending.push(l);
          } else if (reverse ? l.kind === "add" : l.kind === "del") {
            // Exists on the side the patch applies to: keep it as context. A
            // pending replacement goes before it; pending lines that replace
            // nothing yet wait until the end of the block.
            if (pending.some((p) => p.kind === l.kind)) flush();
            emit(" ", l);
          }
        }
      }
      flush();
    }

    // A context line without a trailing newline can only be the last line. If
    // more lines follow it, it has to gain the newline: rewrite it as -X/+X.
    for (let i = 0; i + 2 < body.length; i++) {
      if (body[i]!.startsWith(" ") && body[i + 1]!.startsWith("\\")) {
        const text = body[i]!.slice(1);
        body.splice(i, 2, `-${text}`, body[i + 1]!, `+${text}`);
        i += 2;
      }
    }

    let oldCount = 0;
    let newCount = 0;
    for (const line of body) {
      if (!line.startsWith("+") && !line.startsWith("\\")) oldCount++;
      if (!line.startsWith("-") && !line.startsWith("\\")) newCount++;
    }
    // The side the patch applies to keeps its start; the other side is shifted
    // by the hunks before. An empty range starts at the line before it.
    const [fixedStart, fixedCount, otherCount] = reverse
      ? [hunk.newStart, newCount, oldCount]
      : [hunk.oldStart, oldCount, newCount];
    const first = (fixedCount === 0 ? fixedStart + 1 : fixedStart) + (reverse ? -delta : delta);
    const otherStart = otherCount === 0 ? first - 1 : first;
    const [oldStart, newStart] = reverse ? [otherStart, fixedStart] : [fixedStart, otherStart];
    delta += newCount - oldCount;
    any = true;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body);
  });

  return any ? out.join("\n") + "\n" : null;
};

/** Builds a patch containing a whole hunk, for applying with `reverse` as given. */
export const hunkPatch = (diff: FileDiff, hunk: number, reverse: boolean): string =>
  buildPatch(diff, (h) => h === hunk, reverse)!;
