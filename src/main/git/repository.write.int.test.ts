/**
 * Exercises mutating operations in throwaway repositories, locally and (when
 * `GITDOVE_INT_SSH_HOST` is set) on a remote host under /tmp.
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
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
            yield* repo.discardAll();
            const clean = yield* repo.status();
            expect([...clean.staged, ...clean.unstaged, ...clean.conflicted]).toEqual([]);
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
  }
});
