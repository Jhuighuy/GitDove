/**
 * Typed IPC contract between the renderer and the main process.
 *
 * All requests go through a single `invoke` channel carrying `{ method, args }`
 * and resolve to an {@link RpcResult}. Push notifications from main go through
 * the `event` channel.
 */
import {
  type AppState,
  type CommitDetails,
  type Comparison,
  type DiffTarget,
  type DirListing,
  type FileDiff,
  type FileVersions,
  type GraphInfo,
  type GraphRow,
  type RefsSnapshot,
  type RepoId,
  type RepoInfo,
  type RepoLocation,
  type UpdaterStatus,
  repoIdOf,
  repoLocationOf,
  type WorkingStatus,
} from "./domain";

export type ResetMode = "soft" | "mixed" | "hard";

/** Editing commands of the focused text field or selection, as in the Edit menu. */
export const EDIT_COMMANDS = ["undo", "redo", "cut", "copy", "paste", "selectAll"] as const;
export type EditCommand = (typeof EDIT_COMMANDS)[number];

/** Most rows `repo.graphRows` returns at once; use `repo.graphHashes` for long ranges. */
export const MAX_GRAPH_ROWS = 4096;

/**
 * Whether `host` can be an SSH destination: no leading `-` (ssh would take it for an option),
 * whitespace, slashes or control characters.
 */
export const isSshHost = (host: string): boolean =>
  host.length <= 255 && /^[^\s/\p{Cc}-][^\s/\p{Cc}]*$/u.test(host);

/** Whether `id` is a well-formed repository id (see `repoIdOf`). */
export const isRepoId = (id: string): boolean => {
  let loc: RepoLocation;
  try {
    loc = repoLocationOf(id);
  } catch {
    return false;
  }
  return (
    repoIdOf(loc) === id &&
    loc.path !== "" &&
    !loc.path.includes("\0") &&
    (loc.kind === "local" || isSshHost(loc.host))
  );
};

export interface Api {
  // App / window
  "app.getState": () => AppState;
  "app.setState": (state: AppState) => void;
  "app.version": () => { version: string; platform: string };
  /** Runs an Edit menu command in the focused window, e.g. from a text field's context menu. */
  "app.edit": (command: EditCommand) => void;
  "dialog.pickDirectory": () => string | null;
  "shell.openTerminal": (repo: RepoId) => void;
  "shell.revealInFinder": (repo: RepoId, path?: string) => void;
  "shell.openExternal": (url: string) => void;

  // Remote hosts
  "ssh.hosts": () => string[];
  "ssh.listDir": (host: string, path: string | null) => DirListing;

  // Repository lifecycle
  "repo.open": (location: RepoLocation) => RepoInfo;
  "repo.close": (repo: RepoId) => void;
  "repo.init": (location: RepoLocation) => RepoInfo;
  "repo.clone": (url: string, location: RepoLocation) => RepoInfo;

  // Queries
  "repo.info": (repo: RepoId) => RepoInfo;
  "repo.refs": (repo: RepoId) => RefsSnapshot;
  "repo.graphInfo": (repo: RepoId) => GraphInfo;
  /** Rows `start` to `end` (exclusive), at most {@link MAX_GRAPH_ROWS} of them. */
  "repo.graphRows": (repo: RepoId, version: number, start: number, end: number) => GraphRow[];
  /** Commit hashes of rows `start` to `end` (exclusive), e.g. for range selection. */
  "repo.graphHashes": (repo: RepoId, version: number, start: number, end: number) => string[];
  "repo.findCommit": (repo: RepoId, version: number, hash: string) => number;
  "repo.search": (repo: RepoId, query: string) => string[];
  "repo.status": (repo: RepoId) => WorkingStatus;
  "repo.commitDetails": (repo: RepoId, hash: string) => CommitDetails;
  /** The changes from `base` (the empty tree when null) to `tip`. */
  "repo.compare": (repo: RepoId, base: string | null, tip: string) => Comparison;
  "repo.diff": (repo: RepoId, target: DiffTarget) => FileDiff;
  "repo.fileVersions": (repo: RepoId, target: DiffTarget) => FileVersions;

  // Working tree
  "repo.stage": (repo: RepoId, paths: string[]) => void;
  "repo.stageAll": (repo: RepoId) => void;
  "repo.unstage": (repo: RepoId, paths: string[]) => void;
  "repo.unstageAll": (repo: RepoId) => void;
  "repo.discard": (repo: RepoId, paths: string[], untracked: string[]) => void;
  "repo.applyPatch": (
    repo: RepoId,
    patch: string,
    opts: { cached: boolean; reverse: boolean },
  ) => void;
  "repo.commit": (repo: RepoId, message: string, opts: { amend: boolean }) => void;
  "repo.lastCommitMessage": (repo: RepoId) => string;

  // Branches and refs
  "repo.checkout": (repo: RepoId, ref: string) => void;
  "repo.checkoutRemote": (repo: RepoId, remoteRef: string, localName: string) => void;
  "repo.createBranch": (repo: RepoId, name: string, at: string, checkout: boolean) => void;
  "repo.deleteBranch": (repo: RepoId, name: string, force: boolean) => void;
  "repo.deleteRemoteBranch": (repo: RepoId, remote: string, name: string) => void;
  "repo.renameBranch": (repo: RepoId, oldName: string, newName: string) => void;
  "repo.setUpstream": (repo: RepoId, branch: string, upstream: string | null) => void;
  "repo.createTag": (repo: RepoId, name: string, at: string, message: string | null) => void;
  "repo.deleteTag": (repo: RepoId, name: string) => void;
  "repo.merge": (repo: RepoId, ref: string, opts: { ffOnly?: boolean; noFf?: boolean }) => void;
  "repo.rebase": (repo: RepoId, onto: string) => void;
  "repo.cherryPick": (repo: RepoId, hash: string) => void;
  "repo.revert": (repo: RepoId, hash: string) => void;
  "repo.reset": (repo: RepoId, hash: string, mode: ResetMode) => void;
  "repo.abortOperation": (repo: RepoId) => void;
  "repo.continueOperation": (repo: RepoId) => void;
  /** Cancels the running fetch, pull or push, if any. */
  "repo.cancel": (repo: RepoId) => void;

  // Graph visibility
  "repo.hiddenRefs": (repo: RepoId) => string[];
  "repo.setHiddenRefs": (repo: RepoId, hidden: string[]) => void;

  // Worktrees and submodules
  "repo.addWorktree": (repo: RepoId, path: string, ref: string, newBranch: string | null) => void;
  "repo.removeWorktree": (repo: RepoId, path: string, force: boolean) => void;
  "repo.pruneWorktrees": (repo: RepoId) => void;
  "repo.updateSubmodule": (repo: RepoId, path: string) => void;

  // Stash
  "repo.stash": (repo: RepoId, message: string | null, includeUntracked: boolean) => void;
  "repo.stashPop": (repo: RepoId, index: number) => void;
  "repo.stashApply": (repo: RepoId, index: number) => void;
  "repo.stashDrop": (repo: RepoId, index: number) => void;

  // Remotes
  "repo.fetch": (repo: RepoId, remote: string | null) => void;
  "repo.pull": (repo: RepoId, mode: "ff-only" | "merge" | "rebase") => void;
  "repo.push": (repo: RepoId, opts: { force: boolean; setUpstream: boolean }) => void;
  "repo.pushBranch": (repo: RepoId, branch: string, force: boolean) => void;
  "repo.fastForwardBranch": (repo: RepoId, branch: string) => void;
  "repo.pushTag": (repo: RepoId, remote: string, tag: string) => void;
  "repo.deleteRemoteTag": (repo: RepoId, remote: string, tag: string) => void;
  "repo.setRemoteUrl": (repo: RepoId, name: string, url: string) => void;
  "repo.addRemote": (repo: RepoId, name: string, url: string) => void;
  "repo.removeRemote": (repo: RepoId, name: string) => void;

  // Updater
  "updater.status": () => UpdaterStatus;
  "updater.check": () => UpdaterStatus;
  "updater.install": () => void;
}

export type ApiMethod = keyof Api;
export type ApiArgs<M extends ApiMethod> = Parameters<Api[M]>;
export type ApiResult<M extends ApiMethod> = ReturnType<Api[M]>;

/** Serialized error crossing the IPC boundary. */
export interface RpcError {
  readonly tag: string;
  readonly message: string;
  /** Raw details, e.g. git's stderr. */
  readonly detail?: string;
}

export type RpcResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: RpcError };

export type RepoChangeScope = "refs" | "index" | "worktree" | "head" | "config";

export interface Events {
  "repo.changed": { repo: RepoId; scopes: RepoChangeScope[] };
  "repo.graphProgress": { repo: RepoId; info: GraphInfo };
  "updater.status": UpdaterStatus;
  "menu.command": { command: MenuCommand };
}

export type MenuCommand =
  | "open-repo"
  | "open-remote-repo"
  | "close-tab"
  | "next-tab"
  | "prev-tab"
  | "refresh"
  | "fetch"
  | "pull"
  | "push"
  | "stash"
  | "pop"
  | "new-branch"
  | "commit-focus"
  | "toggle-sidebar"
  | "toggle-details";

export type EventName = keyof Events;

export const IPC_INVOKE = "gitdove:invoke";
export const IPC_EVENT = "gitdove:event";

/** Shape of the bridge exposed by the preload script as `window.gitdove`. */
export interface Bridge {
  invoke<M extends ApiMethod>(method: M, ...args: ApiArgs<M>): Promise<RpcResult<ApiResult<M>>>;
  on<E extends EventName>(event: E, listener: (payload: Events[E]) => void): () => void;
  platform: string;
}
