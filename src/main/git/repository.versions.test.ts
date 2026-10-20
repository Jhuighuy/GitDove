/**
 * Reads file versions from a throwaway repository, locally and (when
 * `GITDOVE_INT_SSH_HOST` is set) on a remote host under /tmp.
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DiffTarget, FileContent, RepoLocation } from "@shared/domain";
import { type Host, Hosts, HostsLive, LOCAL_HOST } from "../exec/hosts";
import { Repository } from "./repository";

const text = (c: FileContent) => (c.kind === "blob" ? new TextDecoder().decode(c.bytes) : c.kind);

const targets: string[] = [LOCAL_HOST];
if (process.env.GITDOVE_INT_SSH_HOST) targets.push(process.env.GITDOVE_INT_SSH_HOST);

// The local host runs scripts with /bin/sh.
describe.skipIf(process.platform === "win32").each(targets)(
  "Repository.fileVersions on %s",
  (hostId) => {
    const runtime = ManagedRuntime.make(Layer.mergeAll(HostsLive));
    let host: Host;
    let dir = "";
    let repo: Repository;
    let first = "";
    let second = "";

    const run = <A, E>(effect: Effect.Effect<A, E, Hosts>) => runtime.runPromise(effect);
    const sh = (script: string) => run(host.sh(script, { cwd: dir }));
    const versions = async (target: DiffTarget) => {
      const v = await run(repo.fileVersions(target));
      return [text(v.old), text(v.new)];
    };

    beforeAll(async () => {
      host = await run(Effect.map(Hosts, (hosts) => hosts.get(hostId)));
      dir = (await run(host.sh("mktemp -d /tmp/gitdove-versions.XXXXXX"))).stdout.toString().trim();
      await sh(
        "git init -q -b main . && git config user.name T && git config user.email t@x && " +
          "printf one > 'a b.txt' && git add . && git commit -qm one && " +
          "printf two > 'a b.txt' && printf new > added.txt && git add . && git commit -qm two && " +
          "printf staged > 'a b.txt' && git add 'a b.txt' && printf work > 'a b.txt' && " +
          "printf untracked > u.txt",
      );
      [second, first] = (await sh("git rev-list HEAD")).stdout.toString().trim().split("\n") as [
        string,
        string,
      ];
      const location: RepoLocation =
        hostId === LOCAL_HOST
          ? { kind: "local", path: dir }
          : { kind: "ssh", host: hostId, path: dir };
      repo = await run(Repository.open(host, location, { onGraphProgress: () => {} }));
    });

    afterAll(async () => {
      if (dir) await sh(`rm -rf '${dir}'`);
      await runtime.dispose();
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
      await sh("rm added.txt && ln -s 'a b.txt' link.txt");
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
      const size = 21 * 1024 * 1024;
      await sh(`dd if=/dev/zero of=big.bin bs=1048576 count=21 2>/dev/null && git add big.bin`);
      expect(await run(repo.fileVersions({ kind: "staged", path: "big.bin" }))).toEqual({
        old: { kind: "missing" },
        new: { kind: "large", size },
      });
      expect((await run(repo.fileVersions({ kind: "unstaged", path: "big.bin" }))).new).toEqual({
        kind: "large",
        size,
      });
    });

    it("follows renames and reads only regular files", async () => {
      const hash = (
        await sh(
          "git reset -q --hard && git clean -qfd && git mv 'a b.txt' 'c*d.txt' && " +
            "ln -s 'c*d.txt' link.png && mkdir real && printf r > real/x.png && " +
            "git add -A && git commit -qm three && git rev-parse HEAD",
        )
      ).stdout
        .toString()
        .trim();
      const renamed = { kind: "commit", hash, path: "c*d.txt", oldPath: "a b.txt" } as const;
      expect(await versions(renamed)).toEqual(["two", "two"]);
      expect(await versions({ ...renamed, oldPath: undefined })).toEqual(["missing", "two"]);
      const diff = await run(repo.diff(renamed));
      expect([diff.oldPath, diff.hunks]).toEqual(["a b.txt", []]);
      // Symlinks are stored as blobs holding the link target.
      expect(await versions({ kind: "commit", hash, path: "link.png" })).toEqual([
        "missing",
        "missing",
      ]);
      // A directory replaced by a symlink to elsewhere must not be read through.
      await sh(`rm -r real && d=$(mktemp -d) && printf outside > "$d/x.png" && ln -s "$d" real`);
      expect(await versions({ kind: "unstaged", path: "real/x.png" })).toEqual(["r", "missing"]);
    });

    it("compares a merge conflict with our side", async () => {
      await sh(
        "git reset -q --hard && git clean -qfd && git checkout -qb side && " +
          "printf side > c.txt && git add c.txt && git commit -qm side && git checkout -q main && " +
          "printf main > c.txt && git add c.txt && git commit -qm main && (git merge -q side || true)",
      );
      const [old, next] = await versions({ kind: "unstaged", path: "c.txt" });
      expect(old).toBe("main");
      expect(next).toContain("<<<<<<<");
    });

    it("rejects paths outside the working tree", async () => {
      for (const path of ["../x", "/etc/passwd", "a/../../x", ""]) {
        await expect(run(repo.fileVersions({ kind: "unstaged", path }))).rejects.toThrow(
          /Invalid path/,
        );
      }
    });
  },
);
