import type { FileChange } from "@shared/domain";
import { expect, it, vi } from "vitest";
import { fileTarget, MAX_LISTED_FILES, stepTarget, workingFiles } from "./targets";

vi.mock("@/lib/queries", () => ({}));

const file = (path: string, extra: Partial<FileChange> = {}): FileChange => ({
  path,
  oldPath: null,
  kind: "modified",
  additions: null,
  deletions: null,
  binary: false,
  ...extra,
});

it("builds the diff of a file in its list", () => {
  const renamed = file("b", { kind: "renamed", oldPath: "a" });
  expect(fileTarget({ kind: "commit", hash: "h" }, renamed)).toEqual({
    kind: "commit",
    hash: "h",
    path: "b",
    oldPath: "a",
  });
  expect(fileTarget({ kind: "staged" }, renamed)).toEqual({
    kind: "staged",
    path: "b",
    oldPath: "a",
  });
  expect(fileTarget({ kind: "unstaged" }, file("u", { kind: "untracked" }))).toEqual({
    kind: "unstaged",
    path: "u",
    untracked: true,
  });
});

it("steps to the next or previous file, and stops at the ends", () => {
  const files = [file("a"), file("b"), file("c")];
  const source = { kind: "staged" } as const;
  const at = (path: string) => fileTarget(source, file(path));
  expect(stepTarget(files, source, at("a"), 1)).toEqual(at("b"));
  expect(stepTarget(files, source, at("b"), -1)).toEqual(at("a"));
  expect(stepTarget(files, source, at("c"), 1)).toBeNull();
  expect(stepTarget(files, source, at("a"), -1)).toBeNull();
  // A file that is gone from the list (e.g. just staged) has no neighbors.
  expect(stepTarget(files, source, at("x"), 1)).toBeNull();
});

it("steps only through the working tree files the WIP panel lists", () => {
  const many = Array.from({ length: MAX_LISTED_FILES + 1 }, (_, i) => file(`f${i}`));
  const status = { staged: many, unstaged: many, conflicted: [file("c")], truncated: false };
  const last = file(`f${MAX_LISTED_FILES - 1}`);
  for (const kind of ["staged", "unstaged"] as const) {
    const files = workingFiles(status, kind);
    expect(files.at(-1)).toEqual(last);
    expect(stepTarget(files, { kind }, fileTarget({ kind }, last), 1)).toBeNull();
  }
  // Conflicts come first, and are not counted against the limit.
  expect(workingFiles(status, "unstaged")).toHaveLength(MAX_LISTED_FILES + 1);
  expect(workingFiles(status, "unstaged")[0]).toEqual(file("c"));
});
