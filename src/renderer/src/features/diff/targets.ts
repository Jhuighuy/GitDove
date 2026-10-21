import {
  type DiffTarget,
  type FileChange,
  type RepoId,
  renameSource,
  type WorkingStatus,
} from "@shared/domain";
import { useMemo } from "react";
import { useCommitDetails, useCompare, useStatus } from "@/lib/queries";

/** A list of changed files that diffs are opened from. */
export type FileSource =
  | { readonly kind: "unstaged" }
  | { readonly kind: "staged" }
  /** A commit's files, or with `base`, those changed from `base` to the commit. */
  | { readonly kind: "commit"; readonly hash: string; readonly base?: string };

/** The diff of `file` in `source`. */
export const fileTarget = (source: FileSource, file: FileChange): DiffTarget => {
  switch (source.kind) {
    case "unstaged":
      return { kind: "unstaged", path: file.path, untracked: file.kind === "untracked" };
    case "staged":
      return { kind: "staged", path: file.path, ...renameSource(file) };
    case "commit":
      return {
        kind: "commit",
        hash: source.hash,
        ...(source.base === undefined ? {} : { base: source.base }),
        path: file.path,
        ...renameSource(file),
      };
  }
};

/** The file `step` places after (or before, when negative) `target` in its list, if any. */
export const stepTarget = (
  files: readonly FileChange[],
  source: FileSource,
  target: DiffTarget,
  step: number,
): DiffTarget | null => {
  const i = files.findIndex((f) => f.path === target.path);
  if (i < 0) return null;
  const next = files[i + step];
  return next ? fileTarget(source, next) : null;
};

/** The most files of each working tree list (unstaged, staged) that the WIP panel shows. */
export const MAX_LISTED_FILES = 3000;

/**
 * The working tree files the WIP panel lists for `kind`: the staged ones, or the conflicts and
 * then the unstaged ones.
 */
export const workingFiles = (
  status: WorkingStatus,
  kind: "staged" | "unstaged",
): readonly FileChange[] => {
  if (kind === "staged") return status.staged.slice(0, MAX_LISTED_FILES);
  const seen = new Set(status.conflicted.map((f) => f.path));
  const unstaged = status.unstaged.slice(0, MAX_LISTED_FILES).filter((f) => !seen.has(f.path));
  return [...status.conflicted, ...unstaged];
};

const sourceOf = (target: DiffTarget): FileSource =>
  target.kind === "commit"
    ? {
        kind: "commit",
        hash: target.hash,
        ...(target.base === undefined ? {} : { base: target.base }),
      }
    : { kind: target.kind };

/**
 * The files listed alongside `target`, in the order the details panel shows them: a commit's
 * (or a range of commits') files, or the working tree's unstaged (conflicts first) or staged ones.
 */
export function useSiblingFiles(
  repo: RepoId,
  target: DiffTarget,
): { readonly source: FileSource; readonly files: readonly FileChange[] } {
  const commitHash = target.kind === "commit" ? target.hash : null;
  const base = target.kind === "commit" ? target.base : undefined;
  const commit = useCommitDetails(repo, base === undefined ? commitHash : null).data;
  const range = useCompare(repo, base ?? null, base === undefined ? null : commitHash).data;
  const listed = base === undefined ? commit : range;
  const status = useStatus(repo).data;
  const source = useMemo(() => sourceOf(target), [target]);
  const files = useMemo((): readonly FileChange[] => {
    if (source.kind === "commit") return listed?.files ?? [];
    return status ? workingFiles(status, source.kind) : [];
  }, [source, listed, status]);
  return { source, files };
}
