/** The write lock: writes run one at a time, can be cancelled, and never block reads. See `repository.fixture.ts` for the setup. */
import { describe, expect, it } from "vitest";
import { noShell, targets, useRepoFixture } from "./repository.fixture";

describe.skipIf(noShell).each(targets)("Repository write lock on %s", (hostId) => {
  const t = useRepoFixture(hostId);
  const { run, fails, sh, head, branchRef, otherClone } = t;

  describe("write lock", () => {
    /** Installs a hook that waits for `go` to exist, so the operation running it stays in flight. */
    const blockingHook = (name: string) =>
      sh(
        `printf '#!/bin/sh\\ntouch ${name}.started\\nwhile [ ! -f go ]; do sleep 0.05; done\\n' ` +
          `> .git/hooks/${name} && chmod +x .git/hooks/${name}`,
      );
    const until = async (cond: () => Promise<boolean>) => {
      while (!(await cond())) await new Promise((r) => setTimeout(r, 50));
    };
    const exists = async (file: string) => (await sh(`[ -f ${file} ] && echo y || true`)) === "y";

    it("runs writes one at a time without blocking reads", async () => {
      await blockingHook("pre-commit");
      await sh("echo e > e.txt && git add e.txt");
      const order: string[] = [];
      const commit = run(t.repo.commit("Add e", { amend: false })).then(() => order.push("commit"));
      await until(() => exists("pre-commit.started"));
      const tag = run(t.repo.createTag("t1", "HEAD", null)).then(() => order.push("tag"));

      // Reads go ahead while the commit holds the lock.
      expect((await run(t.repo.status())).staged.map((f) => f.path)).toEqual(["e.txt"]);
      expect(await run(t.repo.lastCommitMessage())).toBe("two");
      await new Promise((r) => setTimeout(r, 200));
      expect(await sh("git tag")).toBe("");

      await sh("touch go");
      await Promise.all([commit, tag]);
      expect(order).toEqual(["commit", "tag"]);
      // The tag waited for the commit, so it points at it.
      expect(await sh("git rev-parse t1^{commit}")).toBe(await head());
    });

    it("releases the lock after a failure", async () => {
      expect((await fails(t.repo.checkout("nope")))._tag).toBe("CommandError");
      await run(t.repo.createBranch("after", "HEAD", false));
      expect(await branchRef("after")).toBeDefined();
    });

    it("cancels a pull together with the merge it runs", async () => {
      // origin and the clone diverge, so the pull merges; the merge waits in a hook.
      const other = await otherClone();
      await sh("echo o > o.txt && git add o.txt && git commit -qm other && git push -q", other);
      await sh("echo l > l.txt && git add l.txt && git commit -qm local");
      const before = await head();
      await blockingHook("pre-merge-commit");
      const pull = fails(t.repo.pull("merge"));
      await until(() => exists("pre-merge-commit.started"));
      await run(t.repo.cancel());
      expect((await pull)._tag).toBe("CancelledError");
      // Let a surviving merge go on: it must not commit.
      await sh("touch go");
      await new Promise((r) => setTimeout(r, 500));
      expect(await head()).toBe(before);
      await run(t.repo.createBranch("after-cancel", "HEAD", false));
      expect(await branchRef("after-cancel")).toBeDefined();
    });

    it("cancels a running push and lets the next write run", async () => {
      await blockingHook("pre-push");
      await sh("echo e > e.txt && git add e.txt && git commit -qm three");
      const push = fails(t.repo.push({ force: false, setUpstream: false }));
      await until(() => exists("pre-push.started"));
      const branch = run(t.repo.createBranch("queued", "HEAD", false));
      await run(t.repo.cancel());
      expect((await push)._tag).toBe("CancelledError");
      await branch;
      expect(await branchRef("queued")).toBeDefined();
      expect(await sh(`git -C '${t.origin}' rev-parse main`)).not.toBe(await head());
      // Cancelling with nothing running does nothing.
      await run(t.repo.cancel());
      await sh("touch go");
    });
  });
});
