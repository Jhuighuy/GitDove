import { describe, expect, it } from "vitest";
import {
  parseDiff,
  parseFileVersions,
  parseNameStatus,
  parseNumstat,
  parseRefs,
  parseRemotes,
  parseWorktrees,
  parseStatus,
} from "./parse";

describe("parseStatus", () => {
  it("splits staged, unstaged, untracked and renamed entries", () => {
    const out = [
      "1 M. N... 100644 100644 100644 aaa bbb staged.txt",
      "1 .M N... 100644 100644 100644 aaa bbb dir/with space.txt",
      "2 R. N... 100644 100644 100644 aaa bbb R100 new.txt",
      "old.txt",
      "? untracked.txt",
      "u UU N... 100644 100644 100644 100644 a b c conflict.txt",
      "",
    ].join("\0");
    const s = parseStatus(out);
    expect(s.staged.map((f) => [f.path, f.kind, f.oldPath])).toEqual([
      ["new.txt", "renamed", "old.txt"],
      ["staged.txt", "modified", null],
    ]);
    expect(s.unstaged.map((f) => [f.path, f.kind])).toEqual([
      ["dir/with space.txt", "modified"],
      ["untracked.txt", "untracked"],
    ]);
    expect(s.conflicted.map((f) => f.path)).toEqual(["conflict.txt"]);
  });
});

describe("parseRefs", () => {
  it("parses branches with tracking info and skips symrefs", () => {
    const line = (...f: string[]) => f.join("\0");
    const out = [
      line("refs/heads/main", "a1", "", "refs/remotes/origin/main", "ahead 2, behind 1", "*", ""),
      line("refs/remotes/origin/HEAD", "a1", "", "", "", " ", "refs/remotes/origin/main"),
      line("refs/remotes/origin/main", "a0", "", "", "", " ", ""),
      line("refs/tags/v1", "t1", "c1", "", "", " ", ""),
    ].join("\n");
    const refs = parseRefs(out);
    expect(refs).toHaveLength(3);
    expect(refs[0]).toMatchObject({ short: "main", ahead: 2, behind: 1, isHead: true });
    expect(refs[1]).toMatchObject({ kind: "remote", remote: "origin", short: "origin/main" });
    expect(refs[2]).toMatchObject({ kind: "tag", hash: "c1" });
  });
});

describe("commit files", () => {
  it("parses name-status and numstat with renames", () => {
    const ns = ["M", "a.txt", "R090", "old.txt", "new.txt", ""].join("\0");
    expect(parseNameStatus(ns).map((f) => [f.path, f.kind, f.oldPath])).toEqual([
      ["a.txt", "modified", null],
      ["new.txt", "renamed", "old.txt"],
    ]);
    const num = ["3\t1\ta.txt", "-\t-\t", "old.bin", "new.bin", ""].join("\0");
    const m = parseNumstat(num);
    expect(m.get("a.txt")).toEqual({ additions: 3, deletions: 1 });
    expect(m.get("new.bin")).toEqual({ additions: null, deletions: null });
  });
});

describe("parseDiff", () => {
  it("numbers lines across hunks", () => {
    const text = [
      "diff --git a/f b/f",
      "--- a/f",
      "+++ b/f",
      "@@ -1,2 +1,3 @@ fn",
      " one",
      "-two",
      "+deux",
      "+trois",
      "@@ -10 +11 @@",
      "-x",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const d = parseDiff(text, "f", null, false);
    expect(d.hunks).toHaveLength(2);
    expect(d.hunks[0]!.lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ["context", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["add", null, 3],
    ]);
    expect(d.hunks[1]).toMatchObject({ oldStart: 10, oldLines: 1, newStart: 11, newLines: 1 });
    expect(d.hunks[1]!.lines[1]!.kind).toBe("meta");
  });
});

describe("parseFileVersions", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const dec = (c: { kind: string; bytes?: Uint8Array }) =>
    c.bytes ? new TextDecoder().decode(c.bytes) : c.kind;

  it("splits framed blobs and the trailing working tree file", () => {
    const v = parseFileVersions(enc("blob 4\nab\ncfile\nrest\nof it"), false);
    expect([dec(v.old), dec(v.new)]).toEqual(["ab\nc", "rest\nof it"]);
  });

  it("reads missing and large sides", () => {
    expect(parseFileVersions(enc("missing\nlarge 123\n"), false)).toEqual({
      old: { kind: "missing" },
      new: { kind: "large", size: 123 },
    });
  });

  it("treats a truncated working tree file as large", () => {
    expect(parseFileVersions(enc("missing\nfile\nxyz"), true).new).toEqual({
      kind: "large",
      size: 3,
    });
  });

  it("rejects malformed output", () => {
    expect(() => parseFileVersions(enc("blob 10\nab"), false)).toThrow(/Malformed/);
    expect(() => parseFileVersions(enc("what\n"), false)).toThrow(/Malformed/);
    expect(() => parseFileVersions(enc("missing"), false)).toThrow(/Malformed/);
  });
});

describe("parseRemotes", () => {
  it("pairs fetch and push URLs per remote, including URLs with spaces", () => {
    const out = [
      "origin\tgit@github.com:a/b.git (fetch)",
      "origin\tgit@github.com:a/b.git (push)",
      "local\t/srv/my repos/b.git (fetch)",
      "local\tssh://host/b.git (push)",
      "",
    ].join("\n");
    expect(parseRemotes(out)).toEqual([
      { name: "origin", fetchUrl: "git@github.com:a/b.git", pushUrl: "git@github.com:a/b.git" },
      { name: "local", fetchUrl: "/srv/my repos/b.git", pushUrl: "ssh://host/b.git" },
    ]);
  });
});

describe("parseWorktrees", () => {
  it("reads paths, heads, branches and locks", () => {
    const out = [
      "worktree /repo\nHEAD h0\nbranch refs/heads/main\n",
      "worktree /wt/a\nHEAD h1\ndetached\nlocked\n",
      "worktree /wt/b\nHEAD h2\nbranch refs/heads/b\nlocked moved to a USB drive\n",
      "worktree /wt/c\nHEAD h3\nbranch refs/heads/c\nprunable gitdir file points to non-existent location\n",
    ].join("\n");
    expect(parseWorktrees(out)).toEqual([
      { path: "/repo", hash: "h0", branch: "main", isMain: true, locked: false },
      { path: "/wt/a", hash: "h1", branch: null, isMain: false, locked: true },
      { path: "/wt/b", hash: "h2", branch: "b", isMain: false, locked: true },
      { path: "/wt/c", hash: "h3", branch: "c", isMain: false, locked: false },
    ]);
  });
});
