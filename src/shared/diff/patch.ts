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

const utf8 = new TextEncoder();

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
    else if (ch > "\x7f") for (const b of utf8.encode(ch)) out += octal(b);
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
  /** Text of a following `\ No newline at end of file` marker. */
  readonly meta: string | null;
}

/** A line of a hunk being built. */
interface PatchLine {
  readonly sign: " " | "-" | "+";
  readonly text: string;
  /** Text of a following `\ No newline at end of file` marker. */
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

/**
 * Places `\ No newline at end of file` markers. A marker says that its line is
 * the last one of the side(s) it is on, but dropping unselected changes or
 * turning them into context can put lines after it. A marked line therefore
 * keeps its marker only on the sides nothing follows it on: a change loses it,
 * and a context line splits into a removal and an addition when the two sides
 * disagree.
 */
const placeNewlineMarkers = (body: readonly PatchLine[]): PatchLine[] => {
  const out: PatchLine[] = [];
  let laterOld = false;
  let laterNew = false;
  for (let i = body.length - 1; i >= 0; i--) {
    const l = body[i]!;
    const onOld = l.sign !== "+";
    const onNew = l.sign !== "-";
    if (l.meta !== null) {
      // Whether the line has to end with a newline on each side.
      const oldNeeds = onOld && laterOld;
      const newNeeds = onNew && laterNew;
      if (l.sign !== " " || oldNeeds === newNeeds) {
        out.push(oldNeeds || newNeeds ? { ...l, meta: null } : l);
      } else if (oldNeeds) {
        // Reversed below: -X, +X, \.
        out.push(
          { sign: "+", text: l.text, meta: l.meta },
          { sign: "-", text: l.text, meta: null },
        );
      } else {
        // Reversed below: -X, \, +X.
        out.push(
          { sign: "+", text: l.text, meta: null },
          { sign: "-", text: l.text, meta: l.meta },
        );
      }
    } else {
      out.push(l);
    }
    laterOld ||= onOld;
    laterNew ||= onNew;
  }
  return out.toReversed();
};

/**
 * File header lines for a patch of `diff`. A patch that creates the file or
 * deletes it says so, so that `git apply` adds or removes the file rather than
 * leaving an empty one.
 */
const fileHeader = (diff: FileDiff, creates: boolean, deletes: boolean): string[] => {
  const oldPath = diff.oldPath ?? diff.path;
  const a = quotePath("a/", oldPath);
  const b = quotePath("b/", diff.path);
  // Like git, terminate names containing spaces with a tab so they parse unambiguously.
  const tab = (p: string) => (p.includes(" ") ? "\t" : "");
  const mode = diff.mode ?? "100644";
  return [
    `diff --git ${a} ${b}`,
    ...(creates ? [`new file mode ${mode}`] : []),
    ...(deletes ? [`deleted file mode ${mode}`] : []),
    creates ? "--- /dev/null" : `--- ${a}${tab(oldPath)}`,
    deletes ? "+++ /dev/null" : `+++ ${b}${tab(diff.path)}`,
  ];
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
 * `\ No newline` markers are kept as needed. For a created (deleted) file, a
 * patch with an empty old (new) side creates (deletes) the file. Returns
 * `null` when no changed line is selected.
 *
 * This is a pure function of the parsed diff, so it can run in either process.
 */
export const buildPatch = (
  diff: FileDiff,
  selected: LinePredicate,
  reverse: boolean,
): string | null => {
  const hunks: string[] = [];
  // Lines added minus lines removed by the hunks emitted so far.
  let delta = 0;
  let oldTotal = 0;
  let newTotal = 0;

  diff.hunks.forEach((hunk, h) => {
    if (!hunk.lines.some((l, i) => (l.kind === "add" || l.kind === "del") && selected(h, i))) {
      return;
    }
    const raw: PatchLine[] = [];
    const emit = (sign: PatchLine["sign"], l: Line) =>
      raw.push({ sign, text: l.text, meta: l.meta });
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
    const body = placeNewlineMarkers(raw);

    let oldCount = 0;
    let newCount = 0;
    for (const l of body) {
      if (l.sign !== "+") oldCount++;
      if (l.sign !== "-") newCount++;
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
    oldTotal += oldCount;
    newTotal += newCount;
    hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const l of body) {
      hunks.push(l.sign + l.text);
      if (l.meta !== null) hunks.push(`\\ ${l.meta}`);
    }
  });

  if (hunks.length === 0) return null;
  // A created or deleted file has a single hunk, so an empty side covers the whole file.
  const creates = diff.created === true && oldTotal === 0;
  const deletes = diff.deleted === true && newTotal === 0;
  return [...fileHeader(diff, creates, deletes), ...hunks].join("\n") + "\n";
};

/** Builds a patch containing a whole hunk, for applying with `reverse` as given. */
export const hunkPatch = (diff: FileDiff, hunk: number, reverse: boolean): string =>
  buildPatch(diff, (h) => h === hunk, reverse)!;
