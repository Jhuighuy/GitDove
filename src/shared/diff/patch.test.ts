import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileDiff } from "@shared/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("buildPatch with git apply", () => {
  let dir: string;
  const git = (args: string[], input?: string) =>
    execFileSync("git", args, { cwd: dir, input, encoding: "utf8" });
  const show = (spec: string) => git(["show", spec]);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gitdove-patch-"));
    git(["init", "-q"]);
    git(["config", "user.name", "T"]);
    git(["config", "user.email", "t@x"]);
    const base = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(dir, "f"), base.join("\n") + "\n");
    git(["add", "f"]);
    git(["commit", "-qm", "init"]);
    const edited = [...base];
    edited.splice(1, 2, "LINE 2", "LINE 3", "inserted");
    edited.splice(25, 1); // line 25
    edited.push("tail 1", "tail 2");
    writeFileSync(join(dir, "f"), edited.join("\n") + "\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const apply = (patch: string, opts: string[]) =>
    git(["apply", "--whitespace=nowarn", "--recount", ...opts, "-"], patch);
  const diff = (args: string[]) => parseDiff(git(["diff", ...args, "--", "f"]), "f", null, false);
  const select = (d: FileDiff, texts: string[]) => (h: number, i: number) =>
    texts.includes(d.hunks[h]!.lines[i]!.text);

  it("stages, unstages and discards individual lines", () => {
    const unstaged = diff([]);
    expect(unstaged.hunks.length).toBeGreaterThan(1);
    // Stage one replacement pair, the deletion near the end and one tail line.
    apply(
      buildPatch(unstaged, select(unstaged, ["line 2", "LINE 2", "line 25", "tail 2"]), false)!,
      ["--cached"],
    );
    const index = show(":f").split("\n");
    expect(index.slice(0, 4)).toEqual(["line 1", "LINE 2", "line 3", "line 4"]);
    expect(index).not.toContain("line 25");
    expect(index).not.toContain("tail 1");
    expect(index.slice(-2)).toEqual(["tail 2", ""]);

    // Unstage the tail line again.
    const staged = diff(["--cached"]);
    apply(buildPatch(staged, select(staged, ["tail 2"]), true)!, ["--cached", "--reverse"]);
    expect(show(":f")).not.toContain("tail");

    // Discard the inserted line from the working tree only.
    const rest = diff([]);
    apply(buildPatch(rest, select(rest, ["inserted"]), true)!, ["--reverse"]);
    const work = readFileSync(join(dir, "f"), "utf8").split("\n");
    expect(work).not.toContain("inserted");
    expect(work).toContain("LINE 3");
    expect(work).toContain("tail 1");
  });
});
