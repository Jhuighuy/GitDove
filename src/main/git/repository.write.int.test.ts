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

describe.skipIf(!process.env.GITDOVE_INT_WRITE)("Repository write ops (integration)", () => {
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
            expect(details.files.map((f) => f.path).sort()).toEqual(["f.txt", "sp ace.txt"]);

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
            yield* repo.checkout("main");
            yield* repo.reset("HEAD~1", "hard");
            expect((yield* repo.info()).head.hash).toBe(
              (yield* repo.refs()).refs.find((r) => r.short === "feature/x")?.hash,
            );
          } finally {
            yield* host.sh(`rm -rf -- '${dir}'`).pipe(Effect.ignore);
          }
        }),
      );
    });
  }
});
