/** Branches, merges, resets, commits and history search. See `repository.fixture.ts` for the setup. */
import { describe, expect, it } from "vitest";
import { noShell, targets, useRepoFixture } from "./repository.fixture";

describe.skipIf(noShell).each(targets)(
  "Repository branches, history and commits on %s",
  (hostId) => {
    const t = useRepoFixture(hostId);
    const { run, fails, sh, head, branchRef } = t;

    it("rejects invalid input before running git", async () => {
      expect((await fails(t.repo.graphRows(1, 0, 100_000)))._tag).toBe("InvalidInputError");
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

    it("never lets names and refs read as options or refspecs", async () => {
      const marker = `${t.dir}/injected`;
      // git runs these remote helpers if the name reaches it as an option.
      const bad = [
        t.repo.fetch(`--upload-pack=touch '${marker}'; git-upload-pack`),
        t.repo.pushTag(`--receive-pack=touch '${marker}'; git-receive-pack`, "v1"),
        t.repo.pushTag("origin", "x:refs/heads/main"),
        t.repo.deleteRemoteBranch("origin", `--receive-pack=touch '${marker}'`),
        t.repo.deleteRemoteTag("origin", "-x"),
        t.repo.createTag("-f", "HEAD", null),
        t.repo.deleteTag("-d"),
        t.repo.removeRemote("-v"),
        t.repo.addRemote("a:b", "/x"),
        t.repo.renameBranch("-M", "x"),
        t.repo.setUpstream("-x", "origin/main"),
        t.repo.reset("HEAD", "merge" as "hard"),
      ];
      for (const op of bad) expect((await fails(op))._tag).toBe("InvalidInputError");
      expect(await sh(`[ -e '${marker}' ] && echo yes || echo no`)).toBe("no");
      expect(await sh(`git --git-dir='${t.origin}' rev-parse main`)).toBe(await head());
    });

    it("tells a branch from a tag with the same name by its full name", async () => {
      const first = await sh("git rev-parse HEAD~1");
      await sh("git tag dup HEAD~1 && git branch dup HEAD");
      await run(t.repo.checkout("refs/tags/dup"));
      expect((await run(t.repo.info())).head).toEqual({
        branch: null,
        hash: first,
        detached: true,
      });
      await run(t.repo.checkout("refs/heads/dup"));
      expect((await run(t.repo.info())).head.branch).toBe("dup");
      const main = await sh("git rev-parse main");
      await run(t.repo.reset("refs/tags/dup", "hard"));
      expect(await head()).toBe(first);
      await run(t.repo.merge("refs/heads/main", { ffOnly: true }));
      expect(await head()).toBe(main);
      await run(t.repo.reset("refs/tags/dup", "hard"));
      await run(t.repo.rebase("refs/heads/main"));
      expect(await head()).toBe(main);
    });

    it("words merge messages after short names, like git", async () => {
      await sh("git branch x HEAD~1 && git checkout -q x && git commit -q --allow-empty -m x1");
      await sh("git tag v1 && git push -q origin x && git checkout -q main");
      const subjectOf = async (ref: string) => {
        await run(t.repo.merge(ref, { noFf: true }));
        const subject = await sh("git log -1 --format=%s");
        await sh("git reset -q --hard HEAD~1");
        return subject;
      };
      expect(await subjectOf("refs/heads/x")).toBe("Merge branch 'x'");
      expect(await subjectOf("refs/remotes/origin/x")).toBe(
        "Merge remote-tracking branch 'origin/x'",
      );
      expect(await subjectOf("refs/tags/v1")).toBe("Merge tag 'v1'");
      // The short name would mean the tag: the branch keeps its full name.
      await sh("git tag x HEAD~1");
      expect(await subjectOf("refs/heads/x")).toBe("Merge branch 'refs/heads/x'");
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
      await run(t.repo.cherryPick(["side"]));
      expect(await sh("git log -1 --format=%s")).toBe("side");
      await run(t.repo.revert(["HEAD"]));
      expect(await sh("git log -1 --format=%s")).toBe('Revert "side"');
      expect(await sh("ls")).toBe("f.txt");
    });

    it("cherry-picks and reverts several commits given in graph order", async () => {
      // Each commit needs the one before it: applied in another order, they would conflict.
      await run(t.repo.createBranch("feat", "HEAD", true));
      await sh(
        "echo 1 > l.txt && git add l.txt && git commit -qm c1 && " +
          "echo 2 >> l.txt && git commit -qam c2 && echo 3 >> l.txt && git commit -qam c3",
      );
      // Newest first, as the graph lists (and selects) them.
      const picked = (await sh("git rev-list -n3 HEAD")).split("\n");
      await run(t.repo.checkout("main"));
      await run(t.repo.cherryPick(picked));
      expect(await sh("git log -4 --format=%s")).toBe("c3\nc2\nc1\ntwo");
      expect(await sh("cat l.txt")).toBe("1\n2\n3");

      const applied = (await sh("git rev-list -n3 HEAD")).split("\n");
      await run(t.repo.revert(applied));
      expect(await sh("git log -3 --format=%s")).toBe('Revert "c1"\nRevert "c2"\nRevert "c3"');
      expect(await sh("ls")).toBe("f.txt");
      expect((await run(t.repo.info())).state).toBe("clean");
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
      // Lines starting with "#" are kept: they are issue references or headings, not comments.
      await run(t.repo.commit("#12 Add e\n\n# Notes\nBody\n\n\n", { amend: false }));
      expect(await run(t.repo.lastCommitMessage())).toBe("#12 Add e\n\n# Notes\nBody");
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
      expect(root0.truncated).toBeUndefined();
    });

    it("lists a merge's files against its first parent, and renames", async () => {
      await sh(
        "git checkout -q -b side HEAD~1 && echo s > s.txt && git add s.txt && git commit -qm s && " +
          "git checkout -q main && git merge -q --no-edit side && " +
          "git mv f.txt g.txt && echo more >> g.txt && git add g.txt && git commit -qm move",
      );
      const move = await run(t.repo.commitDetails(await head()));
      expect(move.files.map((f) => [f.path, f.kind, f.oldPath, f.additions])).toEqual([
        ["g.txt", "renamed", "f.txt", 1],
      ]);
      const merge = await run(t.repo.commitDetails(await sh("git rev-parse HEAD~1")));
      expect(merge.parents).toHaveLength(2);
      expect(merge.subject).toBe("Merge branch 'side'");
      expect(merge.files.map((f) => [f.path, f.kind])).toEqual([["s.txt", "added"]]);
      // The commit's diff is against the first parent too.
      const diff = await run(t.repo.diff({ kind: "commit", hash: merge.hash, path: "s.txt" }));
      expect(diff.hunks[0]!.lines.map((l) => l.text)).toEqual(["s"]);
    });

    it("searches commits reachable from a detached HEAD only", async () => {
      await sh("git checkout -q --detach && git commit -q --allow-empty -m 'detached work'");
      expect(await run(t.repo.search("detached work"))).toEqual([await head()]);
      expect(await run(t.repo.search("T"))).toHaveLength(3);
    });
  },
);
