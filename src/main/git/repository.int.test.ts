/**
 * Integration smoke test against real repositories.
 *
 *   GITDOVE_INT_LOCAL=~/some/repo GITDOVE_INT_SSH=host:/path/to/repo npx vitest run int
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import type { RepoLocation } from "@shared/domain";
import { Hosts, HostsLive, LOCAL_HOST } from "../exec/hosts";
import { Repository } from "./repository";

const targets: [string, RepoLocation][] = [];
if (process.env.GITDOVE_INT_LOCAL) {
  targets.push(["local", { kind: "local", path: process.env.GITDOVE_INT_LOCAL }]);
}
if (process.env.GITDOVE_INT_SSH) {
  const [host, path] = process.env.GITDOVE_INT_SSH.split(":");
  targets.push(["ssh", { kind: "ssh", host: host!, path: path! }]);
}

describe.skipIf(targets.length === 0)("Repository (integration)", () => {
  const runtime = ManagedRuntime.make(Layer.mergeAll(HostsLive));

  for (const [name, location] of targets) {
    it(`queries ${name} repository`, async () => {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const hosts = yield* Hosts;
          const host = hosts.get(location.kind === "local" ? LOCAL_HOST : location.host);
          const t0 = performance.now();
          const repo = yield* Repository.open(host, location, { onGraphProgress: () => {} });
          const info = yield* repo.info();
          const t1 = performance.now();
          const [refs, status] = yield* Effect.all([repo.refs(), repo.status()], {
            concurrency: "unbounded",
          });
          const t2 = performance.now();
          let g = yield* repo.graphInfo();
          while (!g.complete) {
            yield* Effect.sleep("50 millis");
            g = yield* repo.graphInfo();
          }
          const t3 = performance.now();
          const rows = yield* repo.graphRows(g.version, 0, 50);
          const details = yield* repo.commitDetails(rows[0]!.hash);
          const file = details.files[0];
          const diff = file
            ? yield* repo.diff({ kind: "commit", hash: details.hash, path: file.path })
            : null;
          const t4 = performance.now();
          console.log(
            `[${name}] ${info.name} head=${info.head.branch} refs=${refs.refs.length} ` +
              `status=${status.staged.length}/${status.unstaged.length} commits=${g.count} lanes=${g.maxLanes} ` +
              `open=${(t1 - t0).toFixed(0)}ms refs+status=${(t2 - t1).toFixed(0)}ms ` +
              `graph=${(t3 - t2).toFixed(0)}ms details+diff=${(t4 - t3).toFixed(0)}ms hunks=${diff?.hunks.length}`,
          );
          return { info, g };
        }),
      );
      expect(result.g.count).toBeGreaterThan(0);
    });
  }
});
