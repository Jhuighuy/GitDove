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
    p === "shallow" ||
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
  if (
    p.startsWith("refs/") ||
    p === "packed-refs" ||
    p === "shallow" ||
    p.startsWith("logs/refs/stash")
  ) {
    return "refs";
  }
  return null;
};

const isInside = (child: string, parent: string) => {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !r.startsWith(sep) && r !== "..");
};

/**
 * The paths that `.gitignore` and friends ignore (tracked files never are). `check-ignore` reads
 * pathspecs, dies on magic it does not support (a file named `:!x`) and does not take
 * `--literal-pathspecs`: each path goes behind `./`, which it prints back as given.
 */
const ignoredPaths = (repo: Repository, paths: readonly string[]): Effect.Effect<Set<string>> =>
  repo
    .gitText(["check-ignore", "-z", "--stdin"], {
      stdin: paths.map((p) => `./${p}\0`).join(""),
      okCodes: [0, 1],
    })
    .pipe(
      Effect.map(
        (out) =>
          new Set(
            out
              .split("\0")
              .filter(Boolean)
              .map((p) => (p.startsWith("./") ? p.slice(2) : p)),
          ),
      ),
      Effect.orElseSucceed(() => new Set<string>()),
    );

/**
 * Watches a local repository with native file system events, and falls back to polling when
 * they are not available (e.g. out of inotify watches, or a network file system).
 */
const watchLocal = (repo: Repository, listener: ChangeListener): Watch => {
  let disposed = false;
  let polling: Watch | null = null;
  let visible = true;
  /** Changes made while the repository was hidden, reported once it is shown. */
  let held: { scopes: Set<RepoChangeScope>; paths: string[] | null } | null = null;
  const deliver = (scopes: Set<RepoChangeScope>, paths: string[] | null) => {
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
  };
  const batch = batcher((scopes, paths) => {
    if (disposed) return;
    if (visible) return deliver(scopes, paths);
    held ??= { scopes: new Set(), paths: [] };
    for (const s of scopes) held.scopes.add(s);
    held.paths =
      held.paths && paths && held.paths.length + paths.length <= MAX_PATHS
        ? [...held.paths, ...paths]
        : null;
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
          polling ??= pollRepository(repo, listener, visible);
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

  return {
    dispose: () => {
      disposed = true;
      batch.dispose();
      polling?.dispose();
      for (const s of subscriptions) {
        void s.then((sub) => sub?.unsubscribe()).catch(() => {});
      }
    },
    setVisible: (value) => {
      visible = value;
      polling?.setVisible(value);
      if (!value || !held || disposed) return;
      const { scopes, paths } = held;
      held = null;
      deliver(scopes, paths);
    },
  };
};

/** How often to poll while the app is in front, while it is not, and hidden repositories. */
const POLL_ACTIVE = Duration.seconds(2);
const POLL_BACKGROUND = Duration.seconds(15);
const POLL_HIDDEN = Duration.seconds(30);

/**
 * Polls a repository for changes: remote ones, and local ones that cannot be watched. Each
 * poll is a single cheap shell invocation over the multiplexed SSH connection. A hidden
 * repository (e.g. in a background tab) is polled rarely, and right away once it is shown.
 */
const pollRepository = (repo: Repository, listener: ChangeListener, visible = true): Watch => {
  const script = String.raw`
gd=${shellQuote(repo.gitDir)}
common=${shellQuote(repo.commonDir)}
st() { stat -c '%Y.%s' "$1" 2>/dev/null || stat -f '%m.%z' "$1" 2>/dev/null; }
printf 'H:'; cat "$gd/HEAD" 2>/dev/null
printf 'I:'; st "$gd/index"; echo
printf 'R:'; { git for-each-ref --format='%(refname) %(objectname)'; st "$common/logs/refs/stash"; st "$common/shallow"; ls "$gd" | grep -E '^(MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|BISECT_LOG|rebase-merge|rebase-apply|sequencer)$'; } 2>/dev/null | cksum
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

  /** Ends the current wait early. */
  const wakers = new Set<() => void>();
  /**
   * Waits until the next poll. A visible repository is also polled when the app becomes active
   * again; a hidden one only when it is shown.
   */
  const pause = Effect.suspend(() =>
    Effect.raceFirst(
      Effect.sleep(!visible ? POLL_HIDDEN : activity.isActive() ? POLL_ACTIVE : POLL_BACKGROUND),
      Effect.callback<void>((resume) => {
        const wake = () => resume(Effect.void);
        wakers.add(wake);
        const stop = visible ? activity.onActive(wake) : () => {};
        return Effect.sync(() => {
          wakers.delete(wake);
          stop();
        });
      }),
    ),
  );

  const loop = Effect.gen(function* () {
    for (;;) {
      yield* poll;
      yield* pause;
    }
  });
  const fiber = repo.fork(loop);
  return {
    dispose: () => {
      Effect.runFork(Fiber.interrupt(fiber));
    },
    setVisible: (value) => {
      const shown = value && !visible;
      visible = value;
      // A copy: a woken loop may poll and wait again right away, which must not end at once.
      if (shown) for (const wake of Array.from(wakers)) wake();
    },
  };
};

/** Watches a repository; hidden repositories do as little as possible until shown. */
export interface Watch {
  readonly dispose: () => void;
  /** Whether the repository is shown; changes made while hidden are reported once it is. */
  readonly setVisible: (visible: boolean) => void;
}

export const watchRepository = (repo: Repository, listener: ChangeListener): Watch =>
  repo.host.kind === "local" ? watchLocal(repo, listener) : pollRepository(repo, listener);
