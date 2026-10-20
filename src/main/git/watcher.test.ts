import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoChangeScope } from "@shared/ipc";
import { Effect } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activity } from "../activity";
import { CommandError } from "../exec/errors";
import type { Host } from "../exec/hosts";
import type { Repository } from "./repository";
import { watchRepository } from "./watcher";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Local repositories (native file system events)
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === "win32")("watchRepository on a local repository", () => {
  let root = "";
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

  const localRepo = (fields: {
    workTree: string;
    gitDir: string;
    commonDir?: string;
    bare?: boolean;
  }) =>
    ({
      host: { kind: "local" } as Host,
      workTree: fields.workTree,
      gitDir: fields.gitDir,
      commonDir: fields.commonDir ?? fields.gitDir,
      bare: fields.bare ?? false,
    }) as unknown as Repository;

  /** Watches a repository and records every notification. */
  const watch = (repo: Repository) => {
    const batches: Set<RepoChangeScope>[] = [];
    const dispose = watchRepository(repo, (s) => batches.push(s));
    disposers.push(dispose);
    const seen = () => new Set(batches.flatMap((b) => [...b]));
    return {
      batches,
      dispose,
      /**
       * Repeats `action` until `scope` is reported. Subscriptions start
       * asynchronously, so the first attempts may go unnoticed.
       */
      until: async (scope: RepoChangeScope, action: () => void) => {
        batches.length = 0;
        for (let i = 0; i < 40 && !seen().has(scope); i++) {
          action();
          await sleep(250);
        }
        expect(seen()).toContain(scope);
      },
      /** Waits until no notification arrived for a while. */
      /** Waits until notifications stop, then clears them; returns how many there were. */
      quiet: async () => {
        let n = -1;
        while (n !== batches.length) {
          n = batches.length;
          await sleep(500);
        }
        batches.length = 0;
        return n;
      },
    };
  };
  const disposers: (() => void)[] = [];

  let counter = 0;
  const touch = (file: string) => writeFileSync(file, `${counter++}\n`);

  const freshRepo = (name: string) => {
    const dir = join(root, name);
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.name", "T");
    git(dir, "config", "user.email", "t@x");
    return dir;
  };

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "gitdove-watch-")));
  });
  afterEach(() => {
    for (const d of disposers.splice(0)) d();
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("classifies work tree, index, HEAD, ref and config changes", async () => {
    const dir = freshRepo("plain");
    const w = watch(localRepo({ workTree: dir, gitDir: join(dir, ".git") }));

    await w.until("worktree", () => touch(join(dir, "a.txt")));
    await w.until("index", () => git(dir, "add", "a.txt"));
    await w.until("head", () =>
      writeFileSync(join(dir, ".git", "HEAD"), `ref: refs/heads/b${counter++}\n`),
    );
    await w.until("refs", () => touch(join(dir, ".git", "packed-refs")));
    await w.until("refs", () => {
      mkdirSync(join(dir, ".git", "rebase-merge"), { recursive: true });
      touch(join(dir, ".git", "rebase-merge", "msgnum"));
    });
    await w.until("config", () => git(dir, "config", "gitdove.test", String(counter++)));
  });

  it("batches a burst of changes into one notification", async () => {
    const dir = freshRepo("burst");
    const w = watch(localRepo({ workTree: dir, gitDir: join(dir, ".git") }));
    await w.until("worktree", () => touch(join(dir, "probe")));
    await w.quiet();
    for (let i = 0; i < 20; i++) touch(join(dir, `f${i}`));
    touch(join(dir, ".git", "FETCH_HEAD"));
    await vi.waitFor(() => expect(w.batches.length).toBeGreaterThan(0));
    // 21 writes in a few milliseconds end up in at most a couple of batches.
    expect(await w.quiet()).toBeLessThanOrEqual(2);
  });

  it("ignores object database writes and unknown git files", async () => {
    const dir = freshRepo("objects");
    const w = watch(localRepo({ workTree: dir, gitDir: join(dir, ".git") }));
    await w.until("worktree", () => touch(join(dir, "probe")));
    await w.quiet();
    mkdirSync(join(dir, ".git", "objects", "ab"), { recursive: true });
    touch(join(dir, ".git", "objects", "ab", "cdef"));
    touch(join(dir, ".git", "description"));
    await sleep(800);
    expect(w.batches).toEqual([]);
  });

  it("stops after dispose", async () => {
    const dir = freshRepo("dispose");
    const w = watch(localRepo({ workTree: dir, gitDir: join(dir, ".git") }));
    await w.until("worktree", () => touch(join(dir, "probe")));
    w.dispose();
    await w.quiet();
    touch(join(dir, "after"));
    await sleep(800);
    expect(w.batches).toEqual([]);
  });

  it("watches the git directory of a bare repository", async () => {
    const dir = join(root, "bare.git");
    mkdirSync(dir);
    git(dir, "init", "-q", "--bare");
    const w = watch(localRepo({ workTree: dir, gitDir: dir, bare: true }));
    await w.until("refs", () => {
      mkdirSync(join(dir, "refs", "heads"), { recursive: true });
      touch(join(dir, "refs", "heads", "main"));
    });
    await w.until("head", () =>
      writeFileSync(join(dir, "HEAD"), `ref: refs/heads/x${counter++}\n`),
    );
  });

  it("watches the private and the common git directory of a linked worktree", async () => {
    const main = freshRepo("main");
    touch(join(main, "a"));
    git(main, "add", "a");
    git(main, "commit", "-qm", "init");
    const wt = join(root, "linked");
    git(main, "worktree", "add", "-q", "-b", "linked", wt);
    const gitDir = join(main, ".git", "worktrees", "linked");
    const w = watch(localRepo({ workTree: wt, gitDir, commonDir: join(main, ".git") }));

    await w.until("worktree", () => touch(join(wt, "b")));
    await w.until("head", () =>
      writeFileSync(join(gitDir, "HEAD"), `ref: refs/heads/y${counter++}\n`),
    );
    await w.until("refs", () => touch(join(main, ".git", "refs", "heads", "other")));
    await w.until("refs", () => {
      mkdirSync(join(main, ".git", "logs", "refs"), { recursive: true });
      touch(join(main, ".git", "logs", "refs", "stash"));
    });
  });

  it("does not throw for a directory that cannot be watched", async () => {
    const missing = join(root, "missing");
    const w = watch(localRepo({ workTree: missing, gitDir: join(missing, ".git") }));
    await sleep(300);
    expect(w.batches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Remote repositories (polling)
// ---------------------------------------------------------------------------

describe("watchRepository on a remote repository", () => {
  const state = (h: string, i: string, r: string, w: string) =>
    `H:${h}\nI:${i}\nR:${r}\nW:${w}\nnoise\n`;

  /** A repository on a fake SSH host; `polls` counts executions of its poll script. */
  const remoteRepo = (outputs: (string | Error)[]) => {
    const polls = vi.fn();
    const sh = vi.fn((_script: string, _options?: { cwd?: string }) =>
      // Like a real host, the command runs every time the effect runs.
      Effect.suspend(() => {
        polls();
        const next = outputs.length > 1 ? outputs.shift()! : outputs[0]!;
        return next instanceof Error
          ? Effect.fail(
              new CommandError({ message: next.message, command: "sh", exitCode: 1, stderr: "" }),
            )
          : Effect.succeed({
              stdout: Buffer.from(next),
              stderr: "",
              exitCode: 0,
              truncated: false,
            });
      }),
    );
    const repo = { host: { kind: "ssh", sh } as unknown as Host, workTree: "/srv/repo" };
    return { repo: repo as unknown as Repository, sh, polls };
  };

  afterEach(() => {
    vi.useRealTimers();
    activity.setFocused(true);
  });

  it("polls cheaply and reports which parts changed", async () => {
    vi.useFakeTimers();
    const { repo, sh, polls } = remoteRepo([
      state("ref: refs/heads/main", "1.10", "111 5", "222 0"),
      state("ref: refs/heads/main", "1.10", "111 5", "222 0"),
      state("ref: refs/heads/dev", "1.10", "111 5", "333 9"),
      new Error("connection reset"),
      state("ref: refs/heads/dev", "2.20", "444 5", "333 9"),
    ]);
    const batches: RepoChangeScope[][] = [];
    const dispose = watchRepository(repo, (s) => batches.push([...s].toSorted()));

    await vi.advanceTimersByTimeAsync(0);
    expect(polls).toHaveBeenCalledTimes(1);
    // Polling only reads, so it may be retried after a dropped connection.
    expect(sh.mock.calls[0]![1]).toEqual({ cwd: "/srv/repo", idempotent: true });
    expect(sh.mock.calls[0]![0]).toContain("git status --porcelain=v2");

    await vi.advanceTimersByTimeAsync(2000);
    expect(polls).toHaveBeenCalledTimes(2);
    expect(batches).toEqual([]);

    await vi.advanceTimersByTimeAsync(2000);
    expect(batches).toEqual([["head", "worktree"]]);

    // A failed poll is skipped; the next one compares against the last success.
    await vi.advanceTimersByTimeAsync(2000);
    expect(polls).toHaveBeenCalledTimes(4);
    expect(batches).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(batches).toEqual([
      ["head", "worktree"],
      ["index", "refs"],
    ]);

    dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(polls).toHaveBeenCalledTimes(5);
  });

  it("polls less often while the app is in the background", async () => {
    vi.useFakeTimers();
    const { repo, polls } = remoteRepo([state("x", "1", "2", "3")]);
    activity.setFocused(false);
    const dispose = watchRepository(repo, () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(polls).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(polls).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(polls).toHaveBeenCalledTimes(2);
    activity.setFocused(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(polls).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2000);
    expect(polls).toHaveBeenCalledTimes(4);
    dispose();
  });
});
