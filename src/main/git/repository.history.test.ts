/**
 * Exercises history editing, patches and undo in throwaway repositories, locally and (when
 * `GITDOVE_INT_SSH_HOST` is set) on a remote host under /tmp. Each test starts from `main` with
 * four commits, each adding a file, and `origin/main` at the second.
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RebaseStep, RepoLocation } from "@shared/domain";
import { type Host, Hosts, HostsLive, LOCAL_HOST } from "../exec/hosts";
import { Repository } from "./repository";

const targets: string[] = [LOCAL_HOST];
if (process.env.GITDOVE_INT_SSH_HOST) targets.push(process.env.GITDOVE_INT_SSH_HOST);

const NO_OPTS = { branch: null, recordOrigin: false, noCommit: false } as const;

describe.skipIf(process.platform === "win32").each(targets)("History editing on %s", (hostId) => {
  const runtime = ManagedRuntime.make(Layer.mergeAll(HostsLive));
  let host: Host;
  let root = "";
  let dir = "";
  let repo: Repository;
  let n = 0;

  const run = <A, E>(effect: Effect.Effect<A, E, Hosts>) => runtime.runPromise(effect);
  const fails = <A, E>(effect: Effect.Effect<A, E, Hosts>) =>
    runtime.runPromise(Effect.flip(effect));
  const sh = async (script: string, cwd = dir) =>
    (await run(host.sh(script, { cwd }))).stdout.toString().trim();
  const subjects = async (rev = "HEAD") => (await sh(`git log --format=%s ${rev}`)).split("\n");
  /** The commits since the root (oldest first) as steps, with actions changed by subject. */
  const steps = async (base: string | null, change: Record<string, Partial<RebaseStep>> = {}) => {
    const todo = await run(repo.rebaseTodo(base));
    return todo.commits.map((c): RebaseStep => ({
      hash: c.hash,
      action: "pick",
      ...change[c.subject],
    }));
  };
  const state = async () => (await run(repo.info())).state;

  beforeAll(async () => {
    host = await run(Effect.map(Hosts, (hosts) => hosts.get(hostId)));
    root = (await run(host.sh("mktemp -d /tmp/gitdove-hist.XXXXXX"))).stdout.toString().trim();
  });

  afterAll(async () => {
    if (root) await run(host.sh(`rm -rf -- '${root}'`));
    await runtime.dispose();
  });

  beforeEach(async () => {
    n++;
    dir = `${root}/repo${n}`;
    const origin = `${root}/origin${n}.git`;
    await sh(
      `git init -q --bare -b main '${origin}' && mkdir '${dir}' && cd '${dir}' && ` +
        "git init -q -b main . && git config user.name T && git config user.email t@x && " +
        "for i in 1 2 3 4; do echo $i > f$i.txt && git add f$i.txt && git commit -qm c$i; done && " +
        `git remote add origin '${origin}' && git push -q -u origin HEAD~2:refs/heads/main`,
      root,
    );
    const location: RepoLocation =
      hostId === LOCAL_HOST
        ? { kind: "local", path: dir }
        : { kind: "ssh", host: hostId, path: dir };
    repo = await run(Repository.open(host, location, { onGraphProgress: () => {} }));
  });

  it("lists the editable history and what a rebase replays", async () => {
    const history = await run(repo.editableHistory());
    expect(history.commits).toHaveLength(4);
    expect(history.head).toBe(await sh("git rev-parse HEAD"));
    expect(history.unpushed).toBe(2);

    const todo = await run(repo.rebaseTodo(await sh("git rev-parse HEAD~3")));
    expect(todo.baseSubject).toBe("c1");
    expect(todo.commits.map((c) => [c.subject, c.pushed])).toEqual([
      ["c2", true],
      ["c3", false],
      ["c4", false],
    ]);
    expect((await run(repo.rebaseTodo(null))).commits).toHaveLength(4);

    // History stops at a merge.
    await sh(
      "git checkout -q -b side HEAD~1 && echo s > s.txt && git add s.txt && git commit -qm s",
    );
    await sh("git checkout -q main && git merge -q --no-ff -m merge side && echo 5 > f5.txt");
    await sh("git add f5.txt && git commit -qm c5");
    const merged = await run(repo.editableHistory());
    expect(merged.commits).toHaveLength(1);
    expect(merged.bottom).toBe(await sh("git rev-parse HEAD~1"));
    expect(history.bottom).toBeNull();
    expect((await run(repo.rebaseTodo(await sh("git rev-parse HEAD~3")))).merges).toBe(1);
  });

  it("reorders, squashes, rewords and drops commits", async () => {
    await sh("echo dirty > f1.txt");
    const plan = await steps(null, {
      c2: { action: "drop" },
      c4: { action: "fixup", message: "c3 and c4\n\nTogether." },
    });
    // c1 moves to the top.
    const [c1, ...rest] = plan;
    expect(await run(repo.rewrite({ base: null, steps: [...rest, c1!], label: "Edit" }))).toBe(
      "done",
    );
    expect(await subjects()).toEqual(["c1", "c3 and c4"]);
    expect(await sh("git log -1 --format=%b HEAD~1")).toBe("Together.");
    expect(await sh("ls")).toBe("f1.txt\nf3.txt\nf4.txt");
    // Uncommitted changes were stashed and restored.
    expect(await sh("cat f1.txt")).toBe("dirty");

    expect(await run(repo.undoState())).toEqual({ undo: "Edit", redo: null });
    expect((await fails(repo.rewrite({ base: null, steps: plan, label: "Stale" })))._tag).toBe(
      "InvalidInputError",
    );
  });

  it("stops to edit a commit and amends it with what is staged", async () => {
    const base = await sh("git rev-parse HEAD~2");
    const plan = await steps(base, { c3: { action: "edit" } });
    expect(await run(repo.rewrite({ base, steps: plan, label: "Edit c3" }))).toBe("stopped");
    const info = await run(repo.info());
    expect(info.state).toBe("rebasing");
    expect(info.operation).toMatchObject({
      branch: "main",
      subject: "c3",
      step: 1,
      total: 2,
      remaining: 1,
      editing: true,
    });
    await sh("echo more > more.txt");
    await run(repo.stage(["more.txt"]));
    expect(await run(repo.continueOperation())).toBe("done");
    expect(await state()).toBe("clean");
    expect(await sh("git show --name-only --format= HEAD~1")).toBe("f3.txt\nmore.txt");
    expect((await run(repo.undoState())).undo).toBe("Edit c3");
  });

  it("stops at conflicts, and reports them on continue until resolved", async () => {
    await sh("echo x >> f4.txt && git commit -qam c5 && echo y >> f4.txt && git commit -qam c6");
    const base = await sh("git rev-parse HEAD~2");
    const [c5, c6] = await steps(base);
    expect(await run(repo.rewrite({ base, steps: [c6!, c5!], label: "Swap" }))).toBe("conflicts");
    const info = await run(repo.info());
    expect(info.operation).toMatchObject({ subject: "c6", editing: false });
    expect((await fails(repo.continueOperation()))._tag).toBe("CommandError");
    await run(repo.abortOperation());
    expect(await state()).toBe("clean");
    expect(await subjects()).toEqual(["c6", "c5", "c4", "c3", "c2", "c1"]);
    expect((await run(repo.undoState())).undo).toBeNull();

    // Skipping the commit that conflicts finishes the rebase, which can then be undone.
    expect(await run(repo.rewrite({ base, steps: [c6!, c5!], label: "Swap" }))).toBe("conflicts");
    expect(await run(repo.skipOperation())).toBe("done");
    expect(await subjects()).toEqual(["c5", "c4", "c3", "c2", "c1"]);
    expect(await run(repo.undo())).toBe("Swap");
    expect(await subjects()).toEqual(["c6", "c5", "c4", "c3", "c2", "c1"]);
  });

  it("rewords any commit without touching the working tree", async () => {
    await sh("echo staged > f2.txt && git add f2.txt && echo dirty > f3.txt");
    const c2 = await sh("git rev-parse HEAD~2");
    const tree = await sh("git rev-parse HEAD^{tree}");
    await run(repo.reword(c2, "Second\n\n# not a comment\nBody  \n\n"));
    expect(await subjects()).toEqual(["c4", "c3", "Second", "c1"]);
    expect(await sh("git log -1 --format=%B HEAD~2")).toBe("Second\n\n# not a comment\nBody");
    expect(await sh("git rev-parse HEAD^{tree}")).toBe(tree);
    expect(await sh("git log -1 --format=%an HEAD~2")).toBe("T");
    expect(await sh("git status --porcelain")).toBe("M  f2.txt\n M f3.txt");

    // Undo and redo move the branch back and forth, keeping the changes.
    expect(await run(repo.undo())).toBe("Reword “Second”");
    expect(await subjects()).toEqual(["c4", "c3", "c2", "c1"]);
    expect(await run(repo.redo())).toBe("Reword “Second”");
    expect(await subjects()).toEqual(["c4", "c3", "Second", "c1"]);
    expect(await sh("git status --porcelain")).toBe("M  f2.txt\n M f3.txt");
  });

  it("cherry-picks onto other branches without checking them out", async () => {
    await run(repo.createBranch("other", "HEAD~3", false));
    const c3 = await sh("git rev-parse HEAD~1");
    const c4 = await sh("git rev-parse HEAD");
    const head = await sh("git rev-parse HEAD");
    await run(repo.cherryPick([c3, c4], { ...NO_OPTS, branch: "other", recordOrigin: true }));
    expect(await subjects("other")).toEqual(["c4", "c3", "c1"]);
    expect(await sh("git log -1 --format=%B other")).toBe(
      `c4\n\n(cherry picked from commit ${c4})`,
    );
    expect(await sh("git rev-parse HEAD")).toBe(head);
    expect(await sh("git show --name-only --format= other")).toBe("f4.txt");

    // Already there: nothing to pick.
    const tip = await sh("git rev-parse other");
    await run(repo.cherryPick([c4], { ...NO_OPTS, branch: "other" }));
    expect(await sh("git rev-parse other")).toBe(tip);

    await sh("git checkout -q -b conflict HEAD~3 && echo no > f4.txt && git add f4.txt");
    await sh("git commit -qm no && git checkout -q main");
    const e = await fails(repo.cherryPick([c4], { ...NO_OPTS, branch: "conflict" }));
    expect(e).toMatchObject({ _tag: "ConflictError", commit: c4 });

    await sh(`git worktree add -q '${dir}-wt' other`);
    expect((await fails(repo.cherryPick([c4], { ...NO_OPTS, branch: "other" })))._tag).toBe(
      "InvalidInputError",
    );
  });

  it("cherry-picks onto the checked out branch, also without committing", async () => {
    await run(repo.createBranch("other", "HEAD~3", true));
    const c4 = await sh("git rev-parse main");
    expect(await run(repo.cherryPick([c4], { ...NO_OPTS, noCommit: true }))).toBe("done");
    expect(await sh("git status --porcelain")).toBe("A  f4.txt");
    await sh("git reset -q --hard");
    expect(await run(repo.cherryPick([c4], { ...NO_OPTS, recordOrigin: true }))).toBe("done");
    expect(await sh("git log -1 --format=%b")).toBe(`(cherry picked from commit ${c4})`);
    expect(await run(repo.undo())).toBe("Cherry-pick “c4”");
    expect(await subjects()).toEqual(["c1"]);
  });

  it("creates, checks and applies patches", async () => {
    const mbox = await run(repo.formatPatch([await sh("git rev-parse HEAD~1"), "HEAD"]));
    expect(mbox.match(/^From [0-9a-f]{40} /gm)).toHaveLength(2);
    await run(repo.createBranch("other", "HEAD~2", true));

    const info = await run(repo.checkPatch(mbox));
    expect(info).toMatchObject({ commits: ["c3", "c4"], applies: "clean", error: null });
    expect(info.files).toEqual([
      { path: "f3.txt", additions: 1, deletions: 0 },
      { path: "f4.txt", additions: 1, deletions: 0 },
    ]);
    expect(await run(repo.applyPatchFile(mbox, "commit"))).toBe("done");
    expect(await subjects()).toEqual(["c4", "c3", "c2", "c1"]);
    expect((await run(repo.undoState())).undo).toBe("Apply 2 patches");

    await sh("echo changed > f1.txt");
    const diff = await run(repo.workingPatch());
    await sh("git checkout -q -- f1.txt");
    expect((await run(repo.checkPatch(diff))).commits).toEqual([]);
    expect(await run(repo.applyPatchFile(diff, "index"))).toBe("done");
    expect(await sh("git status --porcelain")).toBe("M  f1.txt");
    // Applied already: only a three-way merge would do, and it conflicts with nothing.
    expect((await run(repo.checkPatch(diff))).applies).not.toBe("clean");
    expect((await run(repo.checkPatch("nonsense"))).applies).toBe("no");
  });

  describe("undo", () => {
    it("undoes commits into the index, and redoes them", async () => {
      await sh("echo e > e.txt && git add e.txt");
      await run(repo.commit("Add e", { amend: false }));
      expect(await run(repo.undoState())).toEqual({ undo: "Commit “Add e”", redo: null });
      await run(repo.undo());
      expect(await subjects()).toEqual(["c4", "c3", "c2", "c1"]);
      expect(await sh("git status --porcelain")).toBe("A  e.txt");
      expect(await run(repo.undoState())).toEqual({ undo: null, redo: "Commit “Add e”" });
      await run(repo.redo());
      expect(await subjects()).toEqual(["Add e", "c4", "c3", "c2", "c1"]);
      expect(await sh("git status --porcelain")).toBe("");
    });

    it("undoes checkouts, branches, renames and tags", async () => {
      await run(repo.createBranch("topic", "HEAD~1", true));
      await run(repo.renameBranch("topic", "renamed"));
      await run(repo.createTag("v1", "HEAD", "Release"));
      await run(repo.deleteBranch("main", true));
      const branches = () =>
        sh("git for-each-ref --format='%(refname:short)' refs/heads refs/tags");
      expect(await branches()).toBe("renamed\nv1");

      expect(await run(repo.undo())).toBe("Delete branch main");
      expect(await run(repo.undo())).toBe("Create tag v1");
      expect(await run(repo.undo())).toBe("Rename topic to renamed");
      expect(await sh("git symbolic-ref --short HEAD")).toBe("topic");
      expect(await run(repo.undo())).toBe("Create branch topic");
      expect(await sh("git symbolic-ref --short HEAD")).toBe("main");
      expect(await branches()).toBe("main");

      for (let i = 0; i < 4; i++) await run(repo.redo());
      expect(await branches()).toBe("renamed\nv1");
      expect(await sh("git cat-file -t v1")).toBe("tag");
    });

    it("refuses when the repository changed meanwhile, and forgets its history", async () => {
      await run(repo.reset("HEAD~1", "hard"));
      await sh("echo z > z.txt && git add z.txt && git commit -qm outside");
      const e = await fails(repo.undo());
      expect(e._tag).toBe("InvalidInputError");
      expect(e.message).toContain("HEAD has moved since");
      expect(await run(repo.undoState())).toEqual({ undo: null, redo: null });
    });

    it("records a rebase once it is continued to the end", async () => {
      await sh("git checkout -q -b side HEAD~1 && echo s >> f3.txt && git commit -qam s");
      await sh("git checkout -q main && echo m >> f3.txt && git commit -qam m");
      const before = await sh("git rev-parse HEAD");
      expect(await run(repo.rebase("side"))).toBe("conflicts");
      expect((await run(repo.undoState())).undo).toBeNull();
      await sh("echo resolved > f3.txt");
      await run(repo.stage(["f3.txt"]));
      expect(await run(repo.continueOperation())).toBe("done");
      expect((await run(repo.undoState())).undo).toBe("Rebase onto side");
      await run(repo.undo());
      expect(await sh("git rev-parse HEAD")).toBe(before);
    });
  });
});
