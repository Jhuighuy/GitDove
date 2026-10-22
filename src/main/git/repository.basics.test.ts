/** Branches, merges, resets, commits and history search. See `repository.fixture.ts` for the setup. */
import { describe, expect, it } from "vitest";
import { noShell, targets, useRepoFixture } from "./repository.fixture";

describe.skipIf(noShell).each(targets)(
  "Repository branches, history and commits on %s",
  (hostId) => {
    const t = useRepoFixture(hostId);
    const { run, fails, sh, head, branchRef } = t;

    it("rejects invalid input before running git", async () => {
      for (const index of [Number.NaN, 1.5, -1, 2 ** 53]) {
        for (const op of [
          t.repo.stashPop(index),
          t.repo.stashApply(index),
          t.repo.stashDrop(index),
        ]) {
          expect((await fails(op))._tag).toBe("InvalidInputError");
        }
      }
      for (const name of ["-x", "a b", "a..b", "a~1", "a^", "a:b", "a?", "a*", "a[", "a\\b"]) {
        expect((await fails(t.repo.createBranch(name, "HEAD", false)))._tag).toBe(
          "InvalidInputError",
        );
      }
      for (const name of ["x/", "x.lock", "a@{b"]) {
        expect((await fails(t.repo.renameBranch("main", name)))._tag).toBe("InvalidInputError");
      }
      for (const rev of ["", "-p", "a\nb"]) {
        expect((await fails(t.repo.checkout(rev)))._tag).toBe("InvalidInputError");
      }
      expect((await fails(t.repo.commit("  \n", { amend: false })))._tag).toBe("InvalidInputError");
      // Nothing happened.
      expect((await run(t.repo.refs())).refs.map((r) => r.short)).toEqual(["main", "origin/main"]);
    });

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

    it("manages branches and upstreams", async () => {
      await run(t.repo.createBranch("topic", "HEAD~1", false));
      expect((await branchRef("topic"))?.hash).toBe(await sh("git rev-parse HEAD~1"));
      await run(t.repo.renameBranch("topic", "feature/topic"));
      await run(t.repo.checkout("feature/topic"));
      let info = await run(t.repo.info());
      expect(info.head).toMatchObject({ branch: "feature/topic", detached: false });

      await run(t.repo.setUpstream("feature/topic", "origin/main"));
      expect(await branchRef("feature/topic")).toMatchObject({
        upstream: "refs/remotes/origin/main",
        ahead: 0,
        behind: 1,
      });
      await run(t.repo.setUpstream("feature/topic", null));
      expect((await branchRef("feature/topic"))?.upstream).toBeNull();

      await run(t.repo.checkout("HEAD~0"));
      await run(t.repo.checkout(await head()));
      info = await run(t.repo.info());
      expect(info.head.detached).toBe(true);
      await run(t.repo.checkout("main"));

      // An unmerged branch needs force.
      await run(t.repo.createBranch("scratch", "HEAD", true));
      await sh("echo s > s.txt && git add s.txt && git commit -qm scratch");
      await run(t.repo.checkout("main"));
      expect((await fails(t.repo.deleteBranch("scratch", false)))._tag).toBe("CommandError");
      await run(t.repo.deleteBranch("scratch", true));
      expect(await branchRef("scratch")).toBeUndefined();
    });

    it("merges, rebases, cherry-picks and reverts", async () => {
      const base = await head();
      await run(t.repo.createBranch("side", "HEAD~1", true));
      await sh("echo s > s.txt && git add s.txt && git commit -qm side");
      const side = await head();
      await run(t.repo.checkout("main"));

      expect((await fails(t.repo.merge("side", { ffOnly: true })))._tag).toBe("CommandError");
      await run(t.repo.merge("side", { noFf: true }));
      expect((await sh("git rev-list --parents -n1 HEAD")).split(" ")).toEqual([
        await head(),
        base,
        side,
      ]);

      await run(t.repo.reset(base, "hard"));
      await run(t.repo.checkout("side"));
      await run(t.repo.rebase("main"));
      expect(await sh("git rev-parse HEAD~1")).toBe(base);
      expect(await sh("git log -1 --format=%s")).toBe("side");

      await run(t.repo.checkout("main"));
      await run(t.repo.cherryPick("side"));
      expect(await sh("git log -1 --format=%s")).toBe("side");
      await run(t.repo.revert("HEAD"));
      expect(await sh("git log -1 --format=%s")).toBe('Revert "side"');
      expect(await sh("ls")).toBe("f.txt");
    });

    it("resets in every mode", async () => {
      const two = await head();
      await run(t.repo.reset("HEAD~1", "soft"));
      expect((await run(t.repo.status())).staged.map((f) => f.path)).toEqual(["f.txt"]);
      await run(t.repo.reset(two, "hard"));
      await run(t.repo.reset("HEAD~1", "mixed"));
      let st = await run(t.repo.status());
      expect([st.staged.length, st.unstaged.map((f) => f.path)]).toEqual([0, ["f.txt"]]);
      await run(t.repo.reset(two, "hard"));
      st = await run(t.repo.status());
      expect([st.staged.length, st.unstaged.length]).toEqual([0, 0]);
    });

    it("commits, amends and searches history", async () => {
      await sh("echo e > e.txt && git add e.txt");
      await run(t.repo.commit("Add e\n\n# keep?\nBody\n\n\n", { amend: false }));
      expect(await run(t.repo.lastCommitMessage())).toBe("Add e\n\nBody");
      await run(t.repo.commit("Add e, amended", { amend: true }));
      expect(await sh("git rev-list --count HEAD")).toBe("3");
      expect(await run(t.repo.lastCommitMessage())).toBe("Add e, amended");

      const hash = await head();
      expect(await run(t.repo.search("amended"))).toEqual([hash]);
      expect(await run(t.repo.search(hash.slice(0, 8)))).toContain(hash);
      expect(await run(t.repo.search("no such commit"))).toEqual([]);

      const details = await run(t.repo.commitDetails(hash));
      expect(details).toMatchObject({ subject: "Add e, amended", body: "" });
      expect(details.files.map((f) => [f.path, f.additions])).toEqual([["e.txt", 1]]);
      const root0 = await run(t.repo.commitDetails(await sh("git rev-list --max-parents=0 HEAD")));
      expect(root0.files.map((f) => f.path)).toEqual(["f.txt"]);
    });
  },
);
