/**
 * The commit graph, the contributor filter, and graph loads that lose the connection. See
 * `repository.fixture.ts` for the setup.
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphInfo } from "@shared/domain";
import { authorKey, personKey } from "@shared/visibility";
import { SshError } from "../exec/errors";
import { type Host, Hosts, HostsLive, LOCAL_HOST } from "../exec/hosts";
import { Repository } from "./repository";
import { noShell, targets, useRepoFixture } from "./repository.fixture";

describe.skipIf(noShell).each(targets)("Repository graph on %s", (hostId) => {
  const t = useRepoFixture(hostId);
  const { run, fails, sh, head } = t;

  it("refuses to open a git directory as a repository", async () => {
    const e = await fails(
      Repository.open(
        t.host,
        { kind: "local", path: `${t.dir}/.git` },
        {
          onGraphProgress: () => {},
        },
      ),
    );
    expect(e).toMatchObject({ _tag: "NotARepositoryError" });
    expect(e.message).toMatch(/Git directory/);
  });

  it("says why a folder is not a repository, with git's own words", async () => {
    const path = `${t.root}/plain${t.n}`;
    await sh(`mkdir -p '${path}'`);
    const e = await fails(
      Repository.open(t.host, { kind: "local", path }, { onGraphProgress: () => {} }),
    );
    expect(e).toMatchObject({ _tag: "NotARepositoryError", path });
    expect(e.message).toBe(`${path} is not a Git repository`);
    expect((e as { stderr: string }).stderr).toMatch(/not a git repository/i);
  });

  it("serves graph rows by version", async () => {
    let g = await run(t.repo.graphInfo());
    while (!g.complete) g = await run(t.repo.graphInfo());
    expect(g.count).toBe(2);
    const rows = await run(t.repo.graphRows(g.version, 0, 10));
    expect(rows.map((r) => r.hash)).toEqual([await head(), await sh("git rev-parse HEAD~1")]);
    expect(await run(t.repo.graphRows(g.version, 1, 0))).toEqual([]);
    expect(await run(t.repo.findCommit(g.version, rows[1]!.hash))).toBe(1);
    expect(await run(t.repo.findCommit(g.version, "0".repeat(40)))).toBe(-1);
    // Several at once, also abbreviated; unknown ones are -1.
    expect(
      await run(
        t.repo.findCommits(g.version, [rows[1]!.hash, "0".repeat(40), rows[0]!.hash.slice(0, 7)]),
      ),
    ).toEqual([1, -1, 0]);
    expect((await fails(t.repo.findCommits(g.version + 1, [rows[0]!.hash])))._tag).toBe(
      "StaleGraphError",
    );
    expect((await fails(t.repo.graphRows(g.version + 1, 0, 10)))._tag).toBe("StaleGraphError");
    expect((await fails(t.repo.findCommit(g.version + 1, rows[0]!.hash)))._tag).toBe(
      "StaleGraphError",
    );
    expect(await run(t.repo.graphHashes(g.version, 0, 100_000))).toEqual(rows.map((r) => r.hash));
    expect(await run(t.repo.graphHashes(g.version, -5, 1))).toEqual([rows[0]!.hash]);
    expect((await fails(t.repo.graphHashes(g.version, 0.5, 1)))._tag).toBe("InvalidInputError");
  });

  /** Waits for a complete graph, newer than `after` if given. */
  const complete = async (repo: Repository, after = 0) => {
    for (;;) {
      const g = await run(repo.graphInfo());
      if (g.complete && g.version > after) return g;
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it("reloads the graph only when refs change", async () => {
    const events: GraphInfo[] = [];
    const repo = await t.open(t.dir, { onGraphProgress: (_, info) => void events.push(info) });
    await sh("git branch other HEAD~1");
    const g = await complete(repo);
    const settled = events.length;

    // A fetch that brings nothing, and checkouts within the graph, keep it.
    await run(repo.fetch("origin"));
    repo.invalidateGraph();
    await sh("git checkout -q other");
    repo.invalidateGraph();
    await sh("git checkout -q --detach main");
    repo.invalidateGraph();
    await new Promise((r) => setTimeout(r, 1000));
    expect(await run(repo.graphInfo())).toEqual(g);
    expect(events).toHaveLength(settled);

    // A new commit (here on a detached HEAD, which no ref reaches) does change it.
    await sh("git commit -q --allow-empty -m detached");
    repo.invalidateGraph();
    const next = await complete(repo, g.version);
    expect(next.count).toBe(3);
    // Moving away from that commit drops it again.
    await sh("git checkout -q main");
    repo.invalidateGraph();
    expect((await complete(repo, next.version)).count).toBe(2);
  });

  it("checks the graph of a hidden repository once it is shown", async () => {
    const events: GraphInfo[] = [];
    const repo = await t.open(t.dir, { onGraphProgress: (_, info) => void events.push(info) });
    const g = await complete(repo);
    const settled = events.length;
    repo.setVisible(false);
    await sh("git commit -q --allow-empty -m hidden");
    repo.invalidateGraph();
    await new Promise((r) => setTimeout(r, 500));
    expect(events).toHaveLength(settled);
    repo.setVisible(true);
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ count: 3, complete: true }));
    expect(events.at(-1)!.version).toBeGreaterThan(g.version);
  });

  it("reloads the graph after its own writes, without file system events", async () => {
    const g = await complete(t.repo);
    await sh("echo e > e.txt && git add e.txt");
    await run(t.repo.commit("e", { amend: false }));
    expect((await complete(t.repo, g.version)).count).toBe(3);
  });

  it("never reuses graph versions, even in a reopened repository", async () => {
    const first = await complete(t.repo);
    const again = await complete(await t.open(t.dir));
    expect(again.version).toBeGreaterThan(first.version);
  });

  it("shows an empty graph for a repository without commits", async () => {
    const fresh = `${t.root}/empty${t.n}`;
    await sh(`mkdir '${fresh}' && git -C '${fresh}' init -q -b main`, t.root);
    expect(await complete(await t.open(fresh))).toMatchObject({ count: 0, complete: true });
  });

  it("finds branch owners and filters the graph by contributor", async () => {
    const commitAs = (branch: string, who: string) =>
      `git checkout -q -b ${branch} main && git -c user.name=${who} -c user.email=${who}@x ` +
      `commit -q --allow-empty -m ${branch}`;
    // An unpushed commit on main is not part of the branches made from it.
    await sh(
      "git -c user.name=Zed -c user.email=zed@x commit -q --allow-empty -m local && " +
        `${commitAs("ann", "Ann")} && ${commitAs("bob", "Bob")} && git checkout -q main`,
    );
    const { owners } = await run(t.repo.refs());
    expect(owners.byRef).toEqual({ "refs/heads/ann": "ann@x", "refs/heads/bob": "bob@x" });
    expect(owners.people["ann@x"]?.name).toBe("Ann");
    expect(owners.people["bob@x"]?.name).toBe("Bob");
    expect(owners.me).toEqual({ email: "t@x", name: "T" });

    let version = 0;
    /** Rows in the next complete graph. */
    const count = async () => {
      let g = await run(t.repo.graphInfo());
      while (!g.complete || g.version <= version) {
        await new Promise((r) => setTimeout(r, 10));
        g = await run(t.repo.graphInfo());
      }
      version = g.version;
      return g.count;
    };
    expect(await count()).toBe(5);
    t.repo.setHiddenRefs([authorKey("ann@x")]);
    expect(await count()).toBe(4);
    t.repo.setHiddenRefs([personKey("bob")]);
    expect(await count()).toBe(4);
    // A tag on Ann's branch does not bring it back, nor does a tag on Cid's.
    await sh(`git tag on-ann ann && ${commitAs("cid", "Cid")} && git checkout -q main`);
    await sh("git tag on-cid cid && git branch -q -D cid");
    t.repo.setHiddenRefs([authorKey("ann@x")]);
    expect(await count()).toBe(4);
    t.repo.setHiddenRefs([]);
    expect(await count()).toBe(6);
    // Dan's branch on top of Bob's is Dan's alone: showing only Bob leaves it out.
    await sh(
      "git checkout -q -b dan bob && git -c user.name=Dan -c user.email=dan@x " +
        "commit -q --allow-empty -m dan && git checkout -q main",
    );
    expect((await run(t.repo.refs())).owners.byRef).toMatchObject({
      "refs/heads/bob": "bob@x",
      "refs/heads/dan": "dan@x",
    });
    t.repo.setHiddenRefs([authorKey("ann@x"), authorKey("dan@x")]);
    expect(await count()).toBe(4);
    t.repo.setHiddenRefs([authorKey("ann@x"), authorKey("bob@x")]);
    expect(await count()).toBe(5);
  });
});

describe.skipIf(noShell)("Repository graph over a dropped connection", () => {
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
