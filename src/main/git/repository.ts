import type {
  CommitDetails,
  Comparison,
  DiffTarget,
  FileDiff,
  FileVersions,
  GraphInfo,
  GraphRow,
  RefsSnapshot,
  RepoId,
  RepoInfo,
  RepoLocation,
  RepoState,
  Stash,
  Submodule,
  WorkingStatus,
} from "@shared/domain";
import { repoDisplayName, repoIdOf } from "@shared/domain";
import { isContributorKey, isFilteredOut, isHidden, stashKey } from "@shared/visibility";
import type { ResetMode } from "@shared/ipc";
import { Deferred, Effect, Fiber, Semaphore } from "effect";
import {
  CancelledError,
  CommandError,
  InvalidInputError,
  NotARepositoryError,
  type SshError,
  StaleGraphError,
  WorktreeNeedsForceError,
} from "../exec/errors";
import type { ExecOptions, Host } from "../exec/hosts";
import { shellQuote } from "../exec/shell";
import type { SpawnResult } from "../exec/spawn";
import { GraphBuilder, LOG_FORMAT, LogParser } from "./graph";
import {
  branchOwners,
  type OwnerLogs,
  OWNERS_LOG_ARGS,
  TIPS_LOG_ARGS,
  USER_CONFIG_ARGS,
} from "./owners";
import {
  type ChangedFiles,
  COMMIT_FORMAT,
  parseCommitShow,
  parseDiff,
  parseFileVersions,
  parseRawChanges,
  parseRefs,
  parseRemotes,
  parseStashes,
  parseStatus,
  parseSubmodules,
  parseWorktrees,
  REFS_FORMAT,
  STASH_FORMAT,
  type StashEntry,
} from "./parse";

export type GitError = CommandError | SshError;

/**
 * Makes the paths given to a command file names, never globs or `:(magic)`: `[id].tsx` must not
 * also match `i.tsx`. Not set for every command: some use pathspec magic internally (e.g.
 * `stash pop` fails to restore untracked files with it).
 */
const LITERAL = "--literal-pathspecs";

const GIT_CONFIG = [
  "-c",
  "core.quotepath=off",
  "-c",
  "color.ui=false",
  "-c",
  "log.showSignature=false",
  "-c",
  "i18n.logOutputEncoding=UTF-8",
  // Patches built from diffs must have the `a/` and `b/` prefixes `git apply` expects.
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
];

/**
 * Options for diffs that hunks and lines are staged from: the patch must describe the blobs
 * themselves (no external diff or textconv) with the context `git apply` expects, whatever the
 * user's configuration says (e.g. `diff.context=0`).
 */
const STAGEABLE_DIFF = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "-U3"];

/** Largest diff we render before truncating (bytes). */
const MAX_DIFF_BYTES = 8 * 1024 * 1024;

/** Largest file version we transfer for rendered views (bytes). */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Most files listed for a commit or a comparison; `totalFiles` says how many there are. */
const MAX_CHANGED_FILES = 10_000;

/** Most graph rows served at once: a screenful is a few dozen. */
const MAX_GRAPH_ROWS = 10_000;

/** Most paths given to one `git clean`, which cannot read them from a file. */
const CLEAN_BATCH = 500;

const RESET_MODES: readonly string[] = ["soft", "mixed", "hard"] satisfies ResetMode[];

const decoder = new TextDecoder("utf-8");
const text = (r: SpawnResult) => decoder.decode(r.stdout);

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/**
 * Reads where a repository is and what it is doing in one round trip. Exit code 3 means git
 * does not see a repository; 4, that the path is a git directory (e.g. `.git`), whose
 * repository has a work tree elsewhere.
 */
const PROBE_SCRIPT = String.raw`
gd=$(git rev-parse --absolute-git-dir 2>&1) || { printf '%s' "$gd" >&2; exit 3; }
[ "$(git rev-parse --is-inside-git-dir)" = true ] && [ "$(git rev-parse --is-bare-repository)" = false ] && exit 4
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || printf '%s' "$gd")
bare=$(git rev-parse --is-bare-repository)
top=$(git rev-parse --show-toplevel 2>/dev/null)
branch=$(git symbolic-ref -q HEAD 2>/dev/null)
head=$(git rev-parse -q --verify HEAD 2>/dev/null)
format=$(git rev-parse --show-object-format 2>/dev/null)
state=clean
# git am keeps its state in rebase-apply too.
if [ -f "$gd/rebase-apply/applying" ]; then state=applying
elif [ -d "$gd/rebase-merge" ] || [ -d "$gd/rebase-apply" ]; then state=rebasing
elif [ -f "$gd/MERGE_HEAD" ]; then state=merging
elif [ -f "$gd/CHERRY_PICK_HEAD" ]; then state=cherry-picking
elif [ -f "$gd/REVERT_HEAD" ]; then state=reverting
elif [ -f "$gd/BISECT_LOG" ]; then state=bisecting
# A cherry-pick or revert of several commits that stopped between them.
elif [ -s "$gd/sequencer/todo" ]; then
  read -r cmd _ < "$gd/sequencer/todo"
  case $cmd in revert | r) state=reverting ;; *) state=cherry-picking ;; esac
fi
printf '%s\0' "$gd" "$common" "$bare" "$top" "$branch" "$head" "$state" "$format"
`;

interface Probe {
  readonly gitDir: string;
  readonly commonDir: string;
  readonly bare: boolean;
  readonly workTree: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly state: RepoState;
  readonly objectFormat: string;
}

/** Why a path is not a repository, from git's own words where they say more. */
const notARepository = (path: string, e: CommandError): NotARepositoryError => {
  const stderr = e.stderr.trim();
  const reason =
    e.exitCode === 4
      ? `${path} is a Git directory; open the folder that contains it`
      : /dubious ownership/i.test(stderr)
        ? `${path} is owned by someone else, so Git refuses to open it (see "git config safe.directory")`
        : e.exitCode === 3
          ? `${path} is not a Git repository`
          : `${path} cannot be opened${stderr ? `: ${stderr.split("\n")[0]}` : ""}`;
  return new NotARepositoryError({ message: reason, path });
};

const probe = (host: Host, path: string): Effect.Effect<Probe, GitError | NotARepositoryError> =>
  host.sh(PROBE_SCRIPT, { cwd: path, idempotent: true }).pipe(
    Effect.catchTag(
      "CommandError",
      (e): Effect.Effect<never, CommandError | NotARepositoryError> =>
        e.exitCode !== null && e.exitCode >= 1 && e.exitCode <= 4
          ? Effect.fail(notARepository(path, e))
          : Effect.fail(e),
    ),
    Effect.map((r) => {
      const [gitDir, commonDir, bare, top, branch, head, state, format] = text(r).split("\0");
      return {
        gitDir: gitDir!,
        commonDir: commonDir || gitDir!,
        bare: bare === "true",
        workTree: top || gitDir!,
        branch: branchName(branch),
        head: head || null,
        state: (state || "clean") as RepoState,
        objectFormat: format || "sha1",
      };
    }),
  );

/**
 * The branch name of what `git symbolic-ref HEAD` prints, or null when HEAD is detached. Not
 * `--short`, which prints `heads/x` when a tag is also named `x`.
 */
const branchName = (ref: string | undefined): string | null =>
  ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;

/** The id of the empty tree, which a root commit's changes are compared with. */
const emptyTreeOf = (objectFormat: string) =>
  objectFormat === "sha256"
    ? "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321"
    : "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// ---------------------------------------------------------------------------
// File versions
// ---------------------------------------------------------------------------

/**
 * Prints both sides of a change in one round trip, see `parseFileVersions`.
 * Entries are resolved to a mode and an object id first, so that only regular
 * files are read and the size and the content always describe the same blob,
 * even if the index changes meanwhile. An unmerged path has no stage 0 in the
 * index; its old side is then "ours" (stage 2). A working tree file is read only if
 * neither it nor a directory above it is a symlink, so reads stay inside the
 * working tree.
 */
const FILE_VERSIONS_SCRIPT = `
set -f
emit_object() {
  case $1 in
  100644 | 100755) ;;
  *) echo missing; return ;;
  esac
  size=$(git cat-file -s "$2" 2>/dev/null) || { echo missing; return; }
  if [ "$size" -gt "$max" ]; then echo "large $size"; else echo "blob $size"; git cat-file blob "$2"; fi
}
emit_tree() {
  oid=$(git rev-parse -q --verify "$1:$2" 2>/dev/null) || { echo missing; return; }
  set -- $(git --literal-pathspecs ls-tree --full-tree "$1" -- "$2")
  if [ "$3" = "$oid" ]; then emit_object "$1" "$oid"; else echo missing; fi
}
emit_index() {
  for stage in 0 2; do
    oid=$(git rev-parse -q --verify ":$stage:$1" 2>/dev/null) && break
  done
  [ -n "$oid" ] || { echo missing; return; }
  mode=$(git --literal-pathspecs ls-files -s -- "$1" | while read -r m o s _; do
    if [ "$o" = "$oid" ] && [ "$s" = "$stage" ]; then echo "$m"; break; fi
  done)
  emit_object "$mode" "$oid"
}
emit_file() {
  p=$1
  while :; do
    if [ -L "$p" ]; then echo missing; return; fi
    case $p in */*) p=\${p%/*} ;; *) break ;; esac
  done
  if [ -f "$1" ]; then
    size=$(($(wc -c < "$1")))
    if [ "$size" -gt "$max" ]; then echo "large $size"; else echo file; cat -- "$1"; fi
  else echo missing; fi
}
`;

/** Where one side of a change is read from. */
type VersionSource =
  | { readonly kind: "none" }
  | { readonly kind: "tree"; readonly rev: string; readonly path: string }
  | { readonly kind: "index"; readonly path: string }
  | { readonly kind: "file"; readonly path: string };

const versionSources = (target: DiffTarget): [VersionSource, VersionSource] => {
  const { path } = target;
  switch (target.kind) {
    case "unstaged":
      return [
        target.untracked ? { kind: "none" } : { kind: "index", path },
        { kind: "file", path },
      ];
    case "staged":
      return [
        { kind: "tree", rev: "HEAD", path: target.oldPath ?? path },
        { kind: "index", path },
      ];
    case "commit":
      // The first parent, like `diff`; a root commit has none and reads as missing.
      return [
        { kind: "tree", rev: target.base ?? `${target.hash}^`, path: target.oldPath ?? path },
        { kind: "tree", rev: target.hash, path },
      ];
  }
};

/** Pathspecs for a diff: a rename is only detected when both of its paths are included. */
const diffPaths = (target: DiffTarget & { readonly oldPath?: string }): string[] =>
  target.oldPath && target.oldPath !== target.path ? [target.oldPath, target.path] : [target.path];

const emitVersion = (source: VersionSource): string => {
  switch (source.kind) {
    case "none":
      return "echo missing";
    case "tree":
      return `emit_tree ${shellQuote(source.rev)} ${shellQuote(source.path)}`;
    case "index":
      return `emit_index ${shellQuote(source.path)}`;
    case "file":
      return `emit_file ${shellQuote(source.path)}`;
  }
};

// ---------------------------------------------------------------------------
// Graph state
// ---------------------------------------------------------------------------

interface GraphSnapshot {
  readonly version: number;
  readonly builder: GraphBuilder;
  complete: boolean;
  /** What the graph was loaded from, see {@link GraphState}. */
  readonly fingerprint: string;
  /** HEAD's commit ("" when unborn) that the graph is up to date with. */
  head: string;
  /**
   * Whether the graph shows only what refs and stashes reach: HEAD was unborn or at a tip when
   * it was loaded, so HEAD moving to a commit in the graph does not change it.
   */
  readonly headAtTip: boolean;
}

/** Ref fields for the graph: like `REFS_FORMAT`, without the costly ahead/behind counts. */
const GRAPH_REFS_FORMAT = [
  "%(refname)",
  "%(objectname)",
  "%(*objectname)",
  "%(upstream)",
  "",
  "",
  "%(symref)",
].join("%00");

/** Everything a graph is computed from; read before streaming it, and to tell if it changed. */
interface GraphState {
  readonly stashes: readonly StashEntry[];
  readonly head: string;
  /** `for-each-ref --format=GRAPH_REFS_FORMAT` output. */
  readonly refList: string;
  readonly owners: OwnerLogs | null;
  readonly hidden: ReadonlySet<string>;
  /** Refs, stashes and hidden refs: the graph (but HEAD) is the same while this is. */
  readonly fingerprint: string;
}

/** Revisions to walk for a graph, and the commits at their tips. */
const graphRevs = (state: GraphState) => {
  const { stashes, hidden } = state;
  const refs = parseRefs(state.refList);
  let revs: string[];
  let stdinRevs: string[];
  let tips: string[];
  if (hidden.size === 0) {
    // Let git enumerate the refs.
    revs = ["--branches", "--remotes", "--tags"];
    stdinRevs = stashes.map((s) => s.hash);
    tips = [...refs.map((r) => r.hash), ...stdinRevs];
  } else {
    const owned = state.owners === null ? null : branchOwners(state.refList, state.owners, "");
    const visible = refs.filter(
      (r) => !isHidden(hidden, r.name) && !(owned && isFilteredOut(hidden, r.name, owned)),
    );
    revs = [];
    const shownStashes = stashes.filter((s) => !isHidden(hidden, stashKey(s.hash)));
    stdinRevs = [...visible.map((r) => r.name), ...shownStashes.map((s) => s.hash)];
    tips = [...visible.map((r) => r.hash), ...shownStashes.map((s) => s.hash)];
  }
  // HEAD is always shown.
  if (state.head) revs.push("HEAD");
  return { revs, stdinRevs, tips: new Set(tips) };
};

/** Whether `snapshot` already shows the graph for `state`. */
const showsState = (snapshot: GraphSnapshot, state: GraphState): boolean =>
  snapshot.fingerprint === state.fingerprint &&
  (snapshot.head === state.head ||
    // HEAD moved within a graph of refs only: the same commits, e.g. after a checkout.
    (snapshot.complete &&
      snapshot.headAtTip &&
      (state.head === "" || snapshot.builder.index.has(state.head))));

/**
 * Waits before reloading a graph whose load lost the connection. After the last one, the graph
 * waits for something to ask for it again (a refresh, or refs changing).
 */
const GRAPH_RETRY_DELAYS = [
  "1 second",
  "2 seconds",
  "5 seconds",
  "15 seconds",
  "30 seconds",
  "60 seconds",
] as const;

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface RepositoryHooks {
  readonly onGraphProgress: (repo: Repository, info: GraphInfo) => void;
}

/**
 * Graph versions are unique across repositories, so that a repository that is closed and opened
 * again never serves a version that the renderer still has cached rows for.
 */
let nextGraphVersion = 1;

/** How long the probe made when opening a repository answers the first {@link Repository.info}. */
const OPENING_PROBE_TTL_MS = 2000;

export class Repository {
  private graph: GraphSnapshot | null = null;
  /** The snapshot being streamed, once its refs are known. */
  private graphLoading: GraphSnapshot | null = null;
  private graphDirty = true;
  private graphLoad: Fiber.Fiber<void> | null = null;
  private graphCheck: Fiber.Fiber<void> | null = null;
  private graphReady: Deferred.Deferred<void, GitError> | null = null;
  private graphRetry: Fiber.Fiber<void> | null = null;
  private graphFailures = 0;
  private graphError: string | null = null;
  private disposed = false;
  private hiddenRefs: ReadonlySet<string> = new Set();
  /** Local changes: the index, the work tree and local refs. */
  private readonly writes = Semaphore.makeUnsafe(1);
  /**
   * Fetches and pushes, which only change remote-tracking refs: they do not hold up staging and
   * committing while they wait for the network.
   */
  private readonly transfers = Semaphore.makeUnsafe(1);
  /** Signals that cancel the running operations, and whether each uses the network. */
  private readonly cancelSignals = new Map<Deferred.Deferred<void>, boolean>();
  /** The probe made by {@link open}, which spares the first {@link info} a round trip. */
  private openingProbe: { readonly probe: Probe; readonly at: number } | null;
  readonly emptyTree: string;

  private constructor(
    readonly id: RepoId,
    readonly location: RepoLocation,
    readonly host: Host,
    readonly workTree: string,
    readonly gitDir: string,
    readonly commonDir: string,
    readonly bare: boolean,
    private readonly hooks: RepositoryHooks,
    opening: Probe,
  ) {
    this.openingProbe = { probe: opening, at: Date.now() };
    this.emptyTree = emptyTreeOf(opening.objectFormat);
  }

  static readonly open = (
    host: Host,
    location: RepoLocation,
    hooks: RepositoryHooks,
  ): Effect.Effect<Repository, GitError | NotARepositoryError> =>
    Effect.gen(function* () {
      const p = yield* probe(host, location.path);
      const canonical: RepoLocation =
        location.kind === "local"
          ? { kind: "local", path: p.workTree }
          : { kind: "ssh", host: location.host, path: p.workTree };
      return new Repository(
        repoIdOf(canonical),
        canonical,
        host,
        p.workTree,
        p.gitDir,
        p.commonDir,
        p.bare,
        hooks,
        p,
      );
    });

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  git(args: readonly string[], options: ExecOptions = {}): Effect.Effect<SpawnResult, GitError> {
    return this.host.exec("git", [...GIT_CONFIG, ...args], { cwd: this.workTree, ...options });
  }

  /** Runs a read-only git command and returns its output. */
  gitText(args: readonly string[], options: ExecOptions = {}): Effect.Effect<string, GitError> {
    return this.git(args, { idempotent: true, ...options }).pipe(Effect.map(text));
  }

  /** Runs a git command for its effects; callers hold the write lock (see {@link write}). */
  private run(args: readonly string[], options: ExecOptions = {}): Effect.Effect<void, GitError> {
    return this.git(args, options).pipe(Effect.asVoid);
  }

  /**
   * Runs a repository-changing operation once the previous one has finished, so
   * that operations never collide on git's locks or interleave their steps.
   * Queries do not take the lock: they run with `GIT_OPTIONAL_LOCKS=0`.
   * {@link cancel} stops it, killing its command: a hook or a signing prompt
   * that never returns must not hold the lock forever.
   */
  private write<A, E>(
    effect: Effect.Effect<A, E>,
    network = false,
  ): Effect.Effect<A, E | CancelledError> {
    return this.writes.withPermits(1)(this.cancellable(effect, network)).pipe(this.refsMayChange);
  }

  /** Like {@link write}, for operations that only change the index and the work tree. */
  private indexWrite<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | CancelledError> {
    return this.writes.withPermits(1)(this.cancellable(effect, false));
  }

  /** Like {@link write}, for fetches and pushes (see {@link transfers}). */
  private transfer<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | CancelledError> {
    return this.transfers.withPermits(1)(this.cancellable(effect, true)).pipe(this.refsMayChange);
  }

  /**
   * Checks the graph after an operation of the app's own, which is cheap when the refs did not
   * change: there may be no file system events for it (over SSH, the next poll is seconds away).
   */
  private readonly refsMayChange = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.ensuring(Effect.sync(() => this.invalidateGraph())));

  private cancellable<A, E>(
    effect: Effect.Effect<A, E>,
    network: boolean,
  ): Effect.Effect<A, E | CancelledError> {
    return Effect.gen({ self: this }, function* () {
      this.openingProbe = null;
      const cancelled = yield* Deferred.make<void>();
      this.cancelSignals.set(cancelled, network);
      return yield* Effect.raceFirst(
        effect,
        Deferred.await(cancelled).pipe(
          Effect.andThen(Effect.fail(new CancelledError({ message: "Operation was cancelled" }))),
        ),
      ).pipe(Effect.ensuring(Effect.sync(() => this.cancelSignals.delete(cancelled))));
    });
  }

  /**
   * Cancels the running network operations (fetch, pull, push…), or else the running local
   * one (e.g. a commit whose hook does not return), if any.
   */
  cancel(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const running = [...this.cancelSignals];
      const network = running.filter(([, n]) => n);
      return Effect.forEach(
        network.length > 0 ? network : running,
        ([s]) => Deferred.succeed(s, undefined),
        { discard: true },
      );
    });
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  info(): Effect.Effect<RepoInfo, GitError | NotARepositoryError> {
    return Effect.suspend(() => {
      // The repository was just opened: its probe is as good as a new one.
      const opening = this.openingProbe;
      this.openingProbe = null;
      return opening && Date.now() - opening.at < OPENING_PROBE_TTL_MS
        ? Effect.succeed(opening.probe)
        : probe(this.host, this.workTree);
    }).pipe(
      Effect.map((p) => ({
        id: this.id,
        location: this.location,
        name: repoDisplayName(this.location),
        workTree: this.workTree,
        gitDir: this.gitDir,
        bare: this.bare,
        head: { branch: p.branch, hash: p.head, detached: p.branch === null && p.head !== null },
        state: p.state,
      })),
    );
  }

  /** The current state, always probed afresh (for operations that act on it). */
  private state(): Effect.Effect<RepoState, GitError | NotARepositoryError> {
    return probe(this.host, this.workTree).pipe(Effect.map((p) => p.state));
  }

  refs(): Effect.Effect<RefsSnapshot, GitError> {
    return Effect.all(
      {
        refs: this.refList(),
        ownerLogs: this.ownerLogs(),
        user: this.gitText(USER_CONFIG_ARGS, { okCodes: [0, 1] }).pipe(
          Effect.orElseSucceed(() => ""),
        ),
        stashes: this.gitText(["stash", "list", `--format=${STASH_FORMAT}`]).pipe(
          Effect.map((s) => parseStashes(s).map(toStash)),
          Effect.orElseSucceed(() => []),
        ),
        remotes: this.gitText(["remote", "-v"]).pipe(Effect.map(parseRemotes)),
        worktrees: this.gitText(["worktree", "list", "--porcelain"]).pipe(
          Effect.map(parseWorktrees),
          Effect.orElseSucceed(() => []),
        ),
        submodules: this.submodules(),
      },
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(({ refs, ownerLogs, user, ...rest }) => ({
        ...rest,
        refs: parseRefs(
          refs,
          rest.remotes.map((r) => r.name),
        ),
        owners: branchOwners(refs, ownerLogs, user),
      })),
    );
  }

  /**
   * `git submodule status` runs about a dozen processes even without submodules, so it only
   * runs when `.gitmodules` lists some.
   */
  private submodules(): Effect.Effect<Submodule[]> {
    if (this.bare) return Effect.succeed([]);
    return this.gitText(
      ["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"],
      {
        okCodes: [0, 1],
      },
    ).pipe(
      Effect.flatMap((paths) =>
        paths.trim()
          ? this.gitText(["submodule", "status"]).pipe(Effect.map(parseSubmodules))
          : Effect.succeed([]),
      ),
      Effect.orElseSucceed(() => []),
    );
  }

  private refList(format = REFS_FORMAT): Effect.Effect<string, GitError> {
    return this.gitText([
      "for-each-ref",
      `--format=${format}`,
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ]);
  }

  /** Commits for `branchOwners`; best effort, as owners only refine the contributor filter. */
  private ownerLogs(): Effect.Effect<OwnerLogs> {
    const log = (args: readonly string[]) =>
      this.gitText(args, { maxBytes: 4 * 1024 * 1024 }).pipe(Effect.orElseSucceed(() => ""));
    return Effect.all(
      { commits: log(OWNERS_LOG_ARGS), tips: log(TIPS_LOG_ARGS) },
      {
        concurrency: 2,
      },
    );
  }

  status(): Effect.Effect<WorkingStatus, GitError> {
    if (this.bare)
      return Effect.succeed({ staged: [], unstaged: [], conflicted: [], truncated: false });
    return this.gitText(
      ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--no-renames"],
      { maxBytes: 32 * 1024 * 1024 },
    ).pipe(Effect.map((s) => parseStatus(s)));
  }

  /** A commit with the files it changed (against its first parent), in one command. */
  commitDetails(hash: string): Effect.Effect<CommitDetails, GitError | InvalidInputError> {
    return Effect.gen({ self: this }, function* () {
      yield* validateRev(hash);
      const raw = yield* this.gitText([
        "show",
        "-z",
        `--format=${COMMIT_FORMAT}`,
        "-M",
        "--diff-merges=first-parent",
        "--raw",
        "--numstat",
        "--no-ext-diff",
        "--no-textconv",
        "--submodule=short",
        hash,
        "--",
      ]);
      const c = yield* Effect.try({
        try: () => parseCommitShow(raw, MAX_CHANGED_FILES),
        catch: (e) =>
          new CommandError({
            message: e instanceof Error ? e.message : String(e),
            command: "git show",
            exitCode: 0,
            stderr: "",
          }),
      });
      const message = trimTrailingNewlines(c.message);
      const nl = message.indexOf("\n");
      return {
        hash: c.hash,
        parents: c.parents,
        author: c.author,
        committer: c.committer,
        subject: nl < 0 ? message : message.slice(0, nl),
        body: nl < 0 ? "" : message.slice(nl + 1).replace(/^\n+/, ""),
        ...listed(c.changes),
      };
    });
  }

  compare(
    base: string | null,
    tip: string,
  ): Effect.Effect<Comparison, GitError | InvalidInputError> {
    return Effect.gen({ self: this }, function* () {
      yield* validateRev(tip);
      if (base !== null) yield* validateRev(base);
      // The oldest of a selection may be a root commit: compare with nothing then.
      const from = base ?? this.emptyTree;
      const raw = yield* this.gitText([
        "diff",
        "-z",
        "-M",
        "--raw",
        "--numstat",
        "--no-ext-diff",
        "--no-textconv",
        "--no-relative",
        "--submodule=short",
        from,
        tip,
        "--",
      ]);
      return { base: from, tip, ...listed(parseRawChanges(raw, MAX_CHANGED_FILES)) };
    });
  }

  diff(target: DiffTarget): Effect.Effect<FileDiff, GitError | InvalidInputError> {
    return Effect.gen({ self: this }, function* () {
      const stageable = [...STAGEABLE_DIFF, "-M", "--submodule=short", "--patch"];
      // Commit diffs are only read: textconv makes e.g. notebooks readable.
      const readable = ["--no-color", "--no-ext-diff", "-M", "--submodule=short", "--patch"];
      let args: string[];
      let okCodes: number[] = [0];
      yield* validatePath(target.path);
      switch (target.kind) {
        case "unstaged":
          // A conflicted path diffs in the combined format, which `parseDiff` shows read-only.
          args = target.untracked
            ? ["diff", ...stageable, "--no-index", "--", "/dev/null", target.path]
            : ["diff", ...stageable, "--", target.path];
          if (target.untracked) okCodes = [0, 1];
          break;
        case "staged":
          yield* validateOptionalPath(target.oldPath);
          args = ["diff", "--cached", ...stageable, "--", ...diffPaths(target)];
          break;
        case "commit": {
          yield* validateRev(target.hash);
          yield* validateOptionalPath(target.oldPath);
          if (target.base !== undefined) {
            yield* validateRev(target.base);
            args = ["diff", ...readable, target.base, target.hash, "--", ...diffPaths(target)];
          } else {
            // Against the first parent; a root commit shows its files as added.
            args = [
              "show",
              ...readable,
              "--format=",
              "--diff-merges=first-parent",
              target.hash,
              "--",
              ...diffPaths(target),
            ];
          }
          break;
        }
      }
      const r = yield* this.git([LITERAL, ...args], {
        maxBytes: MAX_DIFF_BYTES,
        okCodes,
        idempotent: true,
      });
      return parseDiff(
        r.stdout,
        target.path,
        target.kind === "unstaged" ? null : (target.oldPath ?? null),
        r.truncated,
      );
    });
  }

  /** Both sides of `target` as bytes, for views that render the whole file. */
  fileVersions(target: DiffTarget): Effect.Effect<FileVersions, GitError | InvalidInputError> {
    const [old, next] = versionSources(target);
    const script = `${FILE_VERSIONS_SCRIPT}max=${MAX_FILE_BYTES}\n${emitVersion(old)}\n${emitVersion(next)}\n`;
    return Effect.all([
      validatePath(target.path),
      target.kind === "unstaged" ? Effect.void : validateOptionalPath(target.oldPath),
      target.kind === "commit" ? validateRev(target.hash) : Effect.void,
      target.kind === "commit" && target.base !== undefined
        ? validateRev(target.base)
        : Effect.void,
    ]).pipe(
      Effect.andThen(
        this.host.sh(script, {
          cwd: this.workTree,
          maxBytes: 2 * MAX_FILE_BYTES + 1024,
          idempotent: true,
        }),
      ),
      Effect.flatMap((r) =>
        Effect.try({
          try: () => parseFileVersions(r.stdout, r.truncated),
          catch: (e) =>
            new CommandError({
              message: e instanceof Error ? e.message : String(e),
              command: "file versions",
              exitCode: r.exitCode,
              stderr: r.stderr,
            }),
        }),
      ),
    );
  }

  /** The message of the commit at HEAD; empty on an unborn branch. */
  lastCommitMessage(): Effect.Effect<string, GitError> {
    return this.git(["log", "-1", "--format=%B"], { idempotent: true, okCodes: [0, 128] }).pipe(
      Effect.map((r) => (r.exitCode === 0 ? trimTrailingNewlines(text(r)) : "")),
    );
  }

  /**
   * Commits whose message or author contains `query`, and the commit it names if it is a hash,
   * among those reachable from refs and HEAD (but not stash internals).
   */
  search(query: string): Effect.Effect<string[], GitError> {
    const q = query.trim();
    if (!q) return Effect.succeed([]);
    const args = [
      "log",
      "--exclude=refs/stash",
      "--exclude=refs/notes/*",
      "--all",
      "--format=%H",
      "-n",
      "500",
      "-i",
      "--fixed-strings",
    ];
    const hash = /^[0-9a-f]{4,64}$/i.test(q)
      ? this.gitText(["rev-parse", "--verify", "-q", `${q}^{commit}`], { okCodes: [0, 1] })
      : Effect.succeed("");
    return Effect.all(
      [hash, this.gitText([...args, `--grep=${q}`]), this.gitText([...args, `--author=${q}`])],
      { concurrency: "unbounded" },
    ).pipe(Effect.map(([h, a, b]) => [...new Set([...lines(h), ...lines(a), ...lines(b)])]));
  }

  // -------------------------------------------------------------------------
  // Commit graph
  // -------------------------------------------------------------------------

  /** Sets refs excluded from the graph (see `@shared/visibility`) and reloads it. */
  setHiddenRefs(hidden: readonly string[]): void {
    const same =
      hidden.length === this.hiddenRefs.size && hidden.every((h) => this.hiddenRefs.has(h));
    if (same) return;
    this.hiddenRefs = new Set(hidden);
    this.invalidateGraph();
  }

  /**
   * Marks the graph as possibly outdated (refs or HEAD changed). If it was ever requested, its
   * refs are read again in the background, and it is reloaded only if they changed: e.g. a
   * fetch that brought nothing, or a checkout of a branch, keeps the graph. A load in progress
   * goes on unless it is outdated, so a burst of changes does not keep restarting it.
   */
  invalidateGraph(): void {
    this.graphDirty = true;
    if (this.disposed || (!this.graph && !this.graphLoad)) return;
    if (this.graphCheck) Effect.runFork(Fiber.interrupt(this.graphCheck));
    const fiber = Effect.runFork(
      this.graphState().pipe(
        Effect.match({
          onFailure: () => null,
          onSuccess: (state) => state,
        }),
        Effect.flatMap((state) =>
          Effect.sync(() => {
            if (this.graphCheck !== fiber) return;
            this.graphCheck = null;
            if (this.disposed) return;
            const running = this.graphLoad !== null;
            const target = running ? this.graphLoading : this.graph;
            if (state && target && (running || target.complete) && showsState(target, state)) {
              target.head = state.head;
              this.graphDirty = false;
              if (!running && this.graphError !== null) {
                // A reload had failed, but there is nothing to reload any more.
                this.cancelGraphLoad();
                this.graphError = null;
                this.graphFailures = 0;
                this.hooks.onGraphProgress(this, this.snapshotInfo(target));
              }
              return;
            }
            // Load with these refs; after a failure, the load reads them again and says why.
            this.startGraphLoad(false, state ?? undefined);
          }),
        ),
      ),
    );
    this.graphCheck = fiber;
  }

  /** Stops loading the graph for good: the repository was closed. */
  dispose(): void {
    this.disposed = true;
    this.cancelGraphLoad();
    if (this.graphCheck) Effect.runFork(Fiber.interrupt(this.graphCheck));
    this.graphCheck = null;
    if (this.graphReady) Effect.runSync(Deferred.interrupt(this.graphReady));
  }

  graphInfo(): Effect.Effect<GraphInfo, GitError> {
    return Effect.suspend(() => {
      if (this.graphDirty && !this.graphLoad && !this.graphCheck) this.startGraphLoad();
      if (this.graph) return Effect.succeed(this.snapshotInfo(this.graph));
      // First load: wait for the first batch of rows.
      const ready = this.graphReady;
      if (!ready) return Effect.interrupt;
      return Deferred.await(ready).pipe(
        Effect.flatMap(() =>
          this.graph ? Effect.succeed(this.snapshotInfo(this.graph)) : Effect.interrupt,
        ),
      );
    });
  }

  /** The graph snapshot of `version`, which must be the current one. */
  private graphOf(version: number): Effect.Effect<GraphSnapshot, StaleGraphError> {
    return Effect.suspend(() => {
      const g = this.graph;
      return g?.version === version
        ? Effect.succeed(g)
        : Effect.fail(new StaleGraphError({ message: "Graph version is outdated" }));
    });
  }

  /** Rows `start` to `end` (exclusive) of the graph, at most {@link MAX_GRAPH_ROWS} of them. */
  graphRows(
    version: number,
    start: number,
    end: number,
  ): Effect.Effect<GraphRow[], StaleGraphError | InvalidInputError> {
    return Effect.flatMap(validateRange(start, end, MAX_GRAPH_ROWS), ([from, to]) =>
      this.graphOf(version).pipe(Effect.map((g) => g.builder.rows.slice(from, to))),
    );
  }

  /** Commit hashes of rows `start` to `end` (exclusive), e.g. for selecting a range. */
  graphHashes(
    version: number,
    start: number,
    end: number,
  ): Effect.Effect<string[], StaleGraphError | InvalidInputError> {
    return Effect.flatMap(validateRange(start, end, Infinity), ([from, to]) =>
      this.graphOf(version).pipe(
        Effect.map((g) => g.builder.rows.slice(from, to).map((r) => r.hash)),
      ),
    );
  }

  findCommit(version: number, hash: string): Effect.Effect<number, StaleGraphError> {
    return Effect.suspend(() => {
      const g = this.graph;
      if (g?.version !== version) {
        return Effect.fail(new StaleGraphError({ message: "Graph version is outdated" }));
      }
      const exact = g.builder.index.get(hash);
      if (exact !== undefined) return Effect.succeed(exact);
      if (hash.length >= 4) {
        for (const [h, i] of g.builder.index) if (h.startsWith(hash)) return Effect.succeed(i);
      }
      return Effect.succeed(-1);
    });
  }

  private snapshotInfo(g: GraphSnapshot): GraphInfo {
    return {
      version: g.version,
      count: g.builder.rows.length,
      complete: g.complete,
      maxLanes: g.builder.maxLanes,
      ...(this.graphError === null ? {} : { error: this.graphError }),
    };
  }

  /**
   * Starts loading the graph, replacing any load in progress. The load reads the refs first
   * (unless `state` has them) and keeps the shown graph if it is up to date with them.
   */
  private startGraphLoad(retry = false, state?: GraphState): void {
    if (this.disposed) return;
    this.cancelGraphLoad();
    if (!retry) this.graphFailures = 0;
    this.graphDirty = false;
    // The first callers wait for the first rows, also through reloads after a lost connection.
    const pending =
      this.graphReady && !Deferred.isDoneUnsafe(this.graphReady) ? this.graphReady : null;
    const ready = pending ?? Deferred.makeUnsafe<void, GitError>();
    if (this.graph === null) this.graphReady = ready;
    const fiber = Effect.runFork(
      this.loadGraph(ready, state).pipe(
        Effect.catch((e) =>
          Effect.suspend(() => (this.graphFailed(e) ? Effect.void : Deferred.fail(ready, e))),
        ),
        Effect.catchDefect((d) =>
          Effect.suspend(() => {
            // Not retried by itself, but by the next request or change.
            this.graphDirty = true;
            this.graphError = String(d);
            return Deferred.die(ready, d);
          }),
        ),
        Effect.asVoid,
        Effect.ensuring(
          Effect.sync(() => {
            if (this.graphLoad === fiber) {
              this.graphLoad = null;
              this.graphLoading = null;
            }
          }),
        ),
      ),
    );
    this.graphLoad = fiber;
  }

  private cancelGraphLoad(): void {
    for (const f of [this.graphLoad, this.graphRetry]) if (f) Effect.runFork(Fiber.interrupt(f));
    this.graphLoad = null;
    this.graphLoading = null;
    this.graphRetry = null;
  }

  /** Reads what the graph is computed from (see {@link GraphState}), in parallel. */
  private graphState(): Effect.Effect<GraphState, GitError> {
    return Effect.suspend(() => {
      const hidden = this.hiddenRefs;
      return Effect.all(
        {
          stashes: this.gitText(["stash", "list", `--format=${STASH_FORMAT}`]).pipe(
            Effect.map(parseStashes),
            Effect.orElseSucceed((): StashEntry[] => []),
          ),
          head: this.gitText(["rev-parse", "-q", "--verify", "HEAD"], { okCodes: [0, 1] }).pipe(
            Effect.map((s) => s.trim()),
          ),
          refList: this.refList(GRAPH_REFS_FORMAT),
          // Owners are only needed for the contributor filter.
          owners: [...hidden].some(isContributorKey) ? this.ownerLogs() : Effect.succeed(null),
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map((s) => ({
          ...s,
          hidden,
          fingerprint: [
            // A symbolic ref (e.g. a remote's HEAD, which a fetch may add) adds no commits.
            s.refList
              .split("\n")
              .filter((l) => l.endsWith("\0"))
              .join("\n"),
            s.stashes.map((st) => st.hash).join(" "),
            [...hidden].toSorted().join("\n"),
          ].join("\0"),
        })),
      );
    });
  }

  /**
   * Shows why the graph is outdated or incomplete, and reloads it after a lost connection. The
   * log streams into a parser, so a reload starts over with a new snapshot rather than rerunning
   * the command into the same one. Returns whether a reload follows.
   */
  private graphFailed(e: GitError): boolean {
    this.graphDirty = true;
    this.graphError = e.message;
    if (this.graph) this.hooks.onGraphProgress(this, this.snapshotInfo(this.graph));
    const delay = GRAPH_RETRY_DELAYS[this.graphFailures];
    if (e._tag !== "SshError" || delay === undefined) return false;
    this.graphFailures++;
    this.graphRetry = Effect.runFork(
      Effect.sleep(delay).pipe(
        Effect.andThen(
          Effect.sync(() => {
            this.graphRetry = null;
            this.startGraphLoad(true);
          }),
        ),
      ),
    );
    return true;
  }

  private loadGraph(ready: Deferred.Deferred<void, GitError>, known?: GraphState) {
    return Effect.gen({ self: this }, function* () {
      const state = known ?? (yield* this.graphState());
      const current = this.graph;
      if (current?.complete && showsState(current, state)) {
        // Nothing to load: the refs did not change since the graph was loaded.
        current.head = state.head;
        const hadError = this.graphError !== null;
        this.graphLoaded(current);
        if (!Deferred.isDoneUnsafe(ready)) yield* Deferred.succeed(ready, undefined);
        if (hadError) this.hooks.onGraphProgress(this, this.snapshotInfo(current));
        return;
      }
      const { stashes } = state;
      // Stash index/untracked commits are an implementation detail: hide them
      // and draw each stash as a single node on top of its base commit.
      const internal = new Set(stashes.flatMap((s) => s.parents.slice(1)));
      const stashSet = new Set(stashes.map((s) => s.hash));
      const { revs, stdinRevs, tips } = graphRevs(state);

      const snapshot: GraphSnapshot = {
        version: nextGraphVersion++,
        builder: new GraphBuilder(),
        complete: false,
        fingerprint: state.fingerprint,
        head: state.head,
        headAtTip: state.head === "" || tips.has(state.head),
      };
      this.graphLoading = snapshot;
      // A graph that is still loading is shown while it streams in. One that did not finish
      // stays on screen until this load has more rows; a complete one, until this load is done.
      this.graph ??= snapshot;

      let lastEmit = Date.now();
      let readyFired = false;
      const progress = () => {
        const count = snapshot.builder.rows.length;
        const shown = this.graph;
        if (shown && shown !== snapshot && !shown.complete && count > shown.builder.rows.length) {
          this.graph = snapshot;
        }
        if (this.graph !== snapshot) return;
        if (!readyFired && count >= 2000) {
          readyFired = true;
          Effect.runSync(Deferred.succeed(ready, undefined));
        }
        const now = Date.now();
        if (now - lastEmit > 300) {
          lastEmit = now;
          this.hooks.onGraphProgress(this, this.snapshotInfo(snapshot));
        }
      };
      const parser = new LogParser((c) => {
        if (internal.has(c.hash)) return;
        snapshot.builder.push(stashSet.has(c.hash) ? { ...c, parents: c.parents.slice(0, 1) } : c);
        progress();
      });

      if (revs.length === 0 && stdinRevs.length === 0) {
        // Everything is hidden and HEAD is unborn: nothing to show.
        this.graphLoaded(snapshot);
        if (!readyFired) yield* Deferred.succeed(ready, undefined);
        this.hooks.onGraphProgress(this, this.snapshotInfo(snapshot));
        return;
      }
      // The command's output can still arrive after this load was interrupted: drop it.
      let live = true;
      yield* this.git(["log", "-z", "--date-order", `--format=${LOG_FORMAT}`, "--stdin", ...revs], {
        stdin: stdinRevs.join("\n") + "\n",
        onStdout: (chunk) => {
          if (live) parser.push(chunk);
        },
      }).pipe(Effect.onInterrupt(() => Effect.sync(() => (live = false))));
      parser.end();
      this.graphLoaded(snapshot);
      if (!readyFired) yield* Deferred.succeed(ready, undefined);
      this.hooks.onGraphProgress(this, this.snapshotInfo(snapshot));
    });
  }

  private graphLoaded(snapshot: GraphSnapshot): void {
    snapshot.complete = true;
    this.graph = snapshot;
    this.graphFailures = 0;
    this.graphError = null;
  }

  // -------------------------------------------------------------------------
  // Working tree
  // -------------------------------------------------------------------------

  stage(paths: readonly string[]) {
    return this.indexWrite(
      paths.length === 0
        ? Effect.void
        : this.run([LITERAL, "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], {
            stdin: paths.join("\0"),
          }),
    );
  }

  stageAll() {
    return this.indexWrite(this.run(["add", "-A"]));
  }

  // Without a revision, `reset` also works on an unborn branch (it empties the index).
  unstage(paths: readonly string[]) {
    if (paths.length === 0) return Effect.void;
    return this.indexWrite(
      this.run([LITERAL, "reset", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"], {
        stdin: paths.join("\0"),
        okCodes: [0, 1],
      }),
    );
  }

  unstageAll() {
    return this.indexWrite(this.run(["reset", "-q"], { okCodes: [0, 1] }));
  }

  discard(paths: readonly string[], untracked: readonly string[]) {
    return this.indexWrite(
      Effect.gen({ self: this }, function* () {
        if (paths.length > 0) {
          yield* this.run(
            [LITERAL, "checkout", "--pathspec-from-file=-", "--pathspec-file-nul", "--"],
            { stdin: paths.join("\0") },
          );
        }
        // `clean` takes no pathspec file: keep each command line well below the system limit.
        for (let i = 0; i < untracked.length; i += CLEAN_BATCH) {
          const batch = untracked.slice(i, i + CLEAN_BATCH);
          yield* this.run([LITERAL, "clean", "-f", "-q", "--", ...batch]);
        }
      }),
    );
  }

  applyPatch(patch: string, opts: { cached: boolean; reverse: boolean }) {
    return this.indexWrite(
      this.run(
        [
          "apply",
          "--whitespace=nowarn",
          "--recount",
          ...(opts.cached ? ["--cached"] : []),
          ...(opts.reverse ? ["--reverse"] : []),
          "-",
        ],
        { stdin: patch },
      ),
    );
  }

  commit(
    message: string,
    opts: { amend: boolean },
  ): Effect.Effect<void, GitError | InvalidInputError | CancelledError> {
    if (!message.trim() && !opts.amend) {
      return Effect.fail(new InvalidInputError({ message: "Commit message is empty" }));
    }
    // Keep lines starting with "#", e.g. "#123 Fix crash" (`strip` removes them as comments).
    return this.write(
      this.run(["commit", "--cleanup=whitespace", "-F", "-", ...(opts.amend ? ["--amend"] : [])], {
        stdin: message,
      }),
    );
  }

  /**
   * Checks out a branch, or detaches HEAD at any other revision. A full branch name
   * (`refs/heads/x`) checks out that branch even when a tag has the same name.
   */
  checkout(ref: string) {
    const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
    return this.write(
      (branch === null ? validateRev(ref) : validateBranchName(branch)).pipe(
        Effect.andThen(this.run(["checkout", "-q", branch ?? ref, "--"])),
      ),
    );
  }

  checkoutRemote(remoteRef: string, localName: string) {
    return this.write(
      Effect.all([validateRev(remoteRef), validateBranchName(localName)]).pipe(
        Effect.andThen(this.run(["checkout", "-q", "-b", localName, "--track", remoteRef, "--"])),
      ),
    );
  }

  createBranch(name: string, at: string, checkout: boolean) {
    return this.write(
      Effect.all([validateBranchName(name), validateRev(at)]).pipe(
        Effect.andThen(
          checkout
            ? this.run(["checkout", "-q", "-b", name, at, "--"])
            : this.run(["branch", name, at]),
        ),
      ),
    );
  }

  deleteBranch(name: string, force: boolean) {
    return this.write(
      validateBranchName(name).pipe(
        Effect.andThen(this.run(["branch", force ? "-D" : "-d", "--", name])),
      ),
    );
  }

  deleteRemoteBranch(remote: string, name: string) {
    return this.transfer(
      Effect.all([validateRemoteName(remote), validateBranchName(name)]).pipe(
        // The full name: a tag with the same name must stay.
        Effect.andThen(this.run(["push", "--delete", "--", remote, `refs/heads/${name}`])),
      ),
    );
  }

  renameBranch(oldName: string, newName: string) {
    return this.write(
      Effect.all([validateBranchName(oldName), validateBranchName(newName)]).pipe(
        Effect.andThen(this.run(["branch", "-m", "--", oldName, newName])),
      ),
    );
  }

  setUpstream(branch: string, upstream: string | null) {
    return this.write(
      Effect.all([validateBranchName(branch), upstream ? validateRev(upstream) : Effect.void]).pipe(
        Effect.andThen(
          upstream
            ? this.run(["branch", `--set-upstream-to=${upstream}`, "--", branch])
            : this.run(["branch", "--unset-upstream", "--", branch]),
        ),
      ),
    );
  }

  createTag(name: string, at: string, message: string | null) {
    return this.write(
      Effect.all([validateTagName(name), validateRev(at)]).pipe(
        Effect.andThen(
          message
            ? // Keep lines starting with "#" (the default cleanup strips them as comments).
              this.run(["tag", "-a", "--cleanup=whitespace", "-F", "-", name, at], {
                stdin: message,
              })
            : this.run(["tag", name, at]),
        ),
      ),
    );
  }

  deleteTag(name: string) {
    return this.write(
      validateTagName(name).pipe(Effect.andThen(this.run(["tag", "-d", "--", name]))),
    );
  }

  /** Merges a revision; pass full ref names (`refs/heads/x`, `refs/tags/x`) to avoid ambiguity. */
  merge(ref: string, opts: { ffOnly?: boolean; noFf?: boolean }) {
    return this.write(
      validateRev(ref).pipe(
        Effect.andThen(
          this.run([
            "merge",
            "--no-edit",
            ...(opts.ffOnly ? ["--ff-only"] : []),
            ...(opts.noFf ? ["--no-ff"] : []),
            ref,
          ]),
        ),
      ),
    );
  }

  rebase(onto: string) {
    return this.write(validateRev(onto).pipe(Effect.andThen(this.run(["rebase", onto]))));
  }

  cherryPick(hash: string) {
    return this.write(validateRev(hash).pipe(Effect.andThen(this.run(["cherry-pick", hash]))));
  }

  revert(hash: string) {
    return this.write(
      validateRev(hash).pipe(Effect.andThen(this.run(["revert", "--no-edit", hash]))),
    );
  }

  reset(hash: string, mode: ResetMode) {
    return this.write(
      Effect.all([
        validateRev(hash),
        RESET_MODES.includes(mode)
          ? Effect.void
          : Effect.fail(new InvalidInputError({ message: `Invalid reset mode: ${mode}` })),
      ]).pipe(Effect.andThen(this.run(["reset", `--${mode}`, "-q", hash, "--"]))),
    );
  }

  abortOperation() {
    return this.write(
      Effect.gen({ self: this }, function* () {
        switch (yield* this.state()) {
          case "merging":
            return yield* this.run(["merge", "--abort"]);
          case "rebasing":
            return yield* this.run(["rebase", "--abort"]);
          case "cherry-picking":
            return yield* this.run(["cherry-pick", "--abort"]);
          case "reverting":
            return yield* this.run(["revert", "--abort"]);
          case "bisecting":
            return yield* this.run(["bisect", "reset"]);
          case "applying":
            return yield* this.run(["am", "--abort"]);
          case "clean":
            return;
        }
      }),
    );
  }

  continueOperation() {
    return this.write(
      Effect.gen({ self: this }, function* () {
        switch (yield* this.state()) {
          case "merging":
            return yield* this.run(["commit", "--no-edit"]);
          case "rebasing":
            return yield* this.run(["rebase", "--continue"]);
          case "cherry-picking":
            return yield* this.run(["cherry-pick", "--continue"]);
          case "reverting":
            return yield* this.run(["revert", "--continue"]);
          case "applying":
            return yield* this.run(["am", "--continue"]);
          default:
            return;
        }
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Stash
  // -------------------------------------------------------------------------

  stash(message: string | null, includeUntracked: boolean) {
    return this.write(
      this.run([
        "stash",
        "push",
        ...(includeUntracked ? ["--include-untracked"] : []),
        ...(message ? ["-m", message] : []),
      ]),
    );
  }

  /**
   * Stash operations take the entry's index, as listed in the refs, and optionally its commit
   * hash: then they act on that stash wherever it is now, e.g. after a stash was pushed from a
   * terminal since the list was read, and fail if it is gone.
   */
  stashPop(index: number, hash?: string) {
    return this.write(this.stashRun(["pop", "--index"], index, hash));
  }

  stashApply(index: number, hash?: string) {
    return this.write(this.stashRun(["apply", "--index"], index, hash));
  }

  stashDrop(index: number, hash?: string) {
    return this.write(this.stashRun(["drop"], index, hash));
  }

  /** Creates a branch at the commit a stash was made on, applies the stash there and drops it. */
  stashBranch(name: string, index: number, hash?: string) {
    return this.write(
      validateBranchName(name).pipe(Effect.andThen(this.stashRun(["branch", name], index, hash))),
    );
  }

  /**
   * Runs `git stash <args> stash@{n}` for the entry at `index`, or for the entry with `hash`
   * if given. Callers hold the write lock, so the entry cannot move in between.
   */
  private stashRun(
    args: readonly string[],
    index: number,
    hash: string | undefined,
  ): Effect.Effect<void, GitError | InvalidInputError> {
    if (!Number.isSafeInteger(index) || index < 0) {
      return Effect.fail(new InvalidInputError({ message: `Invalid stash index: ${index}` }));
    }
    if (hash === undefined) return this.run(["stash", ...args, `stash@{${index}}`]);
    return Effect.gen({ self: this }, function* () {
      const hashes = lines(yield* this.gitText(["stash", "list", "--format=%H"]));
      const at = hashes[index] === hash ? index : hashes.indexOf(hash);
      if (at < 0) {
        return yield* Effect.fail(new InvalidInputError({ message: "The stash no longer exists" }));
      }
      yield* this.run(["stash", ...args, `stash@{${at}}`]);
    });
  }

  // -------------------------------------------------------------------------
  // Remotes
  // -------------------------------------------------------------------------

  fetch(remote: string | null) {
    return this.transfer(
      (remote === null ? Effect.void : validateRemoteName(remote)).pipe(
        Effect.andThen(
          this.run(["fetch", "--prune", "--tags", ...(remote ? ["--", remote] : ["--all"])]),
        ),
      ),
    );
  }

  pull(mode: "ff-only" | "merge" | "rebase") {
    return this.write(
      this.run([
        "pull",
        mode === "ff-only" ? "--ff-only" : mode === "rebase" ? "--rebase" : "--no-rebase",
      ]),
      true,
    );
  }

  push(opts: { force: boolean; setUpstream: boolean }) {
    return this.transfer(
      Effect.gen({ self: this }, function* () {
        const args = ["push", ...(opts.force ? ["--force-with-lease"] : [])];
        if (opts.setUpstream) {
          const [branch, remote] = yield* Effect.all(
            [this.gitText(["symbolic-ref", "-q", "HEAD"], { okCodes: [0, 1] }), this.pushRemote()],
            { concurrency: 2 },
          );
          const name = branchName(branch.trim());
          if (!name) {
            return yield* Effect.fail(
              new InvalidInputError({ message: "Cannot push a detached HEAD" }),
            );
          }
          args.push("-u", "--", remote, `refs/heads/${name}`);
        }
        yield* this.run(args);
      }),
    );
  }

  /** Pushes a (not necessarily checked out) branch, setting its upstream if it has none. */
  pushBranch(branch: string, force: boolean) {
    return this.transfer(
      Effect.gen({ self: this }, function* () {
        yield* validateBranchName(branch);
        const [remote = "", merge = ""] = (yield* this.gitText([
          "for-each-ref",
          "--format=%(upstream:remotename)%00%(upstream:remoteref)",
          `refs/heads/${branch}`,
        ]))
          .trim()
          .split("\0");
        const lease = force ? ["--force-with-lease"] : [];
        if (remote && merge) {
          return yield* this.run(["push", ...lease, "--", remote, `refs/heads/${branch}:${merge}`]);
        }
        const target = yield* this.pushRemote();
        yield* this.run(["push", ...lease, "-u", "--", target, `refs/heads/${branch}`]);
      }),
    );
  }

  /**
   * The remote to push a branch without an upstream to: `remote.pushDefault`, else `origin`,
   * else the first remote.
   */
  private pushRemote(): Effect.Effect<string, GitError | InvalidInputError> {
    return this.gitText(["config", "--get-regexp", "^remote\\."], { okCodes: [0, 1] }).pipe(
      Effect.flatMap((out) => {
        const names: string[] = [];
        let pushDefault: string | null = null;
        for (const line of lines(out)) {
          const sp = line.indexOf(" ");
          const key = sp < 0 ? line : line.slice(0, sp);
          if (key === "remote.pushdefault") pushDefault = line.slice(sp + 1);
          const m = /^remote\.(.+)\.url$/.exec(key);
          if (m && !names.includes(m[1]!)) names.push(m[1]!);
        }
        const remote =
          (pushDefault && names.includes(pushDefault) ? pushDefault : null) ??
          (names.includes("origin") ? "origin" : names[0]);
        return remote
          ? Effect.succeed(remote)
          : Effect.fail(new InvalidInputError({ message: "No remotes configured" }));
      }),
    );
  }

  /** Fast-forwards a branch that is not checked out to its upstream. */
  fastForwardBranch(branch: string) {
    return this.write(
      Effect.gen({ self: this }, function* () {
        yield* validateBranchName(branch);
        const [remote = "", merge = ""] = (yield* this.gitText([
          "for-each-ref",
          "--format=%(upstream:remotename)%00%(upstream:remoteref)",
          `refs/heads/${branch}`,
        ]))
          .trim()
          .split("\0");
        if (!remote || !merge) {
          return yield* Effect.fail(
            new InvalidInputError({ message: `${branch} has no upstream branch` }),
          );
        }
        yield* this.run(["fetch", "--", remote, `${merge}:refs/heads/${branch}`]);
      }),
      true,
    );
  }

  pushTag(remote: string, tag: string) {
    return this.transfer(
      Effect.all([validateRemoteName(remote), validateTagName(tag)]).pipe(
        Effect.andThen(this.run(["push", "--", remote, `refs/tags/${tag}`])),
      ),
    );
  }

  deleteRemoteTag(remote: string, tag: string) {
    return this.transfer(
      Effect.all([validateRemoteName(remote), validateTagName(tag)]).pipe(
        Effect.andThen(this.run(["push", "--delete", "--", remote, `refs/tags/${tag}`])),
      ),
    );
  }

  addWorktree(path: string, ref: string, newBranch: string | null) {
    return this.write(
      Effect.all([validateRev(ref), newBranch ? validateBranchName(newBranch) : Effect.void]).pipe(
        Effect.andThen(
          this.run(["worktree", "add", ...(newBranch ? ["-b", newBranch] : []), "--", path, ref]),
        ),
      ),
    );
  }

  removeWorktree(
    path: string,
    force: boolean,
  ): Effect.Effect<void, GitError | WorktreeNeedsForceError | CancelledError> {
    return this.write(
      Effect.suspend(() => {
        // Forcing twice also removes a locked worktree.
        if (force) return this.run(["worktree", "remove", "--force", "--force", "--", path]);
        return this.run(["worktree", "remove", "--", path]).pipe(
          Effect.catchTag("CommandError", (e) =>
            this.worktreeNeedsForce(path).pipe(
              Effect.flatMap((needs) =>
                Effect.fail(
                  needs ? new WorktreeNeedsForceError({ message: e.message, stderr: e.stderr }) : e,
                ),
              ),
            ),
          ),
        );
      }),
    );
  }

  /**
   * Whether forcing would remove a worktree that git refused to: it is locked or has changes.
   * Checked from git's porcelain output rather than its messages, which are translated. The
   * lock is read from the main repository, since a locked worktree's folder may be gone.
   */
  private worktreeNeedsForce(path: string): Effect.Effect<boolean> {
    // git lists worktrees by their resolved path; the folder, if it is still there, says its own.
    const resolved = this.gitText(["-C", path, "rev-parse", "--show-toplevel"]).pipe(
      Effect.map((s) => s.trim()),
      Effect.orElseSucceed(() => path),
    );
    const locked = Effect.all([
      this.gitText(["worktree", "list", "--porcelain"]).pipe(Effect.map(parseWorktrees)),
      resolved,
    ]).pipe(
      Effect.map(([worktrees, top]) =>
        worktrees.some((w) => w.locked && (w.path === path || w.path === top)),
      ),
    );
    // `-C` takes the next argument as its value, so the path cannot be read as an option.
    const dirty = this.gitText(["-C", path, "status", "--porcelain"]).pipe(
      Effect.map((out) => out.length > 0),
      Effect.orElseSucceed(() => false),
    );
    // Git also refuses worktrees with checked out submodules ("-" marks uninitialized ones).
    const submodules = this.gitText(["-C", path, "submodule", "status"]).pipe(
      Effect.map((out) => lines(out).some((l) => !l.startsWith("-"))),
      Effect.orElseSucceed(() => false),
    );
    return Effect.all([locked, dirty, submodules], { concurrency: "unbounded" }).pipe(
      Effect.map((reasons) => reasons.some(Boolean)),
      Effect.orElseSucceed(() => false),
    );
  }

  pruneWorktrees() {
    return this.write(this.run(["worktree", "prune"]));
  }

  updateSubmodule(path: string) {
    return this.write(
      validatePath(path).pipe(
        Effect.andThen(this.run(["submodule", "update", "--init", "--recursive", "--", path])),
      ),
      true,
    );
  }

  setRemoteUrl(name: string, url: string) {
    return this.write(
      validateRemoteName(name).pipe(
        Effect.andThen(this.run(["remote", "set-url", "--", name, url])),
      ),
    );
  }

  addRemote(name: string, url: string) {
    return this.write(
      validateRemoteName(name).pipe(Effect.andThen(this.run(["remote", "add", "--", name, url]))),
    );
  }

  removeRemote(name: string) {
    return this.write(
      validateRemoteName(name).pipe(Effect.andThen(this.run(["remote", "remove", "--", name]))),
    );
  }
}

const toStash = (s: StashEntry): Stash => ({
  index: s.index,
  name: s.name,
  hash: s.hash,
  message: s.message,
  time: s.time,
});

/** Files changed by a commit or between two, with `truncated` and `totalFiles` when cut short. */
const listed = (c: ChangedFiles) => ({
  files: c.files,
  ...(c.total > c.files.length ? { truncated: true, totalFiles: c.total } : {}),
});

const lines = (s: string) => s.split("\n").filter(Boolean);

/** Like `s.replace(/\n+$/, "")`, without the regex backtracking on interior newlines. */
const trimTrailingNewlines = (s: string): string => {
  let end = s.length;
  while (end > 0 && s[end - 1] === "\n") end--;
  return s.slice(0, end);
};

/** Rejects revisions that could be interpreted as options. */
const validateRev = (rev: string) =>
  rev && !rev.startsWith("-") && !/[\0\n]/.test(rev)
    ? Effect.void
    : Effect.fail(new InvalidInputError({ message: `Invalid revision: ${rev}` }));

/** A repository-relative path that stays inside the working tree. */
const validatePath = (path: string) =>
  path && !path.startsWith("/") && !path.includes("\0") && !path.split("/").includes("..")
    ? Effect.void
    : Effect.fail(new InvalidInputError({ message: `Invalid path: ${path}` }));

const validateOptionalPath = (path: string | undefined) =>
  path === undefined ? Effect.void : validatePath(path);

/** Whether `name` is a valid ref name below `refs/heads/` or `refs/tags/` (`check-ref-format`). */
const isRefName = (name: string) =>
  !!name &&
  !name.startsWith("-") &&
  !/[\0-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\/|\/\.|^\/|\/$|\.lock$|\.$|^\.|^@$/.test(name);

const validateBranchName = (name: string) =>
  isRefName(name)
    ? Effect.void
    : Effect.fail(new InvalidInputError({ message: `Invalid branch name: ${name}` }));

const validateTagName = (name: string) =>
  isRefName(name)
    ? Effect.void
    : Effect.fail(new InvalidInputError({ message: `Invalid tag name: ${name}` }));

/** A remote name, which must not read as an option or a refspec. */
const validateRemoteName = (name: string) =>
  name && !name.startsWith("-") && !/[\0-\x20\x7f:]|\.\./.test(name)
    ? Effect.void
    : Effect.fail(new InvalidInputError({ message: `Invalid remote name: ${name}` }));

/** Checks that `[start, end)` spans at most `max` rows; clamps it to start at 0. */
const validateRange = (start: number, end: number, max: number) =>
  Number.isSafeInteger(start) && Number.isSafeInteger(end) && end - start <= max
    ? Effect.succeed([Math.max(0, start), Math.max(0, start, end)] as const)
    : Effect.fail(new InvalidInputError({ message: `Invalid row range: ${start}-${end}` }));
