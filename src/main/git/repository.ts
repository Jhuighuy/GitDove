import type {
  CommitDetails,
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
  WorkingStatus,
} from "@shared/domain";
import { repoDisplayName, repoIdOf } from "@shared/domain";
import { isHidden, stashKey } from "@shared/visibility";
import type { ResetMode } from "@shared/ipc";
import { Deferred, Effect, Fiber } from "effect";
import {
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
  parseDiff,
  parseFileVersions,
  parseNameStatus,
  parseNumstat,
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

const GIT_CONFIG = [
  "-c",
  "core.quotepath=off",
  "-c",
  "color.ui=false",
  "-c",
  "log.showSignature=false",
];

/** Largest diff we render before truncating (bytes). */
const MAX_DIFF_BYTES = 8 * 1024 * 1024;

/** Largest file version we transfer for rendered views (bytes). */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const decoder = new TextDecoder("utf-8");
const text = (r: SpawnResult) => decoder.decode(r.stdout);

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

const PROBE_SCRIPT = String.raw`
gd=$(git rev-parse --absolute-git-dir 2>&1) || { printf '%s' "$gd" >&2; exit 3; }
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || printf '%s' "$gd")
bare=$(git rev-parse --is-bare-repository)
top=$(git rev-parse --show-toplevel 2>/dev/null)
branch=$(git symbolic-ref -q --short HEAD 2>/dev/null)
head=$(git rev-parse -q --verify HEAD 2>/dev/null)
state=clean
if [ -d "$gd/rebase-merge" ] || [ -d "$gd/rebase-apply" ]; then state=rebasing
elif [ -f "$gd/MERGE_HEAD" ]; then state=merging
elif [ -f "$gd/CHERRY_PICK_HEAD" ]; then state=cherry-picking
elif [ -f "$gd/REVERT_HEAD" ]; then state=reverting
elif [ -f "$gd/BISECT_LOG" ]; then state=bisecting
fi
printf '%s\0' "$gd" "$common" "$bare" "$top" "$branch" "$head" "$state"
`;

interface Probe {
  readonly gitDir: string;
  readonly commonDir: string;
  readonly bare: boolean;
  readonly workTree: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly state: RepoState;
}

const probe = (host: Host, path: string): Effect.Effect<Probe, GitError | NotARepositoryError> =>
  host.sh(PROBE_SCRIPT, { cwd: path, idempotent: true }).pipe(
    Effect.catchTag(
      "CommandError",
      (e): Effect.Effect<never, CommandError | NotARepositoryError> =>
        e.exitCode === 3 || e.exitCode === 1 || e.exitCode === 2
          ? Effect.fail(
              new NotARepositoryError({
                message: `${path} is not a Git repository`,
                path,
              }),
            )
          : Effect.fail(e),
    ),
    Effect.map((r) => {
      const [gitDir, commonDir, bare, top, branch, head, state] = text(r).split("\0");
      return {
        gitDir: gitDir!,
        commonDir: commonDir || gitDir!,
        bare: bare === "true",
        workTree: top || gitDir!,
        branch: branch || null,
        head: head || null,
        state: (state || "clean") as RepoState,
      };
    }),
  );

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
        { kind: "tree", rev: `${target.hash}^`, path: target.oldPath ?? path },
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
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface RepositoryHooks {
  readonly onGraphProgress: (repo: Repository, info: GraphInfo) => void;
}

export class Repository {
  private graph: GraphSnapshot | null = null;
  private graphDirty = true;
  private graphLoad: Fiber.Fiber<void, GitError> | null = null;
  private graphReady: Deferred.Deferred<void, GitError> | null = null;
  private nextVersion = 1;
  private hiddenRefs: readonly string[] = [];

  private constructor(
    readonly id: RepoId,
    readonly location: RepoLocation,
    readonly host: Host,
    readonly workTree: string,
    readonly gitDir: string,
    readonly commonDir: string,
    readonly bare: boolean,
    private readonly hooks: RepositoryHooks,
  ) {}

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

  private run(args: readonly string[], options: ExecOptions = {}): Effect.Effect<void, GitError> {
    return this.git(args, options).pipe(Effect.asVoid);
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  info(): Effect.Effect<RepoInfo, GitError | NotARepositoryError> {
    return probe(this.host, this.workTree).pipe(
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

  refs(): Effect.Effect<RefsSnapshot, GitError> {
    return Effect.all(
      {
        refs: this.gitText([
          "for-each-ref",
          `--format=${REFS_FORMAT}`,
          "refs/heads",
          "refs/remotes",
          "refs/tags",
        ]).pipe(Effect.map(parseRefs)),
        stashes: this.gitText(["stash", "list", `--format=${STASH_FORMAT}`]).pipe(
          Effect.map((s) => parseStashes(s).map(toStash)),
          Effect.orElseSucceed(() => []),
        ),
        remotes: this.gitText(["remote", "-v"]).pipe(Effect.map(parseRemotes)),
        worktrees: this.gitText(["worktree", "list", "--porcelain"]).pipe(
          Effect.map(parseWorktrees),
          Effect.orElseSucceed(() => []),
        ),
        submodules: this.bare
          ? Effect.succeed([])
          : this.gitText(["submodule", "status"]).pipe(
              Effect.map(parseSubmodules),
              Effect.orElseSucceed(() => []),
            ),
      },
      { concurrency: "unbounded" },
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

  commitDetails(hash: string): Effect.Effect<CommitDetails, GitError | InvalidInputError> {
    return Effect.gen({ self: this }, function* () {
      yield* validateRev(hash);
      const raw = yield* this.gitText([
        "show",
        "-s",
        "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%B",
        hash,
      ]);
      const [h, parents, an, ae, at, cn, ce, ct, ...body] = raw.split("\0");
      const parentList = parents ? parents.split(" ") : [];
      const base = parentList[0];
      const range = base ? [base, h!] : ["--root", h!];
      const [nameStatus, numstat] = yield* Effect.all(
        [
          this.gitText([
            "diff-tree",
            "-r",
            "-z",
            "-M",
            "--no-commit-id",
            "--name-status",
            ...range,
          ]),
          this.gitText(["diff-tree", "-r", "-z", "-M", "--no-commit-id", "--numstat", ...range]),
        ],
        { concurrency: 2 },
      );
      const stats = parseNumstat(numstat);
      const files = parseNameStatus(nameStatus).map((f) => {
        const s = stats.get(f.path);
        return s
          ? { ...f, additions: s.additions, deletions: s.deletions, binary: s.additions === null }
          : f;
      });
      const message = trimTrailingNewlines(body.join("\0"));
      const nl = message.indexOf("\n");
      return {
        hash: h!,
        parents: parentList,
        author: { name: an!, email: ae!, time: Number(at) },
        committer: { name: cn!, email: ce!, time: Number(ct) },
        subject: nl < 0 ? message : message.slice(0, nl),
        body: nl < 0 ? "" : message.slice(nl + 1).replace(/^\n+/, ""),
        files,
      };
    });
  }

  diff(target: DiffTarget): Effect.Effect<FileDiff, GitError | InvalidInputError> {
    return Effect.gen({ self: this }, function* () {
      const common = ["--no-color", "--no-ext-diff", "-M", "--patch"];
      let args: string[];
      let okCodes: number[] = [0];
      switch (target.kind) {
        case "unstaged":
          if (target.untracked) {
            args = ["diff", ...common, "--no-index", "--", "/dev/null", target.path];
            okCodes = [0, 1];
          } else {
            args = ["diff", ...common, "--", target.path];
          }
          break;
        case "staged":
          yield* validateOptionalPath(target.oldPath);
          args = ["diff", "--cached", ...common, "--", ...diffPaths(target)];
          break;
        case "commit": {
          yield* validateRev(target.hash);
          yield* validateOptionalPath(target.oldPath);
          const parents = (yield* this.gitText(["rev-list", "--parents", "-n1", target.hash]))
            .trim()
            .split(" ")
            .slice(1);
          args = parents[0]
            ? ["diff", ...common, parents[0], target.hash, "--", ...diffPaths(target)]
            : ["show", ...common, "--format=", target.hash, "--", target.path];
          break;
        }
      }
      const r = yield* this.git(args, { maxBytes: MAX_DIFF_BYTES, okCodes, idempotent: true });
      return parseDiff(
        text(r),
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

  lastCommitMessage(): Effect.Effect<string, GitError> {
    return this.gitText(["log", "-1", "--format=%B"]).pipe(Effect.map(trimTrailingNewlines));
  }

  search(query: string): Effect.Effect<string[], GitError> {
    const q = query.trim();
    if (!q) return Effect.succeed([]);
    const args = ["log", "--branches", "--remotes", "--tags", "--format=%H", "-n", "500", "-i"];
    if (/^[0-9a-f]{4,40}$/i.test(q)) {
      return this.gitText(["rev-parse", "--verify", "-q", `${q}^{commit}`], {
        okCodes: [0, 1],
      }).pipe(
        Effect.flatMap((h) =>
          h.trim()
            ? Effect.succeed([h.trim()])
            : this.gitText([...args, `--grep=${q}`, "--fixed-strings"]).pipe(Effect.map(lines)),
        ),
      );
    }
    return Effect.all(
      [
        this.gitText([...args, `--grep=${q}`, "--fixed-strings"]),
        this.gitText([...args, `--author=${q}`, "--fixed-strings"]),
      ],
      { concurrency: 2 },
    ).pipe(Effect.map(([a, b]) => [...new Set([...lines(a), ...lines(b)])]));
  }

  // -------------------------------------------------------------------------
  // Commit graph
  // -------------------------------------------------------------------------

  /** Sets refs excluded from the graph (see `@shared/visibility`) and reloads it. */
  setHiddenRefs(hidden: readonly string[]): void {
    const same =
      hidden.length === this.hiddenRefs.length && hidden.every((h) => this.hiddenRefs.includes(h));
    if (same) return;
    this.hiddenRefs = [...hidden];
    this.invalidateGraph();
  }

  /** Marks the graph as outdated; it is reloaded in the background if it was ever requested. */
  invalidateGraph(): void {
    this.graphDirty = true;
    if (this.graph) this.startGraphLoad();
  }

  graphInfo(): Effect.Effect<GraphInfo, GitError> {
    return Effect.suspend(() => {
      if (this.graphDirty && !this.graphLoad) this.startGraphLoad();
      if (this.graph) return Effect.succeed(this.snapshotInfo(this.graph));
      // First load: wait for the first batch of rows.
      return Deferred.await(this.graphReady!).pipe(
        Effect.map(() => this.snapshotInfo(this.graph!)),
      );
    });
  }

  graphRows(
    version: number,
    start: number,
    end: number,
  ): Effect.Effect<GraphRow[], StaleGraphError> {
    return Effect.suspend(() => {
      const g = this.graph;
      if (g?.version !== version) {
        return Effect.fail(new StaleGraphError({ message: "Graph version is outdated" }));
      }
      return Effect.succeed(g.builder.rows.slice(Math.max(0, start), Math.max(start, end)));
    });
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
    };
  }

  private startGraphLoad(): void {
    if (this.graphLoad) {
      Effect.runFork(Fiber.interrupt(this.graphLoad));
    }
    this.graphDirty = false;
    const first = this.graph === null;
    const ready = Deferred.makeUnsafe<void, GitError>();
    if (first) this.graphReady = ready;
    const fiber = Effect.runFork(
      this.loadGraph(first, ready).pipe(
        // The log streams into a parser, so a lost connection restarts the whole load (with a
        // new snapshot) rather than rerunning the command into the same one.
        Effect.retry({ while: (e) => e._tag === "SshError", times: 1 }),
        Effect.onError((cause) => {
          this.graphDirty = true;
          return Deferred.failCause(ready, cause);
        }),
        Effect.ensuring(
          Effect.sync(() => {
            if (this.graphLoad === fiber) this.graphLoad = null;
          }),
        ),
      ),
    );
    this.graphLoad = fiber;
  }

  private loadGraph(first: boolean, ready: Deferred.Deferred<void, GitError>) {
    return Effect.gen({ self: this }, function* () {
      const stashes = parseStashes(
        yield* this.gitText(["stash", "list", `--format=${STASH_FORMAT}`]).pipe(
          Effect.orElseSucceed(() => ""),
        ),
      );
      const head = (yield* this.gitText(["rev-parse", "-q", "--verify", "HEAD"], {
        okCodes: [0, 1],
      })).trim();
      // Stash index/untracked commits are an implementation detail: hide them
      // and draw each stash as a single node on top of its base commit.
      const internal = new Set(stashes.flatMap((s) => s.parents.slice(1)));
      const stashSet = new Set(stashes.map((s) => s.hash));

      // Revisions to walk. Without hidden refs, let git enumerate them; with
      // hidden refs, pass the visible ones explicitly. HEAD is always shown.
      const hiddenRefs = this.hiddenRefs;
      let revs: string[];
      let stdinRevs: string[];
      if (hiddenRefs.length === 0) {
        revs = ["--branches", "--remotes", "--tags"];
        stdinRevs = stashes.map((s) => s.hash);
      } else {
        const names = lines(
          yield* this.gitText([
            "for-each-ref",
            "--format=%(refname)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
          ]),
        );
        revs = [];
        stdinRevs = [
          ...names.filter(
            (n) => !/^refs\/remotes\/[^/]+\/HEAD$/.test(n) && !isHidden(hiddenRefs, n),
          ),
          ...stashes.filter((s) => !isHidden(hiddenRefs, stashKey(s.hash))).map((s) => s.hash),
        ];
      }
      if (head) revs.push("HEAD");

      const snapshot: GraphSnapshot = {
        version: this.nextVersion++,
        builder: new GraphBuilder(),
        complete: false,
      };
      if (first) this.graph = snapshot;

      let lastEmit = Date.now();
      let readyFired = false;
      const progress = () => {
        const count = snapshot.builder.rows.length;
        if (first && !readyFired && count >= 2000) {
          readyFired = true;
          Effect.runSync(Deferred.succeed(ready, undefined));
        }
        const now = Date.now();
        if (first && now - lastEmit > 300) {
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
        snapshot.complete = true;
        this.graph = snapshot;
        if (!readyFired) yield* Deferred.succeed(ready, undefined);
        this.hooks.onGraphProgress(this, this.snapshotInfo(snapshot));
        return;
      }
      const r = yield* this.git(
        ["log", "--date-order", `--format=${LOG_FORMAT}`, "--stdin", ...revs],
        {
          stdin: stdinRevs.join("\n") + "\n",
          onStdout: (chunk) => parser.push(chunk),
          okCodes: [0, 128],
        },
      );
      parser.end();
      if (r.exitCode === 128 && snapshot.builder.rows.length > 0) {
        return yield* Effect.fail(
          new CommandError({
            message: r.stderr.trim() || "git log failed",
            command: "git log",
            exitCode: 128,
            stderr: r.stderr,
          }),
        );
      }
      snapshot.complete = true;
      this.graph = snapshot;
      if (!readyFired) yield* Deferred.succeed(ready, undefined);
      this.hooks.onGraphProgress(this, this.snapshotInfo(snapshot));
    });
  }

  // -------------------------------------------------------------------------
  // Working tree
  // -------------------------------------------------------------------------

  stage(paths: readonly string[]) {
    return paths.length === 0
      ? Effect.void
      : this.run(["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], {
          stdin: paths.join("\0"),
        });
  }

  stageAll() {
    return this.run(["add", "-A"]);
  }

  unstage(paths: readonly string[]) {
    if (paths.length === 0) return Effect.void;
    return Effect.gen({ self: this }, function* () {
      const hasHead = yield* this.hasHead();
      yield* this.run(
        hasHead
          ? ["reset", "-q", "HEAD", "--pathspec-from-file=-", "--pathspec-file-nul"]
          : ["rm", "--cached", "-r", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"],
        { stdin: paths.join("\0"), okCodes: [0, 1] },
      );
    });
  }

  unstageAll() {
    return Effect.gen({ self: this }, function* () {
      const hasHead = yield* this.hasHead();
      yield* this.run(hasHead ? ["reset", "-q"] : ["rm", "--cached", "-r", "-q", "."], {
        okCodes: [0, 1],
      });
    });
  }

  discard(paths: readonly string[], untracked: readonly string[]) {
    return Effect.gen({ self: this }, function* () {
      if (paths.length > 0) {
        yield* this.run(["checkout", "--pathspec-from-file=-", "--pathspec-file-nul", "--"], {
          stdin: paths.join("\0"),
        });
      }
      if (untracked.length > 0) {
        yield* this.run(["clean", "-f", "-q", "--", ...untracked]);
      }
    });
  }

  applyPatch(patch: string, opts: { cached: boolean; reverse: boolean }) {
    return this.run(
      [
        "apply",
        "--whitespace=nowarn",
        "--recount",
        ...(opts.cached ? ["--cached"] : []),
        ...(opts.reverse ? ["--reverse"] : []),
        "-",
      ],
      { stdin: patch },
    );
  }

  commit(
    message: string,
    opts: { amend: boolean },
  ): Effect.Effect<void, GitError | InvalidInputError> {
    if (!message.trim() && !opts.amend) {
      return Effect.fail(new InvalidInputError({ message: "Commit message is empty" }));
    }
    return this.run(["commit", "--cleanup=strip", "-F", "-", ...(opts.amend ? ["--amend"] : [])], {
      stdin: message,
    });
  }

  // -------------------------------------------------------------------------
  // Branches, tags, history rewriting
  // -------------------------------------------------------------------------

  checkout(ref: string) {
    return validateRev(ref).pipe(Effect.andThen(this.run(["checkout", "-q", ref, "--"])));
  }

  checkoutRemote(remoteRef: string, localName: string) {
    return Effect.all([validateRev(remoteRef), validateBranchName(localName)]).pipe(
      Effect.andThen(this.run(["checkout", "-q", "-b", localName, "--track", remoteRef])),
    );
  }

  createBranch(name: string, at: string, checkout: boolean) {
    return Effect.all([validateBranchName(name), validateRev(at)]).pipe(
      Effect.andThen(
        checkout ? this.run(["checkout", "-q", "-b", name, at]) : this.run(["branch", name, at]),
      ),
    );
  }

  deleteBranch(name: string, force: boolean) {
    return validateBranchName(name).pipe(
      Effect.andThen(this.run(["branch", force ? "-D" : "-d", name])),
    );
  }

  deleteRemoteBranch(remote: string, name: string) {
    return this.run(["push", remote, "--delete", name]);
  }

  renameBranch(oldName: string, newName: string) {
    return validateBranchName(newName).pipe(
      Effect.andThen(this.run(["branch", "-m", oldName, newName])),
    );
  }

  setUpstream(branch: string, upstream: string | null) {
    return upstream
      ? this.run(["branch", `--set-upstream-to=${upstream}`, branch])
      : this.run(["branch", "--unset-upstream", branch]);
  }

  createTag(name: string, at: string, message: string | null) {
    return validateRev(at).pipe(
      Effect.andThen(
        message
          ? // Keep lines starting with "#" (the default cleanup strips them as comments).
            this.run(["tag", "-a", "--cleanup=whitespace", name, at, "-F", "-"], { stdin: message })
          : this.run(["tag", name, at]),
      ),
    );
  }

  deleteTag(name: string) {
    return this.run(["tag", "-d", name]);
  }

  merge(ref: string, opts: { ffOnly?: boolean; noFf?: boolean }) {
    return validateRev(ref).pipe(
      Effect.andThen(
        this.run([
          "merge",
          "--no-edit",
          ...(opts.ffOnly ? ["--ff-only"] : []),
          ...(opts.noFf ? ["--no-ff"] : []),
          ref,
        ]),
      ),
    );
  }

  rebase(onto: string) {
    return validateRev(onto).pipe(Effect.andThen(this.run(["rebase", onto])));
  }

  cherryPick(hash: string) {
    return validateRev(hash).pipe(Effect.andThen(this.run(["cherry-pick", hash])));
  }

  revert(hash: string) {
    return validateRev(hash).pipe(Effect.andThen(this.run(["revert", "--no-edit", hash])));
  }

  reset(hash: string, mode: ResetMode) {
    return validateRev(hash).pipe(Effect.andThen(this.run(["reset", `--${mode}`, "-q", hash])));
  }

  abortOperation() {
    return Effect.gen({ self: this }, function* () {
      const info = yield* this.info();
      switch (info.state) {
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
        case "clean":
          return;
      }
    });
  }

  continueOperation() {
    return Effect.gen({ self: this }, function* () {
      const info = yield* this.info();
      switch (info.state) {
        case "merging":
          return yield* this.run(["commit", "--no-edit"]);
        case "rebasing":
          return yield* this.run(["rebase", "--continue"]);
        case "cherry-picking":
          return yield* this.run(["cherry-pick", "--continue"]);
        case "reverting":
          return yield* this.run(["revert", "--continue"]);
        default:
          return;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Stash
  // -------------------------------------------------------------------------

  stash(message: string | null, includeUntracked: boolean) {
    return this.run([
      "stash",
      "push",
      ...(includeUntracked ? ["--include-untracked"] : []),
      ...(message ? ["-m", message] : []),
    ]);
  }

  stashPop(index: number) {
    return this.stashRun("pop", "--index", index);
  }

  stashApply(index: number) {
    return this.stashRun("apply", "--index", index);
  }

  stashDrop(index: number) {
    return this.stashRun("drop", null, index);
  }

  /** Runs `git stash <command>` on `stash@{index}`, rejecting invalid indices up front. */
  private stashRun(
    command: string,
    flag: string | null,
    index: number,
  ): Effect.Effect<void, GitError | InvalidInputError> {
    return Number.isSafeInteger(index) && index >= 0
      ? this.run(["stash", command, ...(flag ? [flag] : []), `stash@{${index}}`])
      : Effect.fail(new InvalidInputError({ message: `Invalid stash index: ${index}` }));
  }

  // -------------------------------------------------------------------------
  // Remotes
  // -------------------------------------------------------------------------

  fetch(remote: string | null) {
    return this.run(["fetch", "--prune", "--tags", ...(remote ? [remote] : ["--all"])]);
  }

  pull(mode: "ff-only" | "merge" | "rebase") {
    return this.run([
      "pull",
      mode === "ff-only" ? "--ff-only" : mode === "rebase" ? "--rebase" : "--no-rebase",
    ]);
  }

  push(opts: { force: boolean; setUpstream: boolean }) {
    return Effect.gen({ self: this }, function* () {
      const args = ["push", ...(opts.force ? ["--force-with-lease"] : [])];
      if (opts.setUpstream) {
        const info = yield* this.info();
        if (!info.head.branch) {
          return yield* Effect.fail(
            new InvalidInputError({ message: "Cannot push a detached HEAD" }),
          );
        }
        const remotes = parseRemotes(yield* this.gitText(["remote", "-v"]));
        const remote = remotes.find((r) => r.name === "origin")?.name ?? remotes[0]?.name;
        if (!remote)
          return yield* Effect.fail(new InvalidInputError({ message: "No remotes configured" }));
        args.push("-u", remote, info.head.branch);
      }
      yield* this.run(args);
    });
  }

  /** Pushes a (not necessarily checked out) branch, setting its upstream if it has none. */
  pushBranch(branch: string, force: boolean) {
    return Effect.gen({ self: this }, function* () {
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
        return yield* this.run(["push", ...lease, remote, `refs/heads/${branch}:${merge}`]);
      }
      const remotes = parseRemotes(yield* this.gitText(["remote", "-v"]));
      const target = remotes.find((r) => r.name === "origin")?.name ?? remotes[0]?.name;
      if (!target)
        return yield* Effect.fail(new InvalidInputError({ message: "No remotes configured" }));
      yield* this.run(["push", ...lease, "-u", target, branch]);
    });
  }

  /** Fast-forwards a branch that is not checked out to its upstream. */
  fastForwardBranch(branch: string) {
    return Effect.gen({ self: this }, function* () {
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
      yield* this.run(["fetch", remote, `${merge}:refs/heads/${branch}`]);
    });
  }

  pushTag(remote: string, tag: string) {
    return this.run(["push", remote, `refs/tags/${tag}`]);
  }

  deleteRemoteTag(remote: string, tag: string) {
    return this.run(["push", remote, "--delete", `refs/tags/${tag}`]);
  }

  addWorktree(path: string, ref: string, newBranch: string | null) {
    return Effect.all([
      validateRev(ref),
      newBranch ? validateBranchName(newBranch) : Effect.void,
    ]).pipe(
      Effect.andThen(
        this.run(["worktree", "add", ...(newBranch ? ["-b", newBranch] : []), "--", path, ref]),
      ),
    );
  }

  removeWorktree(
    path: string,
    force: boolean,
  ): Effect.Effect<void, GitError | WorktreeNeedsForceError> {
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
    return Effect.all([locked, dirty], { concurrency: "unbounded" }).pipe(
      Effect.map(([l, d]) => l || d),
      Effect.orElseSucceed(() => false),
    );
  }

  pruneWorktrees() {
    return this.run(["worktree", "prune"]);
  }

  updateSubmodule(path: string) {
    return this.run(["submodule", "update", "--init", "--recursive", "--", path]);
  }

  setRemoteUrl(name: string, url: string) {
    return this.run(["remote", "set-url", "--", name, url]);
  }

  addRemote(name: string, url: string) {
    return this.run(["remote", "add", "--", name, url]);
  }

  removeRemote(name: string) {
    return this.run(["remote", "remove", name]);
  }

  private hasHead() {
    return this.gitText(["rev-parse", "-q", "--verify", "HEAD"], { okCodes: [0, 1] }).pipe(
      Effect.map((s) => s.trim().length > 0),
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

const lines = (s: string) => s.split("\n").filter(Boolean);

/** Rejects revisions that could be interpreted as options. */
/** Like `s.replace(/\n+$/, "")`, without the regex backtracking on interior newlines. */
const trimTrailingNewlines = (s: string): string => {
  let end = s.length;
  while (end > 0 && s[end - 1] === "\n") end--;
  return s.slice(0, end);
};

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

const validateBranchName = (name: string) =>
  name && !name.startsWith("-") && !/[\0\s~^:?*[\\]|\.\.|@\{|\/$|\.lock$/.test(name)
    ? Effect.void
    : Effect.fail(new InvalidInputError({ message: `Invalid branch name: ${name}` }));
