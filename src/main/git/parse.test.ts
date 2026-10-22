import { describe, expect, it } from "vitest";
import {
  parseCommitShow,
  parseDiff,
  parseFileVersions,
  parseRawChanges,
  parseRefs,
  parseRemotes,
  parseStatus,
  parseSubmodules,
  parseWorktrees,
  pushRemoteOf,
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
    expect(s.conflicted.map((f) => [f.path, f.conflict])).toEqual([["conflict.txt", "UU"]]);
  });

  it("keeps conflict codes and skips submodules with only changes inside them", () => {
    const out = [
      "u UD N... 100644 100644 000000 100644 a b c gone.txt",
      "1 .M S..U 160000 160000 160000 aaa aaa sub-untracked",
      "1 .M S.M. 160000 160000 160000 aaa aaa sub-dirty",
      "1 .M SC.. 160000 160000 160000 aaa bbb sub-moved",
      "",
    ].join("\0");
    const s = parseStatus(out);
    expect(s.conflicted.map((f) => [f.path, f.conflict])).toEqual([["gone.txt", "UD"]]);
    expect(s.unstaged.map((f) => f.path)).toEqual(["sub-moved"]);
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

  it("finds remotes whose names contain a slash", () => {
    const out = ["refs/remotes/team/up/main\0a1", "refs/remotes/team/x\0a2"].join("\n");
    expect(parseRefs(out, ["team", "team/up"]).map((r) => r.remote)).toEqual(["team/up", "team"]);
  });
});

describe("parseSubmodules", () => {
  it("reads paths with spaces, with and without a description", () => {
    const h = "0123456789012345678901234567890123456789";
    const out = [
      ` ${h} my lib (heads/main)`,
      `-${h} not yet`,
      `+${h} moved (v1-2-g${h.slice(0, 7)})`,
    ];
    expect(parseSubmodules(out.join("\n"))).toEqual([
      { hash: h, path: "my lib", status: "ok" },
      { hash: h, path: "not yet", status: "uninitialized" },
      { hash: h, path: "moved", status: "modified" },
    ]);
  });
});

describe("commit files", () => {
  const raw = [
    ":100644 100644 aaa bbb M",
    "a.txt",
    ":100644 100644 ccc ddd R090",
    "old.bin",
    "new.bin",
    ":000000 100644 000 eee A",
    "c.txt",
    "3\t1\ta.txt",
    "-\t-\t",
    "old.bin",
    "new.bin",
    "1\t0\tc.txt",
    "",
  ].join("\0");

  it("reads raw changes with their line counts", () => {
    const { files, total } = parseRawChanges(`\n${raw}`);
    expect(total).toBe(3);
    expect(files.map((f) => [f.path, f.kind, f.oldPath, f.additions, f.binary])).toEqual([
      ["a.txt", "modified", null, 3, false],
      ["new.bin", "renamed", "old.bin", null, true],
      ["c.txt", "added", null, 1, false],
    ]);
  });

  it("lists at most `limit` files but counts them all", () => {
    const { files, total } = parseRawChanges(raw, 2);
    expect(files.map((f) => f.path)).toEqual(["a.txt", "new.bin"]);
    expect(total).toBe(3);
  });

  it("reads a commit and its changes from one show command", () => {
    const out = [
      "h1",
      "p1 p2",
      "Ann",
      "a@x",
      "10",
      "Bob",
      "b@x",
      "11",
      "Subject\n\n#42 is fixed\n",
      `\n${raw}`,
    ].join("\0");
    const c = parseCommitShow(out);
    expect(c).toMatchObject({
      hash: "h1",
      parents: ["p1", "p2"],
      author: { name: "Ann", email: "a@x", time: 10 },
      committer: { name: "Bob", email: "b@x", time: 11 },
      message: "Subject\n\n#42 is fixed\n",
    });
    expect(c.changes.files.map((f) => f.path)).toEqual(["a.txt", "new.bin", "c.txt"]);
    // A root commit with no files, and malformed output.
    expect(parseCommitShow("h\0\0A\0a\x001\0B\0b\x002\0m\0\0").parents).toEqual([]);
    expect(() => parseCommitShow("h\0p")).toThrow(/Malformed/);
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
    expect(d.readOnly).toBeUndefined();
    expect([d.created, d.deleted, d.mode]).toEqual([undefined, undefined, undefined]);
  });

  const lines = (...l: string[]) => [...l, ""].join("\n");

  it("reads created and deleted files and their modes", () => {
    const created = parseDiff(
      lines(
        "diff --git a/n b/n",
        "new file mode 100755",
        "index 0000000..e69de29",
        "--- /dev/null",
        "+++ b/n",
        "@@ -0,0 +1 @@",
        "+x",
      ),
      "n",
      null,
      false,
    );
    expect(created).toMatchObject({ created: true, mode: "100755" });
    expect(created.deleted).toBeUndefined();
    // An empty file has no hunks.
    const deleted = parseDiff(
      lines("diff --git a/e b/e", "deleted file mode 100644", "index e69de29..0000000"),
      "e",
      null,
      false,
    );
    expect(deleted).toMatchObject({ deleted: true, mode: "100644", hunks: [] });
  });

  it("keeps the section of the path when the output has several", () => {
    // A staged rename below the similarity threshold: a deletion and an addition.
    const text = lines(
      "diff --git a/old name b/old name",
      "deleted file mode 100644",
      "--- a/old name\t",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "diff --git a/new name b/new name",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new name\t",
      "@@ -0,0 +1 @@",
      "+here",
    );
    const d = parseDiff(text, "new name", "old name", false);
    expect(d.hunks.flatMap((h) => h.lines.map((l) => l.text))).toEqual(["here"]);
    expect(d.created).toBe(true);
    expect(parseDiff(text, "old name", null, false).deleted).toBe(true);
  });

  it("shows a conflicted file's combined diff against ours, read-only", () => {
    const text = lines(
      "diff --cc f.txt",
      "index 1111111,2222222..0000000",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@@ -1,3 -1,3 +1,6 @@@",
      "  same",
      "++<<<<<<< HEAD",
      " +ours",
      "++=======",
      "+ theirs",
      "++>>>>>>> side",
      // Only in ours, and only in theirs: neither is in the result.
      "- old",
      " -their old",
    );
    const d = parseDiff(text, "f.txt", null, false);
    expect(d.readOnly).toBe("conflict");
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 6 });
    expect(d.hunks[0]!.lines.map((l) => [l.kind, l.oldNo, l.newNo, l.text])).toEqual([
      ["context", 1, 1, "same"],
      ["add", null, 2, "<<<<<<< HEAD"],
      ["context", 2, 3, "ours"],
      ["add", null, 4, "======="],
      ["add", null, 5, "theirs"],
      ["add", null, 6, ">>>>>>> side"],
      ["del", 3, null, "old"],
    ]);
    // The staged side of a conflicted file has no diff.
    expect(parseDiff("* Unmerged path f.txt\n", "f.txt", null, false)).toMatchObject({
      hunks: [],
      readOnly: "conflict",
    });
  });

  it("marks submodules read-only", () => {
    const d = parseDiff(
      lines(
        "diff --git a/sub b/sub",
        "index 1111111..2222222 160000",
        "--- a/sub",
        "+++ b/sub",
        "@@ -1 +1 @@",
        "-Subproject commit 1111111",
        "+Subproject commit 2222222",
      ),
      "sub",
      null,
      false,
    );
    expect(d.readOnly).toBe("submodule");
  });

  it("marks text that is not UTF-8 read-only", () => {
    const head = new TextEncoder().encode(lines("--- a/f", "+++ b/f", "@@ -0,0 +1 @@", "+caf"));
    const bytes = new Uint8Array([...head.subarray(0, -1), 0xe9, 10]);
    const d = parseDiff(bytes, "f", null, false);
    expect(d.readOnly).toBe("encoding");
    expect(d.hunks[0]!.lines[0]!.text).toBe("caf�");
    expect(parseDiff(head, "f", null, false).readOnly).toBeUndefined();
  });

  it("drops the incomplete last hunk of a truncated diff", () => {
    const text = lines(
      "--- a/f",
      "+++ b/f",
      "@@ -1,2 +1,2 @@",
      "-a",
      "+A",
      " b",
      "@@ -10,3 +10,3 @@",
      " x",
      "-y",
    );
    // The cut can fall inside a line and inside a UTF-8 sequence.
    const bytes = new TextEncoder().encode(`${text}+é`).subarray(0, -1);
    const d = parseDiff(bytes, "f", null, true);
    expect(d.truncated).toBe(true);
    expect(d.readOnly).toBeUndefined();
    expect(d.hunks.map((h) => h.oldStart)).toEqual([1]);
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
      "partial\thttps://h/p.git (fetch) [blob:none]",
      "partial\thttps://h/p.git (push)",
      "",
    ].join("\n");
    expect(parseRemotes(out)).toEqual([
      { name: "origin", fetchUrl: "git@github.com:a/b.git", pushUrl: "git@github.com:a/b.git" },
      { name: "local", fetchUrl: "/srv/my repos/b.git", pushUrl: "ssh://host/b.git" },
      { name: "partial", fetchUrl: "https://h/p.git", pushUrl: "https://h/p.git" },
    ]);
  });
});

describe("pushRemoteOf", () => {
  const remotes = ["upstream", "origin", "fork"];
  it("prefers the branch's push remote, then the default one, then origin", () => {
    const config = [
      "user.name T",
      "remote.pushdefault upstream",
      "branch.Topic.pushremote fork",
      "branch.other.pushremote upstream",
    ].join("\n");
    expect(pushRemoteOf(config, remotes, "Topic")).toBe("fork");
    expect(pushRemoteOf(config, remotes, "main")).toBe("upstream");
    expect(pushRemoteOf(config, remotes, null)).toBe("upstream");
    expect(pushRemoteOf("", remotes, "main")).toBe("origin");
    expect(pushRemoteOf("", ["b", "a"], "main")).toBe("b");
    expect(pushRemoteOf("", [], "main")).toBeNull();
  });

  it("takes the last value and skips settings naming no remote", () => {
    const config = [
      "remote.pushdefault fork",
      "remote.pushdefault upstream",
      "branch.main.pushremote gone",
    ].join("\n");
    expect(pushRemoteOf(config, remotes, "main")).toBe("upstream");
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
