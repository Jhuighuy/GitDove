/** Linked worktrees and submodules. See `repository.fixture.ts` for the setup. */
import { describe, expect, it } from "vitest";
import { noShell, targets, useRepoFixture } from "./repository.fixture";

describe.skipIf(noShell).each(targets)("Repository worktrees and submodules on %s", (hostId) => {
  const t = useRepoFixture(hostId);
  const { run, fails, sh } = t;

  it("adds and prunes worktrees", async () => {
    const wt = `${t.root}/wt${t.n}`;
    await run(t.repo.addWorktree(wt, "HEAD~1", "wt-branch"));
    let refs = await run(t.repo.refs());
    expect(refs.worktrees.map((w) => w.branch)).toContain("wt-branch");
    await sh(`rm -rf -- '${wt}'`);
    await run(t.repo.pruneWorktrees());
    refs = await run(t.repo.refs());
    expect(refs.worktrees).toHaveLength(1);
  });

  it("removes changed and locked worktrees only by force", async () => {
    const wt = `${t.root}/wt${t.n}`;
    await run(t.repo.addWorktree(wt, "main~1", null));
    await sh(`echo dirty > '${wt}/f.txt'`);
    expect((await fails(t.repo.removeWorktree(wt, false)))._tag).toBe("WorktreeNeedsForceError");
    await run(t.repo.removeWorktree(wt, true));
    // Forcing also removes a locked worktree.
    await run(t.repo.addWorktree(wt, "main~1", null));
    await sh(`git worktree lock '${wt}'`);
    expect((await fails(t.repo.removeWorktree(wt, false)))._tag).toBe("WorktreeNeedsForceError");
    await run(t.repo.removeWorktree(wt, true));
    // A locked worktree whose folder is gone can still be forced.
    await run(t.repo.addWorktree(wt, "main~1", null));
    await sh(`git worktree lock '${wt}' && rm -rf -- '${wt}'`);
    // The sidebar passes the path as git lists it (resolved, e.g. /private/tmp on macOS).
    const [gone] = (await run(t.repo.refs())).worktrees.filter((w) => w.locked);
    expect((await fails(t.repo.removeWorktree(gone!.path, false)))._tag).toBe(
      "WorktreeNeedsForceError",
    );
    await run(t.repo.removeWorktree(gone!.path, true));
    expect((await run(t.repo.refs())).worktrees).toHaveLength(1);
    // Other failures are not something forcing fixes.
    expect((await fails(t.repo.removeWorktree(`${t.root}/no-such-worktree`, false)))._tag).toBe(
      "CommandError",
    );
    expect((await run(t.repo.refs())).worktrees).toHaveLength(1);
  });

  /** Adds `origin` as a submodule at `path` and commits it. */
  const addSubmodule = (path: string) =>
    sh(
      `git -c protocol.file.allow=always submodule add -q '${t.origin}' '${path}' && ` +
        `git commit -qm 'add ${path}'`,
    );

  it("updates submodules", async () => {
    await addSubmodule("sub");
    await sh("rm -rf sub && mkdir sub");
    expect((await run(t.repo.refs())).submodules.map((s) => s.path)).toEqual(["sub"]);
    await sh("git config protocol.file.allow always");
    await run(t.repo.updateSubmodule("sub"));
    expect(await sh("cat sub/f.txt")).toBe("a\nb\nc\nd");
  });

  it("removes a worktree with a checked out submodule only by force", async () => {
    await addSubmodule("sub");
    // A worktree with a checked out submodule is clean, but git removes it only by force.
    const subWt = `${t.root}/subwt${t.n}`;
    await run(t.repo.addWorktree(subWt, "HEAD", null));
    await sh(`git -c protocol.file.allow=always -C '${subWt}' submodule update -q --init`);
    expect(await sh(`git -C '${subWt}' status --porcelain`)).toBe("");
    expect((await fails(t.repo.removeWorktree(subWt, false)))._tag).toBe("WorktreeNeedsForceError");
    await run(t.repo.removeWorktree(subWt, true));
  });
});
