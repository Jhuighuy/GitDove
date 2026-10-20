import { describe, expect, it } from "vitest";
import { type FileChange, renameSource } from "./domain";

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
