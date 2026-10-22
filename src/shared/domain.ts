/**
 * Domain types shared between the main process and the renderer.
 *
 * Everything here must be structured-clone friendly: plain objects, arrays,
 * strings, numbers and typed arrays only.
 */

// ---------------------------------------------------------------------------
// Repository location
// ---------------------------------------------------------------------------

export type RepoLocation =
  | { readonly kind: "local"; readonly path: string }
  | { readonly kind: "ssh"; readonly host: string; readonly path: string };

/** Canonical, stable string identifier of a repository location. */
export type RepoId = string;

export const repoIdOf = (loc: RepoLocation): RepoId =>
  loc.kind === "local"
    ? `local:${loc.path}`
    : `ssh://${loc.host}${loc.path.startsWith("/") ? "" : "/"}${loc.path}`;

export const repoLocationOf = (id: RepoId): RepoLocation => {
  if (id.startsWith("local:")) return { kind: "local", path: id.slice("local:".length) };
  // `s`: a path may contain newlines.
  const m = /^ssh:\/\/([^/]+)(\/.*)$/s.exec(id);
  if (!m) throw new Error(`Invalid repository id: ${id}`);
  return { kind: "ssh", host: m[1]!, path: m[2]! };
};

export const repoDisplayName = (loc: RepoLocation): string => {
  const parts = loc.path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? loc.path;
};

// ---------------------------------------------------------------------------
// Repository info
// ---------------------------------------------------------------------------

export type RepoState =
  | "clean"
  | "merging"
  | "rebasing"
  | "cherry-picking"
  | "reverting"
  | "bisecting"
  /** Applying patches with `git am`. */
  | "applying";

export interface RepoInfo {
  readonly id: RepoId;
  readonly location: RepoLocation;
  readonly name: string;
  readonly workTree: string;
  readonly gitDir: string;
  readonly bare: boolean;
  readonly head: HeadInfo;
  readonly state: RepoState;
}

export interface HeadInfo {
  /** Short branch name, or null when detached / unborn. */
  readonly branch: string | null;
  /** Commit hash, or null on an unborn branch. */
  readonly hash: string | null;
  readonly detached: boolean;
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

export type RefKind = "branch" | "remote" | "tag" | "stash";

export interface Ref {
  /** Full ref name, e.g. `refs/heads/main`. */
  readonly name: string;
  /** Short display name, e.g. `main` or `origin/main`. */
  readonly short: string;
  readonly kind: RefKind;
  /** Object the ref points at (peeled for annotated tags). */
  readonly hash: string;
  /** Upstream full ref name for local branches. */
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  /** Upstream configured, but the remote branch is gone. */
  readonly upstreamGone: boolean;
  readonly isHead: boolean;
  /** For remote refs: the remote name (e.g. `origin`). */
  readonly remote: string | null;
}

export interface Stash {
  readonly index: number;
  readonly name: string; // stash@{n}
  readonly hash: string;
  readonly message: string;
  readonly time: number;
}

export interface Remote {
  readonly name: string;
  readonly fetchUrl: string;
  readonly pushUrl: string;
}

export interface Worktree {
  readonly path: string;
  readonly hash: string | null;
  readonly branch: string | null;
  readonly isMain: boolean;
  /** Locked with `git worktree lock`: removing it needs force. */
  readonly locked: boolean;
}

export interface Submodule {
  readonly path: string;
  readonly hash: string;
  readonly status: "ok" | "modified" | "uninitialized" | "conflict";
}

/**
 * Who works on each local and remote branch, for the contributor filter. A branch's own commits
 * are those that are neither on a default branch (`main`, `master`, `trunk` or a remote's `HEAD`)
 * nor on another branch it was built on. Its owner is the author of most of them, weighted
 * towards its tip, or the author of its tip when it has none. Authors are identified by email;
 * the contributor list groups emails by name.
 */
export interface BranchOwners {
  /**
   * Owner email (lowercase) of each branch by full ref name. Default branches and the branches
   * tracking them have no owner and are absent.
   */
  readonly byRef: Readonly<Record<string, string>>;
  /** Name and latest author time (Unix seconds) for each owner email, with `.mailmap` applied. */
  readonly people: Readonly<Record<string, { readonly name: string; readonly time: number }>>;
  /** The configured `user.email` (lowercase) and `user.name`. */
  readonly me: { readonly email: string | null; readonly name: string | null };
}

export interface RefsSnapshot {
  readonly refs: readonly Ref[];
  readonly stashes: readonly Stash[];
  readonly remotes: readonly Remote[];
  readonly worktrees: readonly Worktree[];
  readonly submodules: readonly Submodule[];
  readonly owners: BranchOwners;
}

// ---------------------------------------------------------------------------
// Commit graph
// ---------------------------------------------------------------------------

export interface GraphInfo {
  /** Increments whenever the graph is recomputed (refs changed). */
  readonly version: number;
  readonly count: number;
  readonly complete: boolean;
  /** Largest lane index used by any row + 1. */
  readonly maxLanes: number;
  /** Why the last load failed: the graph is incomplete or outdated, and may be reloading. */
  readonly error?: string;
}

/**
 * One row of the commit graph.
 *
 * `edges` is a flat list of `[x1, y1, x2, y2, color]` tuples, where x is a lane
 * index and y is one of 0 (row top), 1 (row middle, i.e. the node) and
 * 2 (row bottom).
 */
export interface GraphRow {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly subject: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorTime: number;
  readonly committerTime: number;
  readonly lane: number;
  readonly color: number;
  readonly edges: readonly number[];
  /** Number of lanes this row touches (for graph column sizing). */
  readonly width: number;
}

// ---------------------------------------------------------------------------
// Working tree and commits
// ---------------------------------------------------------------------------

export type ChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "untracked"
  | "conflicted";

/**
 * How a file conflicts, as in `git status`: `UU` both modified, `AA` both added, `DD` both
 * deleted, `AU`/`UA` added by us/them, `DU` deleted by us, `UD` deleted by them.
 */
export type ConflictCode = "UU" | "AA" | "DD" | "AU" | "UA" | "DU" | "UD";

export interface FileChange {
  readonly path: string;
  readonly oldPath: string | null;
  readonly kind: ChangeKind;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly binary: boolean;
  /** For a conflicted file, how it conflicts. */
  readonly conflict?: ConflictCode;
}

/** Where a renamed file came from, for a `DiffTarget`. Copies diff as added files. */
export const renameSource = (f: FileChange): { readonly oldPath?: string } =>
  f.kind === "renamed" && f.oldPath ? { oldPath: f.oldPath } : {};

export interface WorkingStatus {
  readonly staged: readonly FileChange[];
  readonly unstaged: readonly FileChange[];
  readonly conflicted: readonly FileChange[];
  /** True when the list was truncated because it is too large. */
  readonly truncated: boolean;
}

export interface Signature {
  readonly name: string;
  readonly email: string;
  readonly time: number;
}

export interface CommitDetails {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly author: Signature;
  readonly committer: Signature;
  readonly subject: string;
  readonly body: string;
  readonly files: readonly FileChange[];
  /** Set when `files` lists only the first of more changed files (see `totalFiles`). */
  readonly truncated?: boolean;
  /** The number of changed files, when `files` is truncated. */
  readonly totalFiles?: number;
}

/** The changes between two commits, e.g. over a selection of commits. */
export interface Comparison {
  /** The revision compared with: the given base, or the empty tree when there is none. */
  readonly base: string;
  readonly tip: string;
  readonly files: readonly FileChange[];
  /** Set when `files` lists only the first of more changed files (see `totalFiles`). */
  readonly truncated?: boolean;
  /** The number of changed files, when `files` is truncated. */
  readonly totalFiles?: number;
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

/** What a diff is computed against. `oldPath` is where a renamed or copied file came from. */
export type DiffTarget =
  | { readonly kind: "unstaged"; readonly path: string; readonly untracked?: boolean }
  | { readonly kind: "staged"; readonly path: string; readonly oldPath?: string }
  | {
      readonly kind: "commit";
      readonly hash: string;
      /** Compare with this revision instead of the commit's first parent (see `Comparison`). */
      readonly base?: string;
      readonly path: string;
      readonly oldPath?: string;
    };

export type DiffLineKind = "context" | "add" | "del" | "meta";

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly oldNo: number | null;
  readonly newNo: number | null;
  readonly text: string;
}

export interface DiffHunk {
  readonly header: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly DiffLine[];
}

export interface FileDiff {
  readonly path: string;
  readonly oldPath: string | null;
  readonly binary: boolean;
  readonly hunks: readonly DiffHunk[];
  /** True when the diff was too large and got truncated. */
  readonly truncated: boolean;
  /** The file is absent on the old side (`new file mode`). */
  readonly created?: boolean;
  /** The file is absent on the new side (`deleted file mode`). */
  readonly deleted?: boolean;
  /** Mode of the side that exists, e.g. "100644", for created or deleted files. */
  readonly mode?: string;
  /** Why hunks and lines of this diff must not be staged, unstaged or discarded, if so. */
  readonly readOnly?: "conflict" | "submodule" | "encoding";
}

/** One side of a file change, as raw bytes. */
export type FileContent =
  | { readonly kind: "missing" }
  /** Larger than we transfer; `size` is in bytes. */
  | { readonly kind: "large"; readonly size: number }
  | { readonly kind: "blob"; readonly bytes: Uint8Array };

/** Both sides of a diff target, for rendered (non-textual) views. */
export interface FileVersions {
  readonly old: FileContent;
  readonly new: FileContent;
}

// ---------------------------------------------------------------------------
// Remote hosts
// ---------------------------------------------------------------------------

export interface DirEntry {
  readonly name: string;
  readonly isDir: boolean;
  readonly isRepo: boolean;
}

export interface DirListing {
  readonly path: string;
  readonly entries: readonly DirEntry[];
}

// ---------------------------------------------------------------------------
// Persistent app state
// ---------------------------------------------------------------------------

export interface AppState {
  readonly tabs: readonly RepoId[];
  readonly activeTab: RepoId | null;
  readonly recent: readonly RepoId[];
}

export type UpdaterStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "checking" }
  | { readonly kind: "available"; readonly version: string }
  | { readonly kind: "downloading"; readonly percent: number }
  | { readonly kind: "ready"; readonly version: string }
  | { readonly kind: "error"; readonly message: string };
