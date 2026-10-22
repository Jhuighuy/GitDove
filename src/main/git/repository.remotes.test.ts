/** Fetching, pulling and pushing, and managing remotes. See `repository.fixture.ts` for the setup. */
import { describe, expect, it } from "vitest";
import { noShell, targets, useRepoFixture } from "./repository.fixture";

describe.skipIf(noShell).each(targets)("Repository remotes on %s", (hostId) => {
  const t = useRepoFixture(hostId);
  const { run, fails, sh, head, branchRef, otherClone } = t;

  describe("remotes", () => {
    it("pushes, sets upstreams and deletes remote branches and tags", async () => {
      await sh("echo x >> f.txt && git commit -qam three");
      await run(t.repo.push({ force: false, setUpstream: false }));
      expect(await sh(`git --git-dir='${t.origin}' log -1 --format=%s main`)).toBe("three");

      await run(t.repo.createBranch("topic", "HEAD", true));
      await run(t.repo.push({ force: false, setUpstream: true }));
      expect((await branchRef("topic"))?.upstream).toBe("refs/remotes/origin/topic");

      await run(t.repo.reset("HEAD~1", "hard"));
      expect((await fails(t.repo.push({ force: false, setUpstream: false })))._tag).toBe(
        "CommandError",
      );
      await run(t.repo.push({ force: true, setUpstream: false }));
      expect(await sh(`git --git-dir='${t.origin}' log -1 --format=%s topic`)).toBe("two");

      await run(t.repo.createTag("v1", "HEAD", null));
      await run(t.repo.pushTag("origin", "v1"));
      expect(await sh(`git --git-dir='${t.origin}' tag`)).toBe("v1");
      await run(t.repo.deleteRemoteTag("origin", "v1"));
      await run(t.repo.deleteTag("v1"));
      expect(await sh(`git --git-dir='${t.origin}' tag`)).toBe("");
      expect(await sh("git tag")).toBe("");

      await run(t.repo.deleteRemoteBranch("origin", "topic"));
      expect(await sh(`git --git-dir='${t.origin}' branch`)).toBe("* main");
      await run(t.repo.fetch("origin"));
      expect((await branchRef("topic"))?.upstreamGone).toBe(true);

      await run(t.repo.checkout("HEAD~0"));
      await run(t.repo.checkout(await head()));
      expect((await fails(t.repo.push({ force: false, setUpstream: true })))._tag).toBe(
        "InvalidInputError",
      );
    });

    it("pushes branches that are not checked out", async () => {
      await run(t.repo.createBranch("a", "HEAD~1", false));
      await run(t.repo.pushBranch("a", false));
      expect((await branchRef("a"))?.upstream).toBe("refs/remotes/origin/a");
      await run(t.repo.createBranch("b", "HEAD", false));
      await run(t.repo.setUpstream("b", "origin/a"));
      await run(t.repo.pushBranch("b", false)); // Pushes to its upstream, origin/a.
      expect(await sh(`git --git-dir='${t.origin}' rev-parse a`)).toBe(await head());
      await run(t.repo.reset("HEAD~1", "hard"));
      await run(t.repo.createBranch("c", "HEAD", false));
      await run(t.repo.setUpstream("c", "origin/a"));
      expect((await fails(t.repo.pushBranch("c", false)))._tag).toBe("CommandError");
      await run(t.repo.pushBranch("c", true));
      expect(await sh(`git --git-dir='${t.origin}' rev-parse a`)).toBe(await head());
    });

    it("pulls and fast-forwards from upstream", async () => {
      const other = await otherClone();
      await sh("echo o >> f.txt && git commit -qam other && git push -q", other);
      const otherHead = await sh("git rev-parse HEAD", other);

      await run(t.repo.createBranch("behind", "HEAD", false));
      await run(t.repo.setUpstream("behind", "origin/main"));
      await run(t.repo.fetch(null));
      await run(t.repo.fastForwardBranch("behind"));
      expect((await branchRef("behind"))?.hash).toBe(otherHead);
      await run(t.repo.createBranch("loose", "HEAD", false));
      expect((await fails(t.repo.fastForwardBranch("loose")))._tag).toBe("InvalidInputError");

      await run(t.repo.pull("ff-only"));
      expect(await head()).toBe(otherHead);

      // Diverge: a merge pull makes a merge commit, a rebase pull a linear history.
      await sh("echo o2 > o.txt && git add o.txt && git commit -qm other2 && git push -q", other);
      await sh("echo l > l.txt && git add l.txt && git commit -qm local");
      expect((await fails(t.repo.pull("ff-only")))._tag).toBe("CommandError");
      await run(t.repo.pull("rebase"));
      expect(await sh("git log -3 --format=%s")).toBe("local\nother2\nother");
      await sh("echo o3 > o3.txt && git add o3.txt && git commit -qm other3 && git push -q", other);
      await run(t.repo.pull("merge"));
      expect((await sh("git rev-list --parents -n1 HEAD")).split(" ")).toHaveLength(3);
    });

    it("adds, updates and removes remotes", async () => {
      await run(t.repo.addRemote("mirror", "/nonexistent/mirror.git"));
      await run(t.repo.setRemoteUrl("mirror", t.origin));
      await run(t.repo.fetch("mirror"));
      const refs = await run(t.repo.refs());
      expect(refs.remotes).toContainEqual({
        name: "mirror",
        fetchUrl: t.origin,
        pushUrl: t.origin,
      });
      expect(refs.refs.map((r) => r.short)).toContain("mirror/main");
      await run(t.repo.checkoutRemote("mirror/main", "from-mirror"));
      expect((await branchRef("from-mirror"))?.upstream).toBe("refs/remotes/mirror/main");
      await run(t.repo.removeRemote("mirror"));
      expect((await run(t.repo.refs())).remotes.map((r) => r.name)).toEqual(["origin"]);

      await run(t.repo.removeRemote("origin"));
      expect((await fails(t.repo.push({ force: false, setUpstream: true })))._tag).toBe(
        "InvalidInputError",
      );
      // Removing the remote also drops the upstream configuration that pointed at it.
      expect((await fails(t.repo.pushBranch("main", false)))._tag).toBe("InvalidInputError");
    });
  });
});
