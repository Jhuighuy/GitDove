import { relative, sep } from "node:path";
import watcher from "@parcel/watcher";
import log from "electron-log/main";
import type { RepoChangeScope } from "@shared/ipc";
import { Duration, Effect, Fiber } from "effect";
import type { Repository } from "./repository";
import { activity } from "../activity";
import { shellQuote } from "../exec/shell";

export type ChangeListener = (scopes: Set<RepoChangeScope>) => void;

const ALL_SCOPES: readonly RepoChangeScope[] = ["refs", "index", "worktree", "head", "config"];

/** A burst of changes is reported once it has been quiet this long… */
const QUIET_MS = 200;
/** …or once it has gone on this long, so that a long build still shows its progress. */
const MAX_WAIT_MS = 1500;
/** Work tree paths kept per batch to check against `.gitignore`; beyond, the batch counts. */
const MAX_PATHS = 1000;

/**
 * Groups bursts of changes into one notification (a trailing debounce with a maximum wait).
 * Work tree changes come with their paths, so that a batch of ignored files (a build writing to
 * `target/`) can be dropped.
 */
const batcher = (flush: (scopes: Set<RepoChangeScope>, paths: string[] | null) => void) => {
  let scopes = new Set<RepoChangeScope>();
  let paths: string[] | null = [];
  let quiet: NodeJS.Timeout | null = null;
  let max: NodeJS.Timeout | null = null;
  const fire = () => {
    if (quiet) clearTimeout(quiet);
    if (max) clearTimeout(max);
    quiet = max = null;
    const batch = { scopes, paths };
    scopes = new Set();
    paths = [];
    flush(batch.scopes, batch.paths);
  };
  return {
    add: (scope: RepoChangeScope, path?: string) => {
      scopes.add(scope);
      if (scope === "worktree" && paths) {
        if (!path || paths.length >= MAX_PATHS) paths = null;
        else paths.push(path);
      }
      if (quiet) clearTimeout(quiet);
      quiet = setTimeout(fire, QUIET_MS);
      max ??= setTimeout(fire, MAX_WAIT_MS);
    },
    dispose: () => {
      if (quiet) clearTimeout(quiet);
      if (max) clearTimeout(max);
      quiet = max = null;
    },
  };
};

/**
 * What a change in a git directory means. `FETCH_HEAD` and `ORIG_HEAD` are not listed: a fetch
 * that changes refs also writes them, and they change nothing that is shown.
 */
const classifyGitPath = (rel: string): RepoChangeScope | null => {
  const p = rel.split(sep).join("/");
  if (p === "index") return "index";
  if (p === "HEAD") return "head";
  if (p === "config") return "config";
  if (
    p.startsWith("refs/") ||
    p === "packed-refs" ||
    p === "MERGE_HEAD" ||
    p === "CHERRY_PICK_HEAD" ||
    p === "REVERT_HEAD" ||
    p === "BISECT_LOG" ||
    p.startsWith("rebase-merge") ||
    p.startsWith("rebase-apply") ||
    p.startsWith("sequencer") ||
    p.startsWith("logs/refs/stash")
  ) {
    return "refs";
  }
  return null;
};

/**
 * What a change in the common git directory of a linked worktree means: only what all
 * worktrees share. Its `HEAD` and `index` are the main worktree's.
 */
const classifyCommonPath = (rel: string): RepoChangeScope | null => {
  const p = rel.split(sep).join("/");
  if (p === "config") return "config";
  if (p.startsWith("refs/") || p === "packed-refs" || p.startsWith("logs/refs/stash")) {
    return "refs";
  }
  return null;
};

const isInside = (child: string, parent: string) => {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !r.startsWith(sep) && r !== "..");
};

/** The paths that `.gitignore` and friends ignore (tracked files never are). */
const ignoredPaths = (repo: Repository, paths: readonly string[]): Effect.Effect<Set<string>> =>
  repo
    .gitText(["check-ignore", "-z", "--stdin"], {
      stdin: paths.join("\0") + "\0",
      okCodes: [0, 1],
    })
    .pipe(
      Effect.map((out) => new Set(out.split("\0").filter(Boolean))),
      Effect.orElseSucceed(() => new Set<string>()),
    );

/**
 * Watches a local repository with native file system events, and falls back to polling when
 * they are not available (e.g. out of inotify watches, or a network file system).
 */
const watchLocal = (repo: Repository, listener: ChangeListener): (() => void) => {
  let disposed = false;
  let stopPolling: (() => void) | null = null;
  const batch = batcher((scopes, paths) => {
    if (disposed) return;
    // Only ignored files changed (e.g. build output): nothing to show.
    if (scopes.size === 1 && scopes.has("worktree") && paths && paths.length > 0) {
      repo.fork(
        Effect.map(ignoredPaths(repo, paths), (ignored) => {
          if (!disposed && paths.some((p) => !ignored.has(p))) listener(scopes);
        }),
      );
      return;
    }
    listener(scopes);
  });
  const everything = () => {
    for (const s of ALL_SCOPES) batch.add(s);
  };
  const subscriptions: Promise<watcher.AsyncSubscription | null>[] = [];

  const subscribe = (dir: string, cb: watcher.SubscribeCallback, ignore: string[]) =>
    subscriptions.push(
      watcher
        .subscribe(
          dir,
          (err, events) => {
            if (disposed) return;
            // E.g. FSEvents dropped events and asks for a rescan: anything may have changed.
            if (err) everything();
            else cb(err, events);
          },
          { ignore },
        )
        .catch((e: unknown) => {
          if (disposed) return null;
          log.warn(`Cannot watch ${dir}, polling instead:`, e);
          stopPolling ??= pollRepository(repo, listener);
          return null;
        }),
    );

  const gitDirs = [...new Set([repo.gitDir, repo.commonDir])];
  if (!repo.bare) {
    // Git directories are watched by themselves below.
    const ignore = gitDirs
      .filter((d) => isInside(d, repo.workTree))
      .map((d) => relative(repo.workTree, d));
    subscribe(
      repo.workTree,
      (_, events) => {
        for (const e of events) {
          batch.add("worktree", relative(repo.workTree, e.path).split(sep).join("/"));
        }
      },
      [".git", ...ignore],
    );
  }
  for (const dir of gitDirs) {
    const classify =
      dir === repo.commonDir && dir !== repo.gitDir ? classifyCommonPath : classifyGitPath;
    subscribe(
      dir,
      (_, events) => {
        for (const e of events) {
          const scope = classify(relative(dir, e.path));
          if (scope) batch.add(scope);
        }
      },
      ["objects", "lfs", "modules", "worktrees", "logs/HEAD"],
    );
  }

  return () => {
    disposed = true;
    batch.dispose();
    stopPolling?.();
    for (const s of subscriptions) {
      void s.then((sub) => sub?.unsubscribe()).catch(() => {});
    }
  };
};

/** How often to poll while the app is in front, and while it is not. */
const POLL_ACTIVE = Duration.seconds(2);
const POLL_BACKGROUND = Duration.seconds(15);

/** Sleeps, but wakes up early when the app becomes active again. */
const sleepUnlessWoken = (duration: Duration.Duration) =>
  Effect.raceFirst(
    Effect.sleep(duration),
    Effect.callback<void>((resume) => {
      const stop = activity.onActive(() => resume(Effect.void));
      return Effect.sync(() => void stop());
    }),
  );

/**
 * Polls a repository for changes: remote ones, and local ones that cannot be watched. Each
 * poll is a single cheap shell invocation over the multiplexed SSH connection.
 */
const pollRepository = (repo: Repository, listener: ChangeListener): (() => void) => {
  const script = String.raw`
gd=${shellQuote(repo.gitDir)}
common=${shellQuote(repo.commonDir)}
st() { stat -c '%Y.%s' "$1" 2>/dev/null || stat -f '%m.%z' "$1" 2>/dev/null; }
printf 'H:'; cat "$gd/HEAD" 2>/dev/null
printf 'I:'; st "$gd/index"; echo
printf 'R:'; { git for-each-ref --format='%(refname) %(objectname)'; st "$common/logs/refs/stash"; ls "$gd" | grep -E '^(MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|BISECT_LOG|rebase-merge|rebase-apply|sequencer)$'; } 2>/dev/null | cksum
printf 'C:'; st "$common/config"; echo
printf 'W:'; git status --porcelain=v2 -z --untracked-files=all --no-renames 2>/dev/null | cksum
`;
  let last: Map<string, string> | null = null;
  const scopeOf: Record<string, RepoChangeScope> = {
    H: "head",
    I: "index",
    R: "refs",
    C: "config",
    W: "worktree",
  };

  const poll = repo.host.sh(script, { cwd: repo.workTree, idempotent: true }).pipe(
    Effect.map((r) => {
      const current = new Map<string, string>();
      for (const line of r.stdout.toString("utf8").split("\n")) {
        const m = /^([HIRCW]):(.*)$/.exec(line);
        if (m) current.set(m[1]!, m[2]!);
      }
      if (last) {
        const scopes = new Set<RepoChangeScope>();
        for (const [k, v] of current) if (last.get(k) !== v) scopes.add(scopeOf[k]!);
        if (scopes.size > 0) listener(scopes);
      }
      last = current;
    }),
    // A failed poll is skipped; the next one compares with the last that worked.
    Effect.ignore,
  );

  const loop = Effect.gen(function* () {
    for (;;) {
      yield* poll;
      yield* sleepUnlessWoken(activity.isActive() ? POLL_ACTIVE : POLL_BACKGROUND);
    }
  });
  const fiber = repo.fork(loop);
  return () => {
    Effect.runFork(Fiber.interrupt(fiber));
  };
};

export const watchRepository = (repo: Repository, listener: ChangeListener): (() => void) =>
  repo.host.kind === "local" ? watchLocal(repo, listener) : pollRepository(repo, listener);
