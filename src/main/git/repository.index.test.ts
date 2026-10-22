/** Staging, discarding, stashing, diffs and comparisons. See `repository.fixture.ts` for the setup. */
import { describe, expect, it } from "vitest";
import { added, noShell, targets, useRepoFixture } from "./repository.fixture";

describe.skipIf(noShell).each(targets)("Repository index and diffs on %s", (hostId) => {
  const t = useRepoFixture(hostId);
  const { run, fails, sh, head, open } = t;

  it("applies stash entries by index", async () => {
    await sh("echo one > f.txt");
    await run(t.repo.stash("first", false));
    await sh("echo two > f.txt && echo u > u.txt");
    await run(t.repo.stash(null, true));
    let stashes = (await run(t.repo.refs())).stashes;
    expect(stashes.map((s) => s.index)).toEqual([0, 1]);
    expect(stashes[1]!.message).toContain("first");
    await run(t.repo.stashApply(1));
    expect(await sh("cat f.txt")).toBe("one");
    await run(t.repo.discard(["f.txt"], []));
    await run(t.repo.stashDrop(1));
    stashes = (await run(t.repo.refs())).stashes;
    expect(stashes).toHaveLength(1);
    await run(t.repo.stashPop(0));
    expect(await sh("cat f.txt u.txt")).toBe("two\nu");
    expect((await run(t.repo.refs())).stashes).toEqual([]);
    expect((await fails(t.repo.stashPop(0)))._tag).toBe("CommandError");
  });

  it("stages, unstages, discards and applies patches", async () => {
    await sh("printf 'A\\nb\\nc\\nD\\n' > f.txt && echo u > u.txt");
    await run(t.repo.stageAll());
    expect((await run(t.repo.status())).staged.map((f) => f.path)).toEqual(["f.txt", "u.txt"]);
    await run(t.repo.unstage(["u.txt"]));
    expect((await run(t.repo.status())).staged.map((f) => f.path)).toEqual(["f.txt"]);
    await run(t.repo.unstageAll());
    expect((await run(t.repo.status())).staged).toEqual([]);

    // Stage only the first hunk through a patch, then take it back out.
    const patch = "--- a/f.txt\n+++ b/f.txt\n@@ -1,4 +1,4 @@\n-a\n+A\n b\n c\n d\n";
    await run(t.repo.applyPatch(patch, { cached: true, reverse: false }));
    expect(await sh("git diff --cached --numstat")).toBe("1\t1\tf.txt");
    await run(t.repo.applyPatch(patch, { cached: true, reverse: true }));
    expect(await sh("git diff --cached --numstat")).toBe("");

    await run(t.repo.discard(["f.txt"], ["u.txt"]));
    const st = await run(t.repo.status());
    expect([st.staged, st.unstaged]).toEqual([[], []]);
    await run(t.repo.discard([], [])); // No-op.
  });

  it("unstages in a repository without commits", async () => {
    const fresh = `${t.root}/fresh${t.n}`;
    await sh(
      `mkdir '${fresh}' && cd '${fresh}' && git init -q -b main . && echo x > x.txt`,
      t.root,
    );
    const r = await open(fresh);
    await run(r.stageAll());
    expect((await run(r.status())).staged.map((f) => f.path)).toEqual(["x.txt"]);
    await run(r.unstage(["x.txt"]));
    expect((await run(r.status())).staged).toEqual([]);
    await run(r.stageAll());
    await run(r.unstageAll());
    expect((await run(r.status())).staged).toEqual([]);
    expect((await run(r.info())).head).toEqual({ branch: "main", hash: null, detached: false });
  });

  it("diffs commits, the index and the working tree", async () => {
    await sh("echo e >> f.txt && git add f.txt && echo w >> f.txt");
    const staged = await run(t.repo.diff({ kind: "staged", path: "f.txt" }));
    const unstaged = await run(t.repo.diff({ kind: "unstaged", path: "f.txt" }));
    const commit = await run(t.repo.diff({ kind: "commit", hash: await head(), path: "f.txt" }));
    expect([added(staged), added(unstaged), added(commit)]).toEqual([["e"], ["w"], ["d"]]);
    await sh("git mv f.txt g.txt && git commit -qm move");
    const renamed = await run(
      t.repo.diff({ kind: "commit", hash: await head(), path: "g.txt", oldPath: "f.txt" }),
    );
    expect(added(renamed)).toEqual(["e"]);
    await sh("echo u > u.txt");
    const untracked = await run(t.repo.diff({ kind: "unstaged", path: "u.txt", untracked: true }));
    expect(added(untracked)).toEqual(["u"]);
    const first = await sh("git rev-list --max-parents=0 HEAD");
    const rootDiff = await run(t.repo.diff({ kind: "commit", hash: first, path: "f.txt" }));
    expect(added(rootDiff)).toEqual(["a", "b", "c"]);
    expect((await fails(t.repo.diff({ kind: "commit", hash: "-x", path: "f.txt" })))._tag).toBe(
      "InvalidInputError",
    );
  });

  it("compares commits, also from the empty tree", async () => {
    await sh(
      "echo x > x.txt && git add x.txt && git commit -qm x && echo y >> f.txt && git commit -qam y",
    );
    const tip = await head();
    const base = await sh("git rev-parse HEAD~2");
    const range = await run(t.repo.compare(base, tip));
    expect(range.base).toBe(base);
    expect(range.files.map((f) => [f.path, f.kind, f.additions])).toEqual([
      ["f.txt", "modified", 1],
      ["x.txt", "added", 1],
    ]);
    const all = await run(t.repo.compare(null, tip));
    expect(all.base).toMatch(/^[0-9a-f]{40}$/);
    expect(all.files.map((f) => f.path)).toEqual(["f.txt", "x.txt"]);
    expect((await fails(t.repo.compare("-x", tip)))._tag).toBe("InvalidInputError");

    // Diffs over the range, and from the empty tree.
    expect(
      added(await run(t.repo.diff({ kind: "commit", hash: tip, base, path: "f.txt" }))),
    ).toEqual(["y"]);
    const fromNothing = await run(
      t.repo.diff({ kind: "commit", hash: tip, base: all.base, path: "x.txt" }),
    );
    expect(added(fromNothing)).toEqual(["x"]);
    const versions = await run(
      t.repo.fileVersions({ kind: "commit", hash: tip, base, path: "x.txt" }),
    );
    expect(versions.old.kind).toBe("missing");
    expect(
      (await fails(t.repo.diff({ kind: "commit", hash: tip, base: "-x", path: "f.txt" })))._tag,
    ).toBe("InvalidInputError");
  });
});
