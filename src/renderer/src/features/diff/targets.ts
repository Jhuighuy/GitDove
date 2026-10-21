import { type DiffTarget, type FileChange, type RepoId, renameSource } from "@shared/domain";
import { useMemo } from "react";
import { useCommitDetails, useStatus } from "@/lib/queries";

/** A list of changed files that diffs are opened from. */
export type FileSource =
  | { readonly kind: "unstaged" }
  | { readonly kind: "staged" }
  | { readonly kind: "commit"; readonly hash: string };

/** The diff of `file` in `source`. */
export const fileTarget = (source: FileSource, file: FileChange): DiffTarget => {
  switch (source.kind) {
    case "unstaged":
      return { kind: "unstaged", path: file.path, untracked: file.kind === "untracked" };
    case "staged":
      return { kind: "staged", path: file.path, ...renameSource(file) };
    case "commit":
      return { kind: "commit", hash: source.hash, path: file.path, ...renameSource(file) };
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

const sourceOf = (target: DiffTarget): FileSource =>
  target.kind === "commit" ? { kind: "commit", hash: target.hash } : { kind: target.kind };

/**
 * The files listed alongside `target`, in the order the details panel shows them: a commit's
 * files, or the working tree's unstaged (conflicts first) or staged ones.
 */
export function useSiblingFiles(
  repo: RepoId,
  target: DiffTarget,
): { readonly source: FileSource; readonly files: readonly FileChange[] } {
  const commit = useCommitDetails(repo, target.kind === "commit" ? target.hash : null).data;
  const status = useStatus(repo).data;
  const source = useMemo(() => sourceOf(target), [target]);
  const files = useMemo((): readonly FileChange[] => {
    if (source.kind === "commit") return commit?.files ?? [];
    if (!status) return [];
    if (source.kind === "staged") return status.staged;
    const seen = new Set(status.conflicted.map((f) => f.path));
    return [...status.conflicted, ...status.unstaged.filter((f) => !seen.has(f.path))];
  }, [source, commit, status]);
  return { source, files };
}
