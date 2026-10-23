import { describe, expect, it } from "vitest";
import type { DiffLine, FileDiff } from "../domain";
import { conflictPart, findConflicts, resolvePatch } from "./conflicts";

/** A conflicted file's diff with one hunk; lines are `[kind, text]`, numbered from `start`. */
const conflicted = (start: number, ...lines: [DiffLine["kind"], string][]): FileDiff => {
  let oldNo = start;
  let newNo = start;
  const out = lines.map(([kind, text]): DiffLine => {
    if (kind === "del") return { kind, oldNo: oldNo++, newNo: null, text };
    if (kind === "add") return { kind, oldNo: null, newNo: newNo++, text };
    if (kind === "meta") return { kind, oldNo: null, newNo: null, text };
    return { kind, oldNo: oldNo++, newNo: newNo++, text };
  });
  return {
    path: "f.txt",
    oldPath: null,
    binary: false,
    truncated: false,
    readOnly: "conflict",
    hunks: [
      {
        header: "@@@",
        oldStart: start,
        oldLines: oldNo - start,
        newStart: start,
        newLines: newNo - start,
        lines: out,
      },
    ],
  };
};

const SIMPLE: [DiffLine["kind"], string][] = [
  ["context", "a"],
  ["add", "<<<<<<< HEAD"],
  ["context", "ours"],
  ["add", "======="],
  ["add", "theirs"],
  ["add", ">>>>>>> side"],
  ["del", "gone"],
  ["context", "z"],
];

describe("findConflicts", () => {
  it("finds blocks of markers, with or without a base section", () => {
    const d = conflicted(
      1,
      ...SIMPLE,
      ["add", "<<<<<<< HEAD"],
      ["add", "x"],
      ["add", "||||||| base"],
      ["add", "y"],
      ["add", "======="],
      ["add", ">>>>>>> 0123abc (Subject)"],
    );
    expect(findConflicts(d)).toEqual([
      { hunk: 0, start: 1, base: -1, separator: 3, end: 5, current: "HEAD", incoming: "side" },
      {
        hunk: 0,
        start: 8,
        base: 10,
        separator: 12,
        end: 13,
        current: "HEAD",
        incoming: "0123abc (Subject)",
      },
    ]);
  });

  it("only looks in conflicted files", () => {
    const { readOnly: _, ...plain } = conflicted(1, ...SIMPLE);
    expect(findConflicts(plain)).toEqual([]);
  });

  it("takes markers of other sizes, unlabeled ones and CRLF line ends", () => {
    const d = conflicted(
      1,
      ["add", "<<<<<<<<<\r"],
      ["add", "=======\r"],
      ["add", "=========\r"],
      ["add", ">>>>>>>>> b\r"],
    );
    expect(findConflicts(d)).toEqual([
      { hunk: 0, start: 0, base: -1, separator: 2, end: 3, current: "", incoming: "b" },
    ]);
  });

  it("takes the shorter markers of a smaller conflict-marker-size", () => {
    const d = conflicted(1, ["add", "<<< HEAD"], ["add", "==="], ["add", ">>> side"]);
    expect(findConflicts(d)).toMatchObject([{ start: 0, separator: 1, end: 2 }]);
  });

  it("skips blocks that are cut short or broken", () => {
    const d = conflicted(
      1,
      // A start marker without an end, then a complete block.
      ["add", "<<<<<<< HEAD"],
      ["add", "<<<<<<< HEAD"],
      ["add", "======="],
      ["add", ">>>>>>> side"],
      // No separator; then a block cut short.
      ["add", "<<<<<<< HEAD"],
      ["add", ">>>>>>> side"],
      ["add", "<<<<<<<< HEAD"],
      ["add", "========"],
    );
    expect(findConflicts(d).map((c) => [c.start, c.end])).toEqual([[1, 3]]);
  });

  it("names the parts of a block", () => {
    const d = conflicted(
      1,
      ["add", "<<<<<<< HEAD"],
      ["add", "ours"],
      ["add", "||||||| base"],
      ["add", "base"],
      ["add", "======="],
      ["add", "theirs"],
      ["add", ">>>>>>> side"],
      ["context", "after"],
    );
    const [c] = findConflicts(d);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => conflictPart(c!, i))).toEqual([
      "marker",
      "current",
      "marker",
      "base",
      "marker",
      "incoming",
      "marker",
      null,
    ]);
  });
});

describe("resolvePatch", () => {
  const header = "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n";

  it("keeps the side chosen, with the rest of the hunk as context", () => {
    const d = conflicted(4, ...SIMPLE);
    const [c] = findConflicts(d);
    const patch = (choice: "current" | "incoming" | "both") =>
      resolvePatch(d, [{ conflict: c!, choice }]);
    // Lines not in the working tree ("gone") are left out.
    expect(patch("current")).toBe(
      header + "@@ -4,7 +4,3 @@\n a\n-<<<<<<< HEAD\n ours\n-=======\n-theirs\n->>>>>>> side\n z\n",
    );
    expect(patch("incoming")).toBe(
      header + "@@ -4,7 +4,3 @@\n a\n-<<<<<<< HEAD\n-ours\n-=======\n theirs\n->>>>>>> side\n z\n",
    );
    expect(patch("both")).toBe(
      header + "@@ -4,7 +4,4 @@\n a\n-<<<<<<< HEAD\n ours\n-=======\n theirs\n->>>>>>> side\n z\n",
    );
  });

  it("keeps the end of a file without a final newline", () => {
    const d = conflicted(
      1,
      ["add", "<<<<<<< HEAD"],
      ["context", "ours"],
      ["add", "======="],
      ["add", "theirs"],
      ["add", ">>>>>>> side"],
      ["context", "end"],
      ["meta", "No newline at end of file"],
    );
    const [c] = findConflicts(d);
    expect(resolvePatch(d, [{ conflict: c!, choice: "current" }])).toBe(
      header +
        "@@ -1,6 +1,2 @@\n-<<<<<<< HEAD\n ours\n-=======\n-theirs\n->>>>>>> side\n end\n" +
        "\\ No newline at end of file\n",
    );
  });

  it("resolves several blocks, across hunks", () => {
    const one = conflicted(1, ...SIMPLE);
    const two = conflicted(20, ["add", "<<<<<<< HEAD"], ["add", "======="], ["add", ">>>>>>> b"]);
    const d: FileDiff = { ...one, hunks: [...one.hunks, ...two.hunks] };
    const choices = findConflicts(d).map((conflict) => ({ conflict, choice: "incoming" as const }));
    expect(choices).toHaveLength(2);
    expect(resolvePatch(d, choices)).toBe(
      header +
        "@@ -1,7 +1,3 @@\n a\n-<<<<<<< HEAD\n-ours\n-=======\n theirs\n->>>>>>> side\n z\n" +
        "@@ -20,3 +15,0 @@\n-<<<<<<< HEAD\n-=======\n->>>>>>> b\n",
    );
    expect(resolvePatch(d, [])).toBeNull();
  });
});
