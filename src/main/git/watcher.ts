import { relative, sep } from "node:path";
import watcher from "@parcel/watcher";
import type { RepoChangeScope } from "@shared/ipc";
import { Effect, Fiber, Schedule } from "effect";
import type { Repository } from "./repository";
import { activity } from "../activity";

export type ChangeListener = (scopes: Set<RepoChangeScope>) => void;

/** Groups bursts of file system events into a single notification. */
const debounced = (listener: ChangeListener, ms: number) => {
  let pending = new Set<RepoChangeScope>();
  let timer: NodeJS.Timeout | null = null;
  return (scope: RepoChangeScope) => {
    pending.add(scope);
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const scopes = pending;
      pending = new Set();
      listener(scopes);
    }, ms);
  };
};

const classifyGitPath = (rel: string): RepoChangeScope | null => {
  const p = rel.split(sep).join("/");
  if (p === "index") return "index";
  if (p === "HEAD") return "head";
  if (p === "config") return "config";
  if (
    p.startsWith("refs/") ||
    p === "packed-refs" ||
    p === "FETCH_HEAD" ||
    p === "ORIG_HEAD" ||
    p === "MERGE_HEAD" ||
    p === "CHERRY_PICK_HEAD" ||
    p === "REVERT_HEAD" ||
    p.startsWith("rebase-merge") ||
    p.startsWith("rebase-apply") ||
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

/** Watches a local repository with native file system events. */
const watchLocal = (repo: Repository, listener: ChangeListener): (() => void) => {
  const notify = debounced(listener, 200);
  const subscriptions: Promise<watcher.AsyncSubscription | null>[] = [];
  const gitDirs = [...new Set([repo.gitDir, repo.commonDir])];

  const onGitEvents = (dir: string) => (err: Error | null, events: watcher.Event[]) => {
    if (err) return;
    for (const e of events) {
      const scope = classifyGitPath(relative(dir, e.path));
      if (scope) notify(scope);
    }
  };

  const subscribe = (dir: string, cb: watcher.SubscribeCallback, ignore: string[]) =>
    subscriptions.push(watcher.subscribe(dir, cb, { ignore }).catch(() => null));

  if (!repo.bare) {
    subscribe(
      repo.workTree,
      (err, events) => {
        if (err) return;
        for (const e of events) {
          const gitDir = gitDirs.find((d) => isInside(e.path, d));
          if (gitDir) {
            const scope = classifyGitPath(relative(gitDir, e.path));
            if (scope) notify(scope);
          } else {
            notify("worktree");
          }
        }
      },
      [".git/objects", ".git/lfs", ".git/modules"],
    );
  }
  for (const dir of gitDirs) {
    if (!repo.bare && isInside(dir, repo.workTree)) continue;
    subscribe(dir, onGitEvents(dir), ["objects", "lfs", "modules"]);
  }

  return () => {
    for (const s of subscriptions) void s.then((sub) => sub?.unsubscribe());
  };
};

/**
 * Polls a remote repository for changes. Each poll is a single cheap shell
 * invocation over the multiplexed SSH connection.
 */
const watchRemote = (repo: Repository, listener: ChangeListener): (() => void) => {
  const script = String.raw`
gd=$(git rev-parse --absolute-git-dir) || exit 1
cd_=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || printf '%s' "$gd")
printf 'H:'; cat "$gd/HEAD" 2>/dev/null
printf 'I:'; stat -c '%Y.%s' "$gd/index" 2>/dev/null || stat -f '%m.%z' "$gd/index" 2>/dev/null
printf 'R:'; { git for-each-ref --format='%(refname) %(objectname)'; git rev-parse -q --verify refs/stash; ls "$gd" | grep -E '^(MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|rebase-merge|rebase-apply)$'; } 2>/dev/null | cksum
printf 'W:'; git status --porcelain=v2 -z --untracked-files=all 2>/dev/null | cksum
`;
  let last: Map<string, string> | null = null;
  const scopeOf: Record<string, RepoChangeScope> = {
    H: "head",
    I: "index",
    R: "refs",
    W: "worktree",
  };

  const poll = repo.host.sh(script, { cwd: repo.workTree, idempotent: true }).pipe(
    Effect.map((r) => {
      const current = new Map<string, string>();
      for (const line of r.stdout.toString("utf8").split("\n")) {
        const m = /^([HIRW]):(.*)$/.exec(line);
        if (m) current.set(m[1]!, m[2]!);
      }
      if (last) {
        const scopes = new Set<RepoChangeScope>();
        for (const [k, v] of current) if (last.get(k) !== v) scopes.add(scopeOf[k]!);
        if (scopes.size > 0) listener(scopes);
      }
      last = current;
    }),
    Effect.ignore,
  );

  const loop = Effect.gen(function* () {
    for (;;) {
      yield* poll;
      yield* Effect.sleep(activity.isActive() ? "2 seconds" : "15 seconds");
    }
  });
  const fiber = Effect.runFork(loop.pipe(Effect.retry(Schedule.spaced("5 seconds"))));
  return () => {
    Effect.runFork(Fiber.interrupt(fiber));
  };
};

export const watchRepository = (repo: Repository, listener: ChangeListener): (() => void) =>
  repo.host.kind === "local" ? watchLocal(repo, listener) : watchRemote(repo, listener);
