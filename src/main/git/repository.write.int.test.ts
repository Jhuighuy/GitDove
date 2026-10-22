/**
 * Exercises mutating operations in throwaway repositories, locally and (when
 * `GITDOVE_INT_SSH_HOST` is set) on a remote host under /tmp.
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import type { RepoLocation } from "@shared/domain";
import { Hosts, HostsLive, LOCAL_HOST } from "../exec/hosts";
import { Repository } from "./repository";

const targets: [string, string][] = [["local", LOCAL_HOST]];
if (process.env.GITDOVE_INT_SSH_HOST) targets.push(["ssh", process.env.GITDOVE_INT_SSH_HOST]);

/** Waits for a completed graph newer than `after`. */
const waitGraph = (repo: Repository, after = 0) =>
  Effect.gen(function* () {
    for (;;) {
      const g = yield* repo.graphInfo();
      if (g.complete && g.version > after) return g;
      yield* Effect.sleep("30 millis");
    }
  });

// The local host runs scripts with /bin/sh.
describe.skipIf(process.platform === "win32")("Repository write ops (integration)", () => {
  const runtime = ManagedRuntime.make(Layer.mergeAll(HostsLive));
  // Closes the SSH connections, which would otherwise outlive the tests.
  afterAll(() => runtime.dispose());

  for (const [name, hostId] of targets) {
    it(`round-trips edits on ${name}`, async () => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const host = (yield* Hosts).get(hostId);
          const dir = (yield* host.sh("mktemp -d /tmp/gitdove-test.XXXXXX")).stdout
            .toString()
            .trim();
          try {
            yield* host.sh(
              "git init -q -b main . && git config user.name T && git config user.email t@x && " +
                "printf 'a\\nb\\nc\\n' > f.txt && git add f.txt && git commit -qm init",
              { cwd: dir },
            );
            const location: RepoLocation =
              hostId === LOCAL_HOST
                ? { kind: "local", path: dir }
                : { kind: "ssh", host: hostId, path: dir };
            const repo = yield* Repository.open(host, location, { onGraphProgress: () => {} });

            // Edit two hunks' worth, stage only via patch, commit.
            yield* host.sh(
              "printf 'a\\nB\\nc\\nnew file\\n' > f.txt && printf 'x' > 'sp ace.txt'",
              { cwd: dir },
            );
            let st = yield* repo.status();
            expect(st.unstaged.map((f) => [f.path, f.kind])).toEqual([
              ["f.txt", "modified"],
              ["sp ace.txt", "untracked"],
            ]);
            const diff = yield* repo.diff({ kind: "unstaged", path: "f.txt" });
            expect(diff.hunks).toHaveLength(1);
            yield* repo.stage(["sp ace.txt"]);
            st = yield* repo.status();
            expect(st.staged.map((f) => f.path)).toEqual(["sp ace.txt"]);
            yield* repo.unstage(["sp ace.txt"]);
            yield* repo.stageAll();
            yield* repo.commit("Second\n\nBody", { amend: false });
            const info = yield* repo.info();
            const details = yield* repo.commitDetails(info.head.hash!);
            expect(details.subject).toBe("Second");
            expect(details.body).toBe("Body");
            expect(details.files.map((f) => f.path).toSorted()).toEqual(["f.txt", "sp ace.txt"]);

            // Branching, stash and graph.
            yield* repo.createBranch("feature/x", "HEAD~1", true);
            yield* host.sh("echo z >> f.txt", { cwd: dir });
            yield* repo.stash("wip", true);
            const refs = yield* repo.refs();
            expect(refs.stashes).toHaveLength(1);
            expect(refs.refs.find((r) => r.isHead)?.short).toBe("feature/x");
            const g = yield* repo.graphInfo();
            expect(g.count).toBe(3); // 2 commits + 1 stash node (index commit hidden)
            yield* repo.stashPop(0);
            expect((yield* repo.status()).unstaged.map((f) => f.path)).toEqual(["f.txt"]);
            yield* repo.discard(["f.txt"], []);

            // Discard all: staged, unstaged and untracked changes.
            yield* host.sh(
              "echo y >> f.txt && echo n > new.txt && git add new.txt && mkdir -p u && echo u > u/u.txt",
              { cwd: dir },
            );
            // Ignored files stay, even when the ignore rule is itself discarded.
            yield* host.sh("echo .env > .gitignore && git add .gitignore && echo s > .env", {
              cwd: dir,
            });
            yield* repo.discardAll();
            const clean = yield* repo.status();
            expect(clean.staged).toEqual([]);
            expect(clean.conflicted).toEqual([]);
            expect(clean.unstaged.map((f) => [f.path, f.kind])).toEqual([[".env", "untracked"]]);
            yield* host.sh("rm .env", { cwd: dir });
            yield* repo.checkout("main");
            yield* repo.reset("HEAD~1", "hard");
            expect((yield* repo.info()).head.hash).toBe(
              (yield* repo.refs()).refs.find((r) => r.short === "feature/x")?.hash,
            );

            // Graph visibility: hiding feature/x drops its commit from the graph.
            yield* repo.createBranch("side", "HEAD", false);
            yield* repo.checkout("side");
            yield* host.sh("echo s > s.txt && git add s.txt && git commit -qm side", { cwd: dir });
            yield* repo.checkout("main");
            // No watcher here, so refresh the graph explicitly.
            const stale = yield* repo.graphInfo();
            repo.invalidateGraph();
            const before = yield* waitGraph(repo, stale.version);
            repo.setHiddenRefs(["refs/heads/side"]);
            const after = yield* waitGraph(repo, before.version);
            expect(after.count).toBe(before.count - 1);
            repo.setHiddenRefs(["refs/heads/"]); // HEAD stays visible
            expect((yield* waitGraph(repo, after.version)).count).toBeGreaterThan(0);

            // Tags: a message makes an annotated tag, none a lightweight one.
            yield* repo.createTag(
              "v1-annotated",
              "HEAD",
              "Release notes\n\n# Highlights\nDetails.",
            );
            yield* repo.createTag("v1-light", "HEAD", null);
            const tagType = (tag: string) =>
              repo
                .gitText(["cat-file", "-t", `refs/tags/${tag}`])
                .pipe(Effect.map((t) => t.trim()));
            expect(yield* tagType("v1-annotated")).toBe("tag");
            expect(yield* tagType("v1-light")).toBe("commit");
            expect(
              (yield* repo.gitText(["tag", "-l", "--format=%(contents)", "v1-annotated"])).trim(),
            ).toBe("Release notes\n\n# Highlights\nDetails.");

            // Worktrees.
            yield* repo.addWorktree(`${dir}-wt`, "side", null);
            expect((yield* repo.refs()).worktrees.map((w) => w.branch)).toContain("side");
            yield* repo.removeWorktree(`${dir}-wt`, false);
            expect((yield* repo.refs()).worktrees).toHaveLength(1);
          } finally {
            yield* host.sh(`rm -rf -- '${dir}' '${dir}-wt'`).pipe(Effect.ignore);
          }
        }),
      );
    });

    it(`does not delete folders in the way of tracked files on ${name}`, async () => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const host = (yield* Hosts).get(hostId);
          const dir = (yield* host.sh("mktemp -d /tmp/gitdove-test.XXXXXX")).stdout
            .toString()
            .trim();
          try {
            // The tracked file `a` replaced by a repository with work in it.
            yield* host.sh(
              "git init -q -b main . && git config user.name T && git config user.email t@x && " +
                "echo a > a && git add a && git commit -qm a && rm a && mkdir a && " +
                "git -C a init -q && echo n > a/n.txt && echo j > junk.txt",
              { cwd: dir },
            );
            const location: RepoLocation =
              hostId === LOCAL_HOST
                ? { kind: "local", path: dir }
                : { kind: "ssh", host: hostId, path: dir };
            const repo = yield* Repository.open(host, location, { onGraphProgress: () => {} });
            const stopped = yield* Effect.flip(repo.discardAll());
            expect(stopped.message).toBe(
              "Folders are where tracked files belong: a. Move them away first.",
            );
            // Nothing was deleted.
            const left = (yield* host.sh("ls -A . a", { cwd: dir })).stdout.toString();
            expect(left).toContain("n.txt");
            expect(left).toContain(".git");
            expect(left).toContain("junk.txt");
          } finally {
            yield* host.sh(`rm -rf -- '${dir}'`).pipe(Effect.ignore);
          }
        }),
      );
    });

    it(`reports submodule changes it keeps on ${name}`, async () => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const host = (yield* Hosts).get(hostId);
          const dir = (yield* host.sh("mktemp -d /tmp/gitdove-test.XXXXXX")).stdout
            .toString()
            .trim();
          try {
            yield* host.sh(
              `git init -q -b main '${dir}-sub' && echo s > '${dir}-sub/s.txt' && ` +
                `git -C '${dir}-sub' add s.txt && ` +
                `git -C '${dir}-sub' -c user.name=T -c user.email=t@x commit -qm s && ` +
                "git init -q -b main . && git config user.name T && git config user.email t@x && " +
                `git -c protocol.file.allow=always submodule add -q '${dir}-sub' sub && ` +
                "git commit -qm sub && echo x >> sub/s.txt && echo y > top.txt && " +
                // Even when configured to, discarding must not recurse into submodules.
                "git config submodule.recurse true",
              { cwd: dir },
            );
            const location: RepoLocation =
              hostId === LOCAL_HOST
                ? { kind: "local", path: dir }
                : { kind: "ssh", host: hostId, path: dir };
            const repo = yield* Repository.open(host, location, { onGraphProgress: () => {} });
            const kept = yield* Effect.flip(repo.discardAll());
            expect(kept.message).toBe(
              "Discarded the other changes, but kept changes in submodules: sub",
            );
            // The rest is gone; the submodule's own files are untouched.
            const st = yield* repo.status();
            expect(st.unstaged.map((f) => f.path)).toEqual(["sub"]);
            expect((yield* host.sh("cat sub/s.txt", { cwd: dir })).stdout.toString()).toBe(
              "s\nx\n",
            );
          } finally {
            yield* host.sh(`rm -rf -- '${dir}' '${dir}-sub'`).pipe(Effect.ignore);
          }
        }),
      );
    });

    it(`discards everything in a repository without commits on ${name}`, async () => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const host = (yield* Hosts).get(hostId);
          const dir = (yield* host.sh("mktemp -d /tmp/gitdove-test.XXXXXX")).stdout
            .toString()
            .trim();
          try {
            // A staged file edited since differs from both the index and the work tree; a staged
            // ignore rule matches a staged file, and an untracked one.
            yield* host.sh(
              "git init -q -b main . && echo a > a.txt && git add a.txt && echo b >> a.txt && " +
                "echo u > u.txt && printf 'a.txt\\n.env\\n' > .gitignore && git add .gitignore && " +
                "echo s > .env",
              { cwd: dir },
            );
            const location: RepoLocation =
              hostId === LOCAL_HOST
                ? { kind: "local", path: dir }
                : { kind: "ssh", host: hostId, path: dir };
            const repo = yield* Repository.open(host, location, { onGraphProgress: () => {} });
            yield* repo.discardAll();
            const st = yield* repo.status();
            expect([...st.staged, ...st.conflicted]).toEqual([]);
            // Only the file that was ignored is left.
            expect(st.unstaged.map((f) => [f.path, f.kind])).toEqual([[".env", "untracked"]]);
            yield* host.sh("rm .env", { cwd: dir });

            // Untracked nested repositories are kept, and reported.
            yield* host.sh("mkdir nested && git -C nested init -q && echo n > nested/n.txt", {
              cwd: dir,
            });
            const kept = yield* Effect.flip(repo.discardAll());
            expect(kept.message).toContain("kept nested repositories: nested/");

            // A submodule added before the first commit is unstaged, its folder kept.
            yield* host.sh(
              `rm -rf nested && git init -q -b main '${dir}-sub' && echo s > '${dir}-sub/s.txt' && ` +
                `git -C '${dir}-sub' add s.txt && ` +
                `git -C '${dir}-sub' -c user.name=T -c user.email=t@x commit -qm s && ` +
                `git -c protocol.file.allow=always submodule add -q '${dir}-sub' sub && ` +
                "echo x >> sub/s.txt",
              { cwd: dir },
            );
            const sub = yield* Effect.flip(repo.discardAll());
            expect(sub.message).toBe(
              "Discarded the other changes, but kept the folders of new submodules: sub",
            );
            expect((yield* host.sh("cat sub/s.txt", { cwd: dir })).stdout.toString()).toBe(
              "s\nx\n",
            );
            yield* host.sh("rm -rf sub", { cwd: dir });

            // Nothing is discarded in the middle of a merge (or the like).
            yield* host.sh("rm -rf nested && echo x > a.txt && touch .git/MERGE_HEAD", {
              cwd: dir,
            });
            const merging = yield* Effect.flip(repo.discardAll());
            expect(merging.message).toBe("Abort or finish the merging first");
            expect((yield* repo.status()).unstaged.map((f) => f.path)).toEqual(["a.txt"]);
          } finally {
            yield* host.sh(`rm -rf -- '${dir}' '${dir}-sub'`).pipe(Effect.ignore);
          }
        }),
      );
    });
  }
});
