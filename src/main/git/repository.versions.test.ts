/** Reads file versions from a throwaway local repository. */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DiffTarget, FileContent } from "@shared/domain";
import { Hosts, HostsLive, LOCAL_HOST } from "../exec/hosts";
import { Repository } from "./repository";

const text = (c: FileContent) => (c.kind === "blob" ? new TextDecoder().decode(c.bytes) : c.kind);

// The local host runs scripts with /bin/sh.
describe.skipIf(process.platform === "win32")("Repository.fileVersions", () => {
  const runtime = ManagedRuntime.make(Layer.mergeAll(HostsLive));
  let dir = "";
  let repo: Repository;
  let first = "";
  let second = "";

  const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
  const versions = async (target: DiffTarget) => {
    const v = await run(repo.fileVersions(target));
    return [text(v.old), text(v.new)];
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "gitdove-versions-"));
    await run(
      Effect.gen(function* () {
        const host = (yield* Hosts).get(LOCAL_HOST);
        const sh = (script: string) => host.sh(script, { cwd: dir });
        yield* sh(
          "git init -q -b main . && git config user.name T && git config user.email t@x && " +
            "printf one > 'a b.txt' && git add . && git commit -qm one && " +
            "printf two > 'a b.txt' && printf new > added.txt && git add . && git commit -qm two && " +
            "printf staged > 'a b.txt' && git add 'a b.txt' && printf work > 'a b.txt' && " +
            "printf untracked > u.txt",
        );
        const log = yield* sh("git rev-list HEAD");
        [second, first] = log.stdout.toString().trim().split("\n") as [string, string];
        repo = yield* Repository.open(
          host,
          { kind: "local", path: dir },
          {
            onGraphProgress: () => {},
          },
        );
      }),
    );
  });

  afterAll(async () => {
    await runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads both sides of commits", async () => {
    expect(await versions({ kind: "commit", hash: second, path: "a b.txt" })).toEqual([
      "one",
      "two",
    ]);
    expect(await versions({ kind: "commit", hash: second, path: "added.txt" })).toEqual([
      "missing",
      "new",
    ]);
    // A root commit has no parent side.
    expect(await versions({ kind: "commit", hash: first, path: "a b.txt" })).toEqual([
      "missing",
      "one",
    ]);
  });

  it("reads the index and the working tree", async () => {
    expect(await versions({ kind: "staged", path: "a b.txt" })).toEqual(["two", "staged"]);
    expect(await versions({ kind: "unstaged", path: "a b.txt" })).toEqual(["staged", "work"]);
    expect(await versions({ kind: "unstaged", path: "u.txt", untracked: true })).toEqual([
      "missing",
      "untracked",
    ]);
  });

  it("reports deleted files, directories and symlinks as missing", async () => {
    rmSync(join(dir, "added.txt"));
    symlinkSync("a b.txt", join(dir, "link.txt"));
    expect(await versions({ kind: "unstaged", path: "added.txt" })).toEqual(["new", "missing"]);
    expect(await versions({ kind: "unstaged", path: "link.txt", untracked: true })).toEqual([
      "missing",
      "missing",
    ]);
    expect(await versions({ kind: "commit", hash: second, path: "." })).toEqual([
      "missing",
      "missing",
    ]);
  });

  it("keeps large files out of the transfer", async () => {
    writeFileSync(join(dir, "big.bin"), Buffer.alloc(21 * 1024 * 1024));
    const v = await run(repo.fileVersions({ kind: "unstaged", path: "big.bin", untracked: true }));
    expect(v.new).toEqual({ kind: "large", size: 21 * 1024 * 1024 });
  });

  it("rejects paths outside the working tree", async () => {
    for (const path of ["../x", "/etc/passwd", "a/../../x", ""]) {
      await expect(run(repo.fileVersions({ kind: "unstaged", path }))).rejects.toThrow(
        /Invalid path/,
      );
    }
  });
});
