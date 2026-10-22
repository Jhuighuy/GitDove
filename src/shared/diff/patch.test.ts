import type { FileDiff } from "@shared/domain";
import { describe, expect, it } from "vitest";
import { parseDiff } from "../../main/git/parse";
import { buildPatch, hunkPatch, quotePath } from "./patch";

const diffOf = (lines: string[]): FileDiff =>
  parseDiff(
    ["diff --git a/f b/f", "--- a/f", "+++ b/f", ...lines, ""].join("\n"),
    "f",
    null,
    false,
  );

/** Selects lines by "hunk:line" keys. */
const pick =
  (...keys: string[]) =>
  (h: number, i: number) =>
    keys.includes(`${h}:${i}`);

const body = (patch: string | null) => patch!.split("\n").slice(3, -1);

describe("quotePath", () => {
  it("leaves plain paths alone", () => {
    expect(quotePath("a/", "src/x y.ts")).toBe("a/src/x y.ts");
  });
  it("C-quotes special characters", () => {
    expect(quotePath("b/", 'q"\\\tü')).toBe('"b/q\\"\\\\\\t\\303\\274"');
  });
});

describe("buildPatch", () => {
  const diff = diffOf([
    "@@ -1,4 +1,4 @@ fn",
    " one",
    "-two",
    "-three",
    "+deux",
    "+trois",
    " four",
    "@@ -10,2 +10,3 @@",
    " ten",
    "+ten and a half",
    " eleven",
  ]);

  it("returns null when nothing is selected", () => {
    expect(buildPatch(diff, () => false, false)).toBeNull();
    // Context lines do not count as a selection.
    expect(buildPatch(diff, pick("0:0"), false)).toBeNull();
  });

  it("reproduces a whole hunk", () => {
    expect(body(hunkPatch(diff, 0, false))).toEqual([
      "@@ -1,4 +1,4 @@",
      " one",
      "-two",
      "-three",
      "+deux",
      "+trois",
      " four",
    ]);
    expect(body(hunkPatch(diff, 1, true))).toEqual([
      "@@ -10,2 +10,3 @@",
      " ten",
      "+ten and a half",
      " eleven",
    ]);
  });

  it("stages selected lines: unselected deletions become context, additions vanish", () => {
    expect(body(buildPatch(diff, pick("0:1", "0:3"), false))).toEqual([
      "@@ -1,4 +1,4 @@",
      " one",
      "-two",
      "+deux",
      " three",
      " four",
    ]);
  });

  it("unstages selected lines: unselected additions become context, deletions vanish", () => {
    expect(body(buildPatch(diff, pick("0:2", "0:4"), true))).toEqual([
      "@@ -1,4 +1,4 @@",
      " one",
      " deux",
      "-three",
      "+trois",
      " four",
    ]);
  });

  it("shifts later hunks by the lines earlier hunks add", () => {
    // Forward: hunk 0 adds two lines and removes none, so hunk 1 moves down by two.
    expect(body(buildPatch(diff, pick("0:3", "0:4", "1:1"), false))).toEqual([
      "@@ -1,4 +1,6 @@",
      " one",
      " two",
      " three",
      "+deux",
      "+trois",
      " four",
      "@@ -10,2 +12,3 @@",
      " ten",
      "+ten and a half",
      " eleven",
    ]);
    // Reverse: the new side is fixed and the old side shifts back.
    expect(body(buildPatch(diff, pick("0:1", "0:2", "1:1"), true))).toEqual([
      "@@ -1,6 +1,4 @@",
      " one",
      " deux",
      " trois",
      "-two",
      "-three",
      " four",
      "@@ -12,2 +10,3 @@",
      " ten",
      "+ten and a half",
      " eleven",
    ]);
  });

  it("uses the line before for empty ranges", () => {
    const created = diffOf(["@@ -0,0 +1,2 @@", "+a", "+b"]);
    expect(body(buildPatch(created, pick("0:1"), false))).toEqual(["@@ -0,0 +1,1 @@", "+b"]);
    const removed = diffOf(["@@ -1,2 +0,0 @@", "-a", "-b"]);
    expect(body(buildPatch(removed, pick("0:0", "0:1"), false))).toEqual([
      "@@ -1,2 +0,0 @@",
      "-a",
      "-b",
    ]);
  });

  it("keeps a missing newline marker only after kept lines", () => {
    const d = diffOf([
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "\\ No newline at end of file",
      "+c",
      "\\ No newline at end of file",
    ]);
    expect(body(buildPatch(d, pick("0:1"), false))).toEqual([
      "@@ -1,2 +1,1 @@",
      " a",
      "-b",
      "\\ No newline at end of file",
    ]);
    // Only the addition: the old last line has to gain its newline.
    expect(body(buildPatch(d, pick("0:3"), false))).toEqual([
      "@@ -1,2 +1,3 @@",
      " a",
      "-b",
      "\\ No newline at end of file",
      "+b",
      "+c",
      "\\ No newline at end of file",
    ]);
  });

  it("moves a missing newline marker to the side that still ends with the line", () => {
    // A file without a final newline gets lines appended.
    const d = diffOf([
      "@@ -1,2 +1,4 @@",
      " a",
      "-last",
      "\\ No newline at end of file",
      "+last",
      "+new1",
      "+new2",
    ]);
    // Discarding the rewrite of `last` keeps the appended lines, which follow it on both sides.
    expect(body(buildPatch(d, pick("0:1", "0:3"), true))).toEqual([
      "@@ -1,4 +1,4 @@",
      " a",
      "-last",
      "+last",
      " new1",
      " new2",
    ]);
    // Discarding only the appended lines keeps the rewritten `last`, with its newline.
    expect(body(buildPatch(d, pick("0:4", "0:5"), true))).toEqual([
      "@@ -1,2 +1,4 @@",
      " a",
      " last",
      "+new1",
      "+new2",
    ]);
    // Staging only the first appended line: the old side still ends with `last`.
    expect(body(buildPatch(d, pick("0:4"), false))).toEqual([
      "@@ -1,2 +1,3 @@",
      " a",
      "-last",
      "\\ No newline at end of file",
      "+last",
      "+new1",
    ]);
    // An unselected deletion kept as context ends the old side, but the new side goes on.
    const replaced = diffOf([
      "@@ -1,2 +1,1 @@",
      "-d1",
      "-d2",
      "\\ No newline at end of file",
      "+x",
      "\\ No newline at end of file",
    ]);
    expect(body(buildPatch(replaced, pick("0:3"), false))).toEqual([
      "@@ -1,2 +1,3 @@",
      " d1",
      "-d2",
      "\\ No newline at end of file",
      "+d2",
      "+x",
      "\\ No newline at end of file",
    ]);
  });

  it("creates and deletes whole files", () => {
    const created = { ...diffOf(["@@ -0,0 +1,2 @@", "+a", "+b"]), created: true, mode: "100755" };
    // Staging part of a new file creates it with those lines.
    expect(buildPatch(created, pick("0:1"), false)!.split("\n")).toEqual([
      "diff --git a/f b/f",
      "new file mode 100755",
      "--- /dev/null",
      "+++ b/f",
      "@@ -0,0 +1,1 @@",
      "+b",
      "",
    ]);
    // Unstaging all of it removes it; unstaging part of it keeps the file.
    expect(hunkPatch(created, 0, true).split("\n").slice(1, 3)).toEqual([
      "new file mode 100755",
      "--- /dev/null",
    ]);
    expect(buildPatch(created, pick("0:0"), true)!.split("\n").slice(1, 3)).toEqual([
      "--- a/f",
      "+++ b/f",
    ]);

    const deleted = { ...diffOf(["@@ -1,2 +0,0 @@", "-a", "-b"]), deleted: true, mode: "100644" };
    expect(hunkPatch(deleted, 0, false).split("\n").slice(1, 4)).toEqual([
      "deleted file mode 100644",
      "--- a/f",
      "+++ /dev/null",
    ]);
    expect(buildPatch(deleted, pick("0:0"), false)!.split("\n").slice(1, 3)).toEqual([
      "--- a/f",
      "+++ b/f",
    ]);
    // Restoring part of a deleted file recreates it with those lines.
    expect(buildPatch(deleted, pick("0:0"), true)!.split("\n").slice(1)).toEqual([
      "deleted file mode 100644",
      "--- a/f",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-a",
      "",
    ]);
  });

  it("quotes unusual paths in headers", () => {
    const d = { ...diffOf(["@@ -1 +1 @@", "-a", "+b"]), path: "dir/new name", oldPath: "ö" };
    expect(
      buildPatch(d, () => true, false)!
        .split("\n")
        .slice(0, 3),
    ).toEqual([
      'diff --git "a/\\303\\266" b/dir/new name',
      '--- "a/\\303\\266"',
      "+++ b/dir/new name\t",
    ]);
  });
});
