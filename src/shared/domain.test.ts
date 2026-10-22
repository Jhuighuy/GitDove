import { describe, expect, it } from "vitest";
import { type FileChange, renameSource, repoIdOf, repoLocationOf } from "./domain";

describe("renameSource", () => {
  const change = (kind: FileChange["kind"], oldPath: string | null): FileChange => ({
    path: "new.png",
    oldPath,
    kind,
    additions: null,
    deletions: null,
    binary: true,
  });

  it("keeps the source of renames only", () => {
    expect(renameSource(change("renamed", "old.png"))).toEqual({ oldPath: "old.png" });
    expect(renameSource(change("copied", "old.png"))).toEqual({});
    expect(renameSource(change("modified", null))).toEqual({});
  });
});

describe("repository ids", () => {
  it("round-trip locations, also with newlines in the path", () => {
    for (const loc of [
      { kind: "local", path: "/a/b" },
      { kind: "local", path: "/a\nb" },
      { kind: "ssh", host: "fedora", path: "/srv/x" },
      { kind: "ssh", host: "fedora", path: "/srv/new\nline" },
    ] as const) {
      expect(repoLocationOf(repoIdOf(loc))).toEqual(loc);
    }
    expect(() => repoLocationOf("ssh://fedora")).toThrow("Invalid repository id");
  });
});
