/**
 * Exercises Repository operations in throwaway repositories, locally and (when
 * `GITDOVE_INT_SSH_HOST` is set) on a remote host under /tmp. Each test gets a
 * fresh repository with two commits on `main` and a bare `origin` it is pushed to.
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphInfo, RepoLocation } from "@shared/domain";
import { SshError } from "../exec/errors";
import { type Host, Hosts, HostsLive, LOCAL_HOST } from "../exec/hosts";
import { authorKey, exceptionKey } from "@shared/visibility";
import { Repository } from "./repository";

const targets: string[] = [LOCAL_HOST];
if (process.env.GITDOVE_INT_SSH_HOST) targets.push(process.env.GITDOVE_INT_SSH_HOST);

const IDENTITY = "git config user.name T && git config user.email t@x";

// The local host runs scripts with /bin/sh.
describe.skipIf(process.platform === "win32").each(targets)("Repository ops on %s", (hostId) => {
  const runtime = ManagedRuntime.make(Layer.mergeAll(HostsLive));
  let host: Host;
  let root = "";
  let dir = "";
  let origin = "";
  let repo: Repository;
  let n = 0;

  const run = <A, E>(effect: Effect.Effect<A, E, Hosts>) => runtime.runPromise(effect);
  const fails = <A, E>(effect: Effect.Effect<A, E, Hosts>) =>
    runtime.runPromise(Effect.flip(effect));
  const sh = async (script: string, cwd = dir) =>
    (await run(host.sh(script, { cwd }))).stdout.toString().trim();
  const head = () => sh("git rev-parse HEAD");
  const branchRef = async (name: string) => {
    const refs = await run(repo.refs());
    return refs.refs.find((r) => r.name === `refs/heads/${name}`);
  };
  const open = (path: string) => {
    const location: RepoLocation =
      hostId === LOCAL_HOST ? { kind: "local", path } : { kind: "ssh", host: hostId, path };
    return run(Repository.open(host, location, { onGraphProgress: () => {} }));
  };
  /** A clone of `origin` that can push commits for `repo` to pull. */
  const otherClone = async () => {
    const other = `${root}/other${n}`;
    await sh(`git clone -q '${origin}' '${other}' && cd '${other}' && ${IDENTITY}`, root);
    return other;
  };

  beforeAll(async () => {
    host = await run(Effect.map(Hosts, (hosts) => hosts.get(hostId)));
    root = (await run(host.sh("mktemp -d /tmp/gitdove-ops.XXXXXX"))).stdout.toString().trim();
  });

  afterAll(async () => {
    if (root) await run(host.sh(`rm -rf -- '${root}'`));
    await runtime.dispose();
  });

  beforeEach(async () => {
    n++;
    dir = `${root}/repo${n}`;
    origin = `${root}/origin${n}.git`;
    await sh(
      `git init -q --bare -b main '${origin}' && mkdir '${dir}' && cd '${dir}' && ` +
        `git init -q -b main . && ${IDENTITY} && ` +
        "printf 'a\\nb\\nc\\n' > f.txt && git add f.txt && git commit -qm one && " +
        "printf 'a\\nb\\nc\\nd\\n' > f.txt && git commit -qam two && " +
        `git remote add origin '${origin}' && git push -q -u origin main`,
      root,
    );
    repo = await open(dir);
  });

  it("rejects invalid input before running git", async () => {
    for (const index of [Number.NaN, 1.5, -1, 2 ** 53]) {
      for (const op of [repo.stashPop(index), repo.stashApply(index), repo.stashDrop(index)]) {
        expect((await fails(op))._tag).toBe("InvalidInputError");
      }
    }
    for (const name of ["-x", "a b", "a..b", "a~1", "a^", "a:b", "a?", "a*", "a[", "a\\b"]) {
      expect((await fails(repo.createBranch(name, "HEAD", false)))._tag).toBe("InvalidInputError");
    }
    for (const name of ["x/", "x.lock", "a@{b"]) {
      expect((await fails(repo.renameBranch("main", name)))._tag).toBe("InvalidInputError");
    }
    for (const rev of ["", "-p", "a\nb"]) {
      expect((await fails(repo.checkout(rev)))._tag).toBe("InvalidInputError");
    }
    expect((await fails(repo.commit("  \n", { amend: false })))._tag).toBe("InvalidInputError");
    // Nothing happened.
    expect((await run(repo.refs())).refs.map((r) => r.short)).toEqual(["main", "origin/main"]);
  });

  it("applies stash entries by index", async () => {
    await sh("echo one > f.txt");
    await run(repo.stash("first", false));
    await sh("echo two > f.txt && echo u > u.txt");
    await run(repo.stash(null, true));
    let stashes = (await run(repo.refs())).stashes;
    expect(stashes.map((s) => s.index)).toEqual([0, 1]);
    expect(stashes[1]!.message).toContain("first");
    await run(repo.stashApply(1));
    expect(await sh("cat f.txt")).toBe("one");
    await run(repo.discard(["f.txt"], []));
    await run(repo.stashDrop(1));
    stashes = (await run(repo.refs())).stashes;
    expect(stashes).toHaveLength(1);
    await run(repo.stashPop(0));
    expect(await sh("cat f.txt u.txt")).toBe("two\nu");
    expect((await run(repo.refs())).stashes).toEqual([]);
    expect((await fails(repo.stashPop(0)))._tag).toBe("CommandError");
  });

  it("manages branches and upstreams", async () => {
    await run(repo.createBranch("topic", "HEAD~1", false));
    expect((await branchRef("topic"))?.hash).toBe(await sh("git rev-parse HEAD~1"));
    await run(repo.renameBranch("topic", "feature/topic"));
    await run(repo.checkout("feature/topic"));
    let info = await run(repo.info());
    expect(info.head).toMatchObject({ branch: "feature/topic", detached: false });

    await run(repo.setUpstream("feature/topic", "origin/main"));
    expect(await branchRef("feature/topic")).toMatchObject({
      upstream: "refs/remotes/origin/main",
      ahead: 0,
      behind: 1,
    });
    await run(repo.setUpstream("feature/topic", null));
    expect((await branchRef("feature/topic"))?.upstream).toBeNull();

    await run(repo.checkout("HEAD~0"));
    await run(repo.checkout(await head()));
    info = await run(repo.info());
    expect(info.head.detached).toBe(true);
    await run(repo.checkout("main"));

    // An unmerged branch needs force.
    await run(repo.createBranch("scratch", "HEAD", true));
    await sh("echo s > s.txt && git add s.txt && git commit -qm scratch");
    await run(repo.checkout("main"));
    expect((await fails(repo.deleteBranch("scratch", false)))._tag).toBe("CommandError");
    await run(repo.deleteBranch("scratch", true));
    expect(await branchRef("scratch")).toBeUndefined();
  });

  it("merges, rebases, cherry-picks and reverts", async () => {
    const base = await head();
    await run(repo.createBranch("side", "HEAD~1", true));
    await sh("echo s > s.txt && git add s.txt && git commit -qm side");
    const side = await head();
    await run(repo.checkout("main"));

    expect((await fails(repo.merge("side", { ffOnly: true })))._tag).toBe("CommandError");
    await run(repo.merge("side", { noFf: true }));
    expect((await sh("git rev-list --parents -n1 HEAD")).split(" ")).toEqual([
      await head(),
      base,
      side,
    ]);

    await run(repo.reset(base, "hard"));
    await run(repo.checkout("side"));
    await run(repo.rebase("main"));
    expect(await sh("git rev-parse HEAD~1")).toBe(base);
    expect(await sh("git log -1 --format=%s")).toBe("side");

    await run(repo.checkout("main"));
    await run(repo.cherryPick("side"));
    expect(await sh("git log -1 --format=%s")).toBe("side");
    await run(repo.revert("HEAD"));
    expect(await sh("git log -1 --format=%s")).toBe('Revert "side"');
    expect(await sh("ls")).toBe("f.txt");
  });

  it("resets in every mode", async () => {
    const two = await head();
    await run(repo.reset("HEAD~1", "soft"));
    expect((await run(repo.status())).staged.map((f) => f.path)).toEqual(["f.txt"]);
    await run(repo.reset(two, "hard"));
    await run(repo.reset("HEAD~1", "mixed"));
    let st = await run(repo.status());
    expect([st.staged.length, st.unstaged.map((f) => f.path)]).toEqual([0, ["f.txt"]]);
    await run(repo.reset(two, "hard"));
    st = await run(repo.status());
    expect([st.staged.length, st.unstaged.length]).toEqual([0, 0]);
  });

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
      const commit = run(repo.commit("Add e", { amend: false })).then(() => order.push("commit"));
      await until(() => exists("pre-commit.started"));
      const tag = run(repo.createTag("t1", "HEAD", null)).then(() => order.push("tag"));

      // Reads go ahead while the commit holds the lock.
      expect((await run(repo.status())).staged.map((f) => f.path)).toEqual(["e.txt"]);
      expect(await run(repo.lastCommitMessage())).toBe("two");
      await new Promise((r) => setTimeout(r, 200));
      expect(await sh("git tag")).toBe("");

      await sh("touch go");
      await Promise.all([commit, tag]);
      expect(order).toEqual(["commit", "tag"]);
      // The tag waited for the commit, so it points at it.
      expect(await sh("git rev-parse t1^{commit}")).toBe(await head());
    });

    it("releases the lock after a failure", async () => {
      expect((await fails(repo.checkout("nope")))._tag).toBe("CommandError");
      await run(repo.createBranch("after", "HEAD", false));
      expect(await branchRef("after")).toBeDefined();
    });

    it("cancels a pull together with the merge it runs", async () => {
      // origin and the clone diverge, so the pull merges; the merge waits in a hook.
      const other = await otherClone();
      await sh("echo o > o.txt && git add o.txt && git commit -qm other && git push -q", other);
      await sh("echo l > l.txt && git add l.txt && git commit -qm local");
      const before = await head();
      await blockingHook("pre-merge-commit");
      const pull = fails(repo.pull("merge"));
      await until(() => exists("pre-merge-commit.started"));
      await run(repo.cancel());
      expect((await pull)._tag).toBe("CancelledError");
      // Let a surviving merge go on: it must not commit.
      await sh("touch go");
      await new Promise((r) => setTimeout(r, 500));
      expect(await head()).toBe(before);
      await run(repo.createBranch("after-cancel", "HEAD", false));
      expect(await branchRef("after-cancel")).toBeDefined();
    });

    it("cancels a running push and lets the next write run", async () => {
      await blockingHook("pre-push");
      await sh("echo e > e.txt && git add e.txt && git commit -qm three");
      const push = fails(repo.push({ force: false, setUpstream: false }));
      await until(() => exists("pre-push.started"));
      const branch = run(repo.createBranch("queued", "HEAD", false));
      await run(repo.cancel());
      expect((await push)._tag).toBe("CancelledError");
      await branch;
      expect(await branchRef("queued")).toBeDefined();
      expect(await sh(`git -C '${origin}' rev-parse main`)).not.toBe(await head());
      // Cancelling with nothing running does nothing.
      await run(repo.cancel());
      await sh("touch go");
    });
  });

  describe("conflicts", () => {
    /** Leaves `main` and `side` with conflicting edits to f.txt. */
    const diverge = async () => {
      await run(repo.createBranch("side", "HEAD", true));
      await sh("echo side > f.txt && git commit -qam side");
      await run(repo.checkout("main"));
      await sh("echo main > f.txt && git commit -qam main");
    };
    const state = async () => (await run(repo.info())).state;
    const resolve = async () => {
      await sh("echo resolved > f.txt");
      await run(repo.stage(["f.txt"]));
    };

    it("aborts and continues a merge", async () => {
      await diverge();
      expect((await fails(repo.merge("side", {})))._tag).toBe("CommandError");
      expect(await state()).toBe("merging");
      expect((await run(repo.status())).conflicted.map((f) => f.path)).toEqual(["f.txt"]);
      await run(repo.abortOperation());
      expect(await state()).toBe("clean");

      await fails(repo.merge("side", {}));
      await resolve();
      await run(repo.continueOperation());
      expect(await state()).toBe("clean");
      expect(await sh("git log -1 --format=%p")).toContain(" ");
    });

    it("aborts and continues a rebase", async () => {
      await diverge();
      await fails(repo.rebase("side"));
      expect(await state()).toBe("rebasing");
      await run(repo.abortOperation());
      expect(await state()).toBe("clean");
      expect(await sh("git log -1 --format=%s")).toBe("main");

      await fails(repo.rebase("side"));
      await resolve();
      await sh("git config core.editor true");
      await run(repo.continueOperation());
      expect(await state()).toBe("clean");
      expect(await sh("git log -2 --format=%s")).toBe("main\nside");
    });

    it("aborts and continues a cherry-pick", async () => {
      await diverge();
      await fails(repo.cherryPick("side"));
      expect(await state()).toBe("cherry-picking");
      await run(repo.abortOperation());
      expect(await state()).toBe("clean");

      await fails(repo.cherryPick("side"));
      await resolve();
      await sh("git config core.editor true");
      await run(repo.continueOperation());
      expect(await state()).toBe("clean");
      expect(await sh("git log -1 --format=%s")).toBe("side");
    });

    it("aborts and continues a revert", async () => {
      await sh("echo three > f.txt && git commit -qam three");
      await fails(repo.revert("HEAD~1"));
      expect(await state()).toBe("reverting");
      await run(repo.abortOperation());
      expect(await state()).toBe("clean");

      await fails(repo.revert("HEAD~1"));
      await resolve();
      await sh("git config core.editor true");
      await run(repo.continueOperation());
      expect(await state()).toBe("clean");
      expect(await sh("git log -1 --format=%s")).toBe('Revert "two"');
    });

    it("resets a bisect and ignores a clean state", async () => {
      await run(repo.abortOperation());
      await run(repo.continueOperation());
      await sh("git bisect start HEAD HEAD~1");
      expect(await state()).toBe("bisecting");
      await run(repo.continueOperation()); // Nothing to continue.
      expect(await state()).toBe("bisecting");
      await run(repo.abortOperation());
      expect(await state()).toBe("clean");
    });
  });

  it("stages, unstages, discards and applies patches", async () => {
    await sh("printf 'A\\nb\\nc\\nD\\n' > f.txt && echo u > u.txt");
    await run(repo.stageAll());
    expect((await run(repo.status())).staged.map((f) => f.path)).toEqual(["f.txt", "u.txt"]);
    await run(repo.unstage(["u.txt"]));
    expect((await run(repo.status())).staged.map((f) => f.path)).toEqual(["f.txt"]);
    await run(repo.unstageAll());
    expect((await run(repo.status())).staged).toEqual([]);

    // Stage only the first hunk through a patch, then take it back out.
    const patch = "--- a/f.txt\n+++ b/f.txt\n@@ -1,4 +1,4 @@\n-a\n+A\n b\n c\n d\n";
    await run(repo.applyPatch(patch, { cached: true, reverse: false }));
    expect(await sh("git diff --cached --numstat")).toBe("1\t1\tf.txt");
    await run(repo.applyPatch(patch, { cached: true, reverse: true }));
    expect(await sh("git diff --cached --numstat")).toBe("");

    await run(repo.discard(["f.txt"], ["u.txt"]));
    const st = await run(repo.status());
    expect([st.staged, st.unstaged]).toEqual([[], []]);
    await run(repo.discard([], [])); // No-op.
  });

  it("unstages in a repository without commits", async () => {
    const fresh = `${root}/fresh${n}`;
    await sh(`mkdir '${fresh}' && cd '${fresh}' && git init -q -b main . && echo x > x.txt`, root);
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

  it("commits, amends and searches history", async () => {
    await sh("echo e > e.txt && git add e.txt");
    await run(repo.commit("Add e\n\n# keep?\nBody\n\n\n", { amend: false }));
    expect(await run(repo.lastCommitMessage())).toBe("Add e\n\nBody");
    await run(repo.commit("Add e, amended", { amend: true }));
    expect(await sh("git rev-list --count HEAD")).toBe("3");
    expect(await run(repo.lastCommitMessage())).toBe("Add e, amended");

    const hash = await head();
    expect(await run(repo.search("amended"))).toEqual([hash]);
    expect(await run(repo.search(hash.slice(0, 8)))).toContain(hash);
    expect(await run(repo.search("no such commit"))).toEqual([]);

    const details = await run(repo.commitDetails(hash));
    expect(details).toMatchObject({ subject: "Add e, amended", body: "" });
    expect(details.files.map((f) => [f.path, f.additions])).toEqual([["e.txt", 1]]);
    const root0 = await run(repo.commitDetails(await sh("git rev-list --max-parents=0 HEAD")));
    expect(root0.files.map((f) => f.path)).toEqual(["f.txt"]);
  });

  it("diffs commits, the index and the working tree", async () => {
    await sh("echo e >> f.txt && git add f.txt && echo w >> f.txt");
    const staged = await run(repo.diff({ kind: "staged", path: "f.txt" }));
    const unstaged = await run(repo.diff({ kind: "unstaged", path: "f.txt" }));
    const commit = await run(repo.diff({ kind: "commit", hash: await head(), path: "f.txt" }));
    const added = (d: typeof staged) =>
      d.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "add").map((l) => l.text));
    expect([added(staged), added(unstaged), added(commit)]).toEqual([["e"], ["w"], ["d"]]);
    await sh("git mv f.txt g.txt && git commit -qm move");
    const renamed = await run(
      repo.diff({ kind: "commit", hash: await head(), path: "g.txt", oldPath: "f.txt" }),
    );
    expect(added(renamed)).toEqual(["e"]);
    await sh("echo u > u.txt");
    const untracked = await run(repo.diff({ kind: "unstaged", path: "u.txt", untracked: true }));
    expect(added(untracked)).toEqual(["u"]);
    const first = await sh("git rev-list --max-parents=0 HEAD");
    const rootDiff = await run(repo.diff({ kind: "commit", hash: first, path: "f.txt" }));
    expect(added(rootDiff)).toEqual(["a", "b", "c"]);
    expect((await fails(repo.diff({ kind: "commit", hash: "-x", path: "f.txt" })))._tag).toBe(
      "InvalidInputError",
    );
  });

  it("compares commits, also from the empty tree", async () => {
    await sh(
      "echo x > x.txt && git add x.txt && git commit -qm x && echo y >> f.txt && git commit -qam y",
    );
    const tip = await head();
    const base = await sh("git rev-parse HEAD~2");
    const range = await run(repo.compare(base, tip));
    expect(range.base).toBe(base);
    expect(range.files.map((f) => [f.path, f.kind, f.additions])).toEqual([
      ["f.txt", "modified", 1],
      ["x.txt", "added", 1],
    ]);
    const all = await run(repo.compare(null, tip));
    expect(all.base).toMatch(/^[0-9a-f]{40}$/);
    expect(all.files.map((f) => f.path)).toEqual(["f.txt", "x.txt"]);
    expect((await fails(repo.compare("-x", tip)))._tag).toBe("InvalidInputError");

    // Diffs over the range, and from the empty tree.
    const added = (d: { hunks: readonly { lines: readonly { kind: string; text: string }[] }[] }) =>
      d.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "add").map((l) => l.text));
    expect(added(await run(repo.diff({ kind: "commit", hash: tip, base, path: "f.txt" })))).toEqual(
      ["y"],
    );
    const fromNothing = await run(
      repo.diff({ kind: "commit", hash: tip, base: all.base, path: "x.txt" }),
    );
    expect(added(fromNothing)).toEqual(["x"]);
    const versions = await run(
      repo.fileVersions({ kind: "commit", hash: tip, base, path: "x.txt" }),
    );
    expect(versions.old.kind).toBe("missing");
    expect(
      (await fails(repo.diff({ kind: "commit", hash: tip, base: "-x", path: "f.txt" })))._tag,
    ).toBe("InvalidInputError");
  });

  it("serves graph rows by version", async () => {
    let g = await run(repo.graphInfo());
    while (!g.complete) g = await run(repo.graphInfo());
    expect(g.count).toBe(2);
    const rows = await run(repo.graphRows(g.version, 0, 10));
    expect(rows.map((r) => r.hash)).toEqual([await head(), await sh("git rev-parse HEAD~1")]);
    expect(await run(repo.graphRows(g.version, 1, 0))).toEqual([]);
    expect(await run(repo.findCommit(g.version, rows[1]!.hash))).toBe(1);
    expect(await run(repo.findCommit(g.version, "0".repeat(40)))).toBe(-1);
    expect((await fails(repo.graphRows(g.version + 1, 0, 10)))._tag).toBe("StaleGraphError");
    expect((await fails(repo.findCommit(g.version + 1, rows[0]!.hash)))._tag).toBe(
      "StaleGraphError",
    );
  });

  it("finds branch owners and filters the graph by contributor", async () => {
    const commitAs = (branch: string, who: string) =>
      `git checkout -q -b ${branch} main && git -c user.name=${who} -c user.email=${who}@x ` +
      `commit -q --allow-empty -m ${branch}`;
    await sh(`${commitAs("ann", "Ann")} && ${commitAs("bob", "Bob")} && git checkout -q main`);
    const { owners } = await run(repo.refs());
    expect(owners.byRef).toEqual({ "refs/heads/ann": ["ann@x"], "refs/heads/bob": ["bob@x"] });
    expect(owners.names).toMatchObject({ "ann@x": "Ann", "bob@x": "Bob" });
    expect(owners.me).toBe("t@x");

    let version = 0;
    /** Rows in the next complete graph. */
    const count = async () => {
      let g = await run(repo.graphInfo());
      while (!g.complete || g.version <= version) {
        await new Promise((r) => setTimeout(r, 10));
        g = await run(repo.graphInfo());
      }
      version = g.version;
      return g.count;
    };
    expect(await count()).toBe(4);
    repo.setHiddenRefs([authorKey("ann@x")]);
    expect(await count()).toBe(3);
    repo.setHiddenRefs([authorKey("ann@x"), exceptionKey("refs/heads/ann")]);
    expect(await count()).toBe(4);
  });

  describe("remotes", () => {
    it("pushes, sets upstreams and deletes remote branches and tags", async () => {
      await sh("echo x >> f.txt && git commit -qam three");
      await run(repo.push({ force: false, setUpstream: false }));
      expect(await sh(`git --git-dir='${origin}' log -1 --format=%s main`)).toBe("three");

      await run(repo.createBranch("topic", "HEAD", true));
      await run(repo.push({ force: false, setUpstream: true }));
      expect((await branchRef("topic"))?.upstream).toBe("refs/remotes/origin/topic");

      await run(repo.reset("HEAD~1", "hard"));
      expect((await fails(repo.push({ force: false, setUpstream: false })))._tag).toBe(
        "CommandError",
      );
      await run(repo.push({ force: true, setUpstream: false }));
      expect(await sh(`git --git-dir='${origin}' log -1 --format=%s topic`)).toBe("two");

      await run(repo.createTag("v1", "HEAD", null));
      await run(repo.pushTag("origin", "v1"));
      expect(await sh(`git --git-dir='${origin}' tag`)).toBe("v1");
      await run(repo.deleteRemoteTag("origin", "v1"));
      await run(repo.deleteTag("v1"));
      expect(await sh(`git --git-dir='${origin}' tag`)).toBe("");
      expect(await sh("git tag")).toBe("");

      await run(repo.deleteRemoteBranch("origin", "topic"));
      expect(await sh(`git --git-dir='${origin}' branch`)).toBe("* main");
      await run(repo.fetch("origin"));
      expect((await branchRef("topic"))?.upstreamGone).toBe(true);

      await run(repo.checkout("HEAD~0"));
      await run(repo.checkout(await head()));
      expect((await fails(repo.push({ force: false, setUpstream: true })))._tag).toBe(
        "InvalidInputError",
      );
    });

    it("pushes branches that are not checked out", async () => {
      await run(repo.createBranch("a", "HEAD~1", false));
      await run(repo.pushBranch("a", false));
      expect((await branchRef("a"))?.upstream).toBe("refs/remotes/origin/a");
      await run(repo.createBranch("b", "HEAD", false));
      await run(repo.setUpstream("b", "origin/a"));
      await run(repo.pushBranch("b", false)); // Pushes to its upstream, origin/a.
      expect(await sh(`git --git-dir='${origin}' rev-parse a`)).toBe(await head());
      await run(repo.reset("HEAD~1", "hard"));
      await run(repo.createBranch("c", "HEAD", false));
      await run(repo.setUpstream("c", "origin/a"));
      expect((await fails(repo.pushBranch("c", false)))._tag).toBe("CommandError");
      await run(repo.pushBranch("c", true));
      expect(await sh(`git --git-dir='${origin}' rev-parse a`)).toBe(await head());
    });

    it("pulls and fast-forwards from upstream", async () => {
      const other = await otherClone();
      await sh("echo o >> f.txt && git commit -qam other && git push -q", other);
      const otherHead = await sh("git rev-parse HEAD", other);

      await run(repo.createBranch("behind", "HEAD", false));
      await run(repo.setUpstream("behind", "origin/main"));
      await run(repo.fetch(null));
      await run(repo.fastForwardBranch("behind"));
      expect((await branchRef("behind"))?.hash).toBe(otherHead);
      await run(repo.createBranch("loose", "HEAD", false));
      expect((await fails(repo.fastForwardBranch("loose")))._tag).toBe("InvalidInputError");

      await run(repo.pull("ff-only"));
      expect(await head()).toBe(otherHead);

      // Diverge: a merge pull makes a merge commit, a rebase pull a linear history.
      await sh("echo o2 > o.txt && git add o.txt && git commit -qm other2 && git push -q", other);
      await sh("echo l > l.txt && git add l.txt && git commit -qm local");
      expect((await fails(repo.pull("ff-only")))._tag).toBe("CommandError");
      await run(repo.pull("rebase"));
      expect(await sh("git log -3 --format=%s")).toBe("local\nother2\nother");
      await sh("echo o3 > o3.txt && git add o3.txt && git commit -qm other3 && git push -q", other);
      await run(repo.pull("merge"));
      expect((await sh("git rev-list --parents -n1 HEAD")).split(" ")).toHaveLength(3);
    });

    it("adds, updates and removes remotes", async () => {
      await run(repo.addRemote("mirror", "/nonexistent/mirror.git"));
      await run(repo.setRemoteUrl("mirror", origin));
      await run(repo.fetch("mirror"));
      const refs = await run(repo.refs());
      expect(refs.remotes).toContainEqual({ name: "mirror", fetchUrl: origin, pushUrl: origin });
      expect(refs.refs.map((r) => r.short)).toContain("mirror/main");
      await run(repo.checkoutRemote("mirror/main", "from-mirror"));
      expect((await branchRef("from-mirror"))?.upstream).toBe("refs/remotes/mirror/main");
      await run(repo.removeRemote("mirror"));
      expect((await run(repo.refs())).remotes.map((r) => r.name)).toEqual(["origin"]);

      await run(repo.removeRemote("origin"));
      expect((await fails(repo.push({ force: false, setUpstream: true })))._tag).toBe(
        "InvalidInputError",
      );
      // Removing the remote also drops the upstream configuration that pointed at it.
      expect((await fails(repo.pushBranch("main", false)))._tag).toBe("InvalidInputError");
    });
  });

  it("manages worktrees and submodules", async () => {
    const wt = `${root}/wt${n}`;
    await run(repo.addWorktree(wt, "HEAD~1", "wt-branch"));
    let refs = await run(repo.refs());
    expect(refs.worktrees.map((w) => w.branch)).toContain("wt-branch");
    await sh(`rm -rf -- '${wt}'`);
    await run(repo.pruneWorktrees());
    refs = await run(repo.refs());
    expect(refs.worktrees).toHaveLength(1);

    await run(repo.addWorktree(wt, "main~1", null));
    await sh(`echo dirty > '${wt}/f.txt'`);
    expect((await fails(repo.removeWorktree(wt, false)))._tag).toBe("WorktreeNeedsForceError");
    await run(repo.removeWorktree(wt, true));
    // Forcing also removes a locked worktree.
    await run(repo.addWorktree(wt, "main~1", null));
    await sh(`git worktree lock '${wt}'`);
    expect((await fails(repo.removeWorktree(wt, false)))._tag).toBe("WorktreeNeedsForceError");
    await run(repo.removeWorktree(wt, true));
    // A locked worktree whose folder is gone can still be forced.
    await run(repo.addWorktree(wt, "main~1", null));
    await sh(`git worktree lock '${wt}' && rm -rf -- '${wt}'`);
    // The sidebar passes the path as git lists it (resolved, e.g. /private/tmp on macOS).
    const [gone] = (await run(repo.refs())).worktrees.filter((w) => w.locked);
    expect((await fails(repo.removeWorktree(gone!.path, false)))._tag).toBe(
      "WorktreeNeedsForceError",
    );
    await run(repo.removeWorktree(gone!.path, true));
    expect((await run(repo.refs())).worktrees).toHaveLength(1);
    // Other failures are not something forcing fixes.
    expect((await fails(repo.removeWorktree(`${root}/no-such-worktree`, false)))._tag).toBe(
      "CommandError",
    );
    expect((await run(repo.refs())).worktrees).toHaveLength(1);

    await sh(
      `git -c protocol.file.allow=always submodule add -q '${origin}' sub && git commit -qm sub && ` +
        "rm -rf sub && mkdir sub",
    );
    expect((await run(repo.refs())).submodules.map((s) => s.path)).toEqual(["sub"]);
    await sh("git config protocol.file.allow always");
    await run(repo.updateSubmodule("sub"));
    expect(await sh("cat sub/f.txt")).toBe("a\nb\nc\nd");

    // A worktree with a checked out submodule is clean, but git removes it only by force.
    const subWt = `${root}/subwt${n}`;
    await run(repo.addWorktree(subWt, "HEAD", null));
    await sh(`git -c protocol.file.allow=always -C '${subWt}' submodule update -q --init`);
    expect(await sh(`git -C '${subWt}' status --porcelain`)).toBe("");
    expect((await fails(repo.removeWorktree(subWt, false)))._tag).toBe("WorktreeNeedsForceError");
    await run(repo.removeWorktree(subWt, true));
  });
});

describe.skipIf(process.platform === "win32")("Repository graph over a dropped connection", () => {
  const runtime = ManagedRuntime.make(Layer.mergeAll(HostsLive));
  let local: Host;
  let dir = "";
  const run = <A, E>(effect: Effect.Effect<A, E, Hosts>) => runtime.runPromise(effect);
  const sh = async (script: string) =>
    (await run(local.sh(script, { cwd: dir }))).stdout.toString().trim();

  beforeAll(async () => {
    local = await run(Effect.map(Hosts, (h) => h.get(LOCAL_HOST)));
  });
  beforeEach(async () => {
    dir = (await run(local.sh("mktemp -d /tmp/gitdove-drop.XXXXXX"))).stdout.toString().trim();
  });
  afterEach(() => sh(`rm -rf -- '${dir}'`));
  afterAll(() => runtime.dispose());

  /** Makes a repository with `n` commits on main. */
  const commits = (n: number) =>
    sh(
      `git init -q -b main . && awk 'BEGIN { for (i = 1; i <= ${n}; i++) ` +
        `printf "commit refs/heads/main\\ncommitter T <t@x> %d +0000\\ndata <<EOF\\nc%d\\nEOF\\n\\n", ` +
        `1700000000 + i, i }' | git fast-import --quiet`,
    );
  const history = async () => (await sh("git rev-list HEAD")).split("\n");

  /**
   * Opens the repository through a host that loses the connection while streaming `git log`:
   * each queued drop is the fraction of the output that arrives first.
   */
  const openFlaky = async () => {
    const drops: number[] = [];
    let streams = 0;
    const host: Host = {
      ...local,
      exec: (program, args, options = {}) => {
        const { onStdout } = options;
        if (!onStdout) return local.exec(program, args, options);
        streams++;
        const drop = drops.shift();
        if (drop === undefined) return local.exec(program, args, options);
        return local.exec(program, args, { ...options, onStdout: undefined }).pipe(
          Effect.flatMap((r) => {
            onStdout(r.stdout.subarray(0, Math.floor(r.stdout.length * drop)));
            return Effect.fail(
              new SshError({ message: "Lost connection", host: "x", stderr: "", mayHaveRun: true }),
            );
          }),
        );
      },
    };
    const events: GraphInfo[] = [];
    const repo = await run(
      Repository.open(
        host,
        { kind: "local", path: dir },
        { onGraphProgress: (_, info) => void events.push(info) },
      ),
    );
    return { repo, drops, events, streams: () => streams };
  };
  const until = (check: () => boolean) =>
    vi.waitFor(() => expect(check()).toBe(true), { timeout: 20000, interval: 20 });
  const hashes = async (repo: Repository, info: GraphInfo) =>
    (await run(repo.graphRows(info.version, 0, info.count))).map((r) => r.hash);

  it("reloads the whole graph instead of streaming it twice", async () => {
    await commits(5);
    const { repo, drops, streams } = await openFlaky();
    drops.push(0.5);
    // The first caller waits through the reload.
    const g = await run(repo.graphInfo());
    expect(g).toMatchObject({ count: 5, complete: true });
    expect(g.error).toBeUndefined();
    expect(streams()).toBe(2);
    expect(await hashes(repo, g)).toEqual(await history());
  });

  it("finishes loading on its own after losing the connection again and again", async () => {
    await commits(2100);
    const { repo, drops, events, streams } = await openFlaky();
    drops.push(0.98, 0.5);
    const first = await run(repo.graphInfo());
    expect(first.complete).toBe(false);
    expect(first.count).toBeGreaterThanOrEqual(2000);

    // Nobody asks for the graph again: it is reloaded in the background.
    await until(() => events.at(-1)?.complete === true);
    const last = events.at(-1)!;
    expect(last.count).toBe(2100);
    expect(last.error).toBeUndefined();
    expect(streams()).toBe(3);
    expect(events.some((e) => e.error === "Lost connection" && !e.complete)).toBe(true);
    // The rows on screen are kept until a reload has more of them.
    events.forEach((e, i) => expect(e.count).toBeGreaterThanOrEqual(events[i - 1]?.count ?? 0));
    expect(await hashes(repo, last)).toEqual(await history());
  });

  it("keeps the outdated graph, and says why, until a reload succeeds", async () => {
    await commits(5);
    const { repo, drops, events } = await openFlaky();
    let g = await run(repo.graphInfo());
    while (!g.complete) g = await run(repo.graphInfo());

    await sh("git -c user.name=T -c user.email=t@x commit -q --allow-empty -m c6");
    drops.push(0.5);
    repo.invalidateGraph();
    await until(() => events.some((e) => e.error !== undefined));
    expect(events.find((e) => e.error !== undefined)).toMatchObject({
      version: g.version,
      count: 5,
      complete: true,
      error: "Lost connection",
    });
    await until(() => events.at(-1)?.count === 6);
    expect(events.at(-1)!.complete).toBe(true);
    expect(events.at(-1)!.error).toBeUndefined();
  });

  it("stops loading once the repository is closed", async () => {
    await commits(5);
    const { repo, drops, streams } = await openFlaky();
    drops.push(...Array<number>(10).fill(0.5));
    const waiting = run(repo.graphInfo());
    await until(() => streams() === 1);
    repo.dispose();
    await expect(waiting).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(streams()).toBe(1);
    repo.invalidateGraph();
    expect((await run(repo.graphInfo())).complete).toBe(false);
    expect(streams()).toBe(1);
  });
});
