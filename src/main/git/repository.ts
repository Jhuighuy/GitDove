import type {
  CommitDetails,
  DiffTarget,
  FileDiff,
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
} from "../exec/errors";
import type { ExecOptions, Host } from "../exec/hosts";
import type { SpawnResult } from "../exec/spawn";
import { GraphBuilder, LOG_FORMAT, LogParser } from "./graph";
import {
  parseDiff,
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
  host.sh(PROBE_SCRIPT, { cwd: path }).pipe(
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

  static open = (
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

  gitText(args: readonly string[], options: ExecOptions = {}): Effect.Effect<string, GitError> {
    return this.git(args, options).pipe(Effect.map(text));
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
    const self = this;
    return Effect.gen(function* () {
      yield* validateRev(hash);
      const raw = yield* self.gitText([
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
          self.gitText([
            "diff-tree",
            "-r",
            "-z",
            "-M",
            "--no-commit-id",
            "--name-status",
            ...range,
          ]),
          self.gitText(["diff-tree", "-r", "-z", "-M", "--no-commit-id", "--numstat", ...range]),
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
      const message = body.join("\0").replace(/\n+$/, "");
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
    const self = this;
    return Effect.gen(function* () {
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
          args = ["diff", "--cached", ...common, "--", target.path];
          break;
        case "commit": {
          yield* validateRev(target.hash);
          const parents = (yield* self.gitText(["rev-list", "--parents", "-n1", target.hash]))
            .trim()
            .split(" ")
            .slice(1);
          args = parents[0]
            ? ["diff", ...common, parents[0], target.hash, "--", target.path]
            : ["show", ...common, "--format=", target.hash, "--", target.path];
          break;
        }
      }
      const r = yield* self.git(args, { maxBytes: MAX_DIFF_BYTES, okCodes });
      return parseDiff(text(r), target.path, null, r.truncated);
    });
  }

  lastCommitMessage(): Effect.Effect<string, GitError> {
    return this.gitText(["log", "-1", "--format=%B"]).pipe(
      Effect.map((s) => s.replace(/\n+$/, "")),
    );
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
      if (!g || g.version !== version) {
        return Effect.fail(new StaleGraphError({ message: "Graph version is outdated" }));
      }
      return Effect.succeed(g.builder.rows.slice(Math.max(0, start), Math.max(start, end)));
    });
  }

  findCommit(version: number, hash: string): Effect.Effect<number, StaleGraphError> {
    return Effect.suspend(() => {
      const g = this.graph;
      if (!g || g.version !== version) {
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
    const self = this;
    return Effect.gen(function* () {
      const stashes = parseStashes(
        yield* self
          .gitText(["stash", "list", `--format=${STASH_FORMAT}`])
          .pipe(Effect.orElseSucceed(() => "")),
      );
      const head = (yield* self.gitText(["rev-parse", "-q", "--verify", "HEAD"], {
        okCodes: [0, 1],
      })).trim();
      // Stash index/untracked commits are an implementation detail: hide them
      // and draw each stash as a single node on top of its base commit.
      const internal = new Set(stashes.flatMap((s) => s.parents.slice(1)));
      const stashSet = new Set(stashes.map((s) => s.hash));

      // Revisions to walk. Without hidden refs, let git enumerate them; with
      // hidden refs, pass the visible ones explicitly. HEAD is always shown.
      const hiddenRefs = self.hiddenRefs;
      let revs: string[];
      let stdinRevs: string[];
      if (hiddenRefs.length === 0) {
        revs = ["--branches", "--remotes", "--tags"];
        stdinRevs = stashes.map((s) => s.hash);
      } else {
        const names = lines(
          yield* self.gitText([
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
        version: self.nextVersion++,
        builder: new GraphBuilder(),
        complete: false,
      };
      if (first) self.graph = snapshot;

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
          self.hooks.onGraphProgress(self, self.snapshotInfo(snapshot));
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
        self.graph = snapshot;
        if (!readyFired) yield* Deferred.succeed(ready, undefined);
        self.hooks.onGraphProgress(self, self.snapshotInfo(snapshot));
        return;
      }
      const r = yield* self.git(
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
      self.graph = snapshot;
      if (!readyFired) yield* Deferred.succeed(ready, undefined);
      self.hooks.onGraphProgress(self, self.snapshotInfo(snapshot));
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
    const self = this;
    return Effect.gen(function* () {
      const hasHead = yield* self.hasHead();
      yield* self.run(
        hasHead
          ? ["reset", "-q", "HEAD", "--pathspec-from-file=-", "--pathspec-file-nul"]
          : ["rm", "--cached", "-r", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"],
        { stdin: paths.join("\0"), okCodes: [0, 1] },
      );
    });
  }

  unstageAll() {
    const self = this;
    return Effect.gen(function* () {
      const hasHead = yield* self.hasHead();
      yield* self.run(hasHead ? ["reset", "-q"] : ["rm", "--cached", "-r", "-q", "."], {
        okCodes: [0, 1],
      });
    });
  }

  discard(paths: readonly string[], untracked: readonly string[]) {
    const self = this;
    return Effect.gen(function* () {
      if (paths.length > 0) {
        yield* self.run(["checkout", "--pathspec-from-file=-", "--pathspec-file-nul", "--"], {
          stdin: paths.join("\0"),
        });
      }
      if (untracked.length > 0) {
        yield* self.run(["clean", "-f", "-q", "--", ...untracked]);
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
    const self = this;
    return Effect.gen(function* () {
      const info = yield* self.info();
      switch (info.state) {
        case "merging":
          return yield* self.run(["merge", "--abort"]);
        case "rebasing":
          return yield* self.run(["rebase", "--abort"]);
        case "cherry-picking":
          return yield* self.run(["cherry-pick", "--abort"]);
        case "reverting":
          return yield* self.run(["revert", "--abort"]);
        case "bisecting":
          return yield* self.run(["bisect", "reset"]);
        case "clean":
          return;
      }
    });
  }

  continueOperation() {
    const self = this;
    return Effect.gen(function* () {
      const info = yield* self.info();
      switch (info.state) {
        case "merging":
          return yield* self.run(["commit", "--no-edit"]);
        case "rebasing":
          return yield* self.run(["rebase", "--continue"]);
        case "cherry-picking":
          return yield* self.run(["cherry-pick", "--continue"]);
        case "reverting":
          return yield* self.run(["revert", "--continue"]);
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
    return this.run(["stash", "pop", "--index", `stash@{${index | 0}}`]);
  }

  stashApply(index: number) {
    return this.run(["stash", "apply", "--index", `stash@{${index | 0}}`]);
  }

  stashDrop(index: number) {
    return this.run(["stash", "drop", `stash@{${index | 0}}`]);
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
    const self = this;
    return Effect.gen(function* () {
      const args = ["push", ...(opts.force ? ["--force-with-lease"] : [])];
      if (opts.setUpstream) {
        const info = yield* self.info();
        if (!info.head.branch) {
          return yield* Effect.fail(
            new InvalidInputError({ message: "Cannot push a detached HEAD" }),
          );
        }
        const remotes = parseRemotes(yield* self.gitText(["remote", "-v"]));
        const remote = remotes.find((r) => r.name === "origin")?.name ?? remotes[0]?.name;
        if (!remote)
          return yield* Effect.fail(new InvalidInputError({ message: "No remotes configured" }));
        args.push("-u", remote, info.head.branch);
      }
      yield* self.run(args);
    });
  }

  /** Pushes a (not necessarily checked out) branch, setting its upstream if it has none. */
  pushBranch(branch: string, force: boolean) {
    const self = this;
    return Effect.gen(function* () {
      yield* validateBranchName(branch);
      const [remote = "", merge = ""] = (yield* self.gitText([
        "for-each-ref",
        "--format=%(upstream:remotename)%00%(upstream:remoteref)",
        `refs/heads/${branch}`,
      ]))
        .trim()
        .split("\0");
      const lease = force ? ["--force-with-lease"] : [];
      if (remote && merge) {
        return yield* self.run(["push", ...lease, remote, `refs/heads/${branch}:${merge}`]);
      }
      const remotes = parseRemotes(yield* self.gitText(["remote", "-v"]));
      const target = remotes.find((r) => r.name === "origin")?.name ?? remotes[0]?.name;
      if (!target)
        return yield* Effect.fail(new InvalidInputError({ message: "No remotes configured" }));
      yield* self.run(["push", ...lease, "-u", target, branch]);
    });
  }

  /** Fast-forwards a branch that is not checked out to its upstream. */
  fastForwardBranch(branch: string) {
    const self = this;
    return Effect.gen(function* () {
      yield* validateBranchName(branch);
      const [remote = "", merge = ""] = (yield* self.gitText([
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
      yield* self.run(["fetch", remote, `${merge}:refs/heads/${branch}`]);
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

  removeWorktree(path: string, force: boolean) {
    return this.run(["worktree", "remove", ...(force ? ["--force"] : []), "--", path]);
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
const validateRev = (rev: string) =>
  rev && !rev.startsWith("-") && !/[\0\n]/.test(rev)
    ? Effect.void
    : Effect.fail(new InvalidInputError({ message: `Invalid revision: ${rev}` }));

const validateBranchName = (name: string) =>
  name && !name.startsWith("-") && !/[\0\n\s~^:?*[\\]|\.\.|@\{|\/$|\.lock$/.test(name)
    ? Effect.void
    : Effect.fail(new InvalidInputError({ message: `Invalid branch name: ${name}` }));
