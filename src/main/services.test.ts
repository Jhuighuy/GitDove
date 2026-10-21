import type { RepoLocation } from "@shared/domain";
import type { RepoChangeScope } from "@shared/ipc";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { NotARepositoryError } from "./exec/errors";
import { type Host, Hosts } from "./exec/hosts";
import type { Repository } from "./git/repository";
import { Notifier, RepoSettings, Repos, ReposLive } from "./services";

interface Hooks {
  readonly onGraphProgress: (repo: Repository, info: unknown) => void;
}
const fake = vi.hoisted(() => ({
  open: null as unknown as ReturnType<typeof vi.fn>,
  watchers: [] as {
    repo: { id: string };
    listener: (s: Set<string>) => void;
    dispose: Mock<() => void>;
  }[],
}));

vi.mock("./git/repository", async () => {
  const { Effect: E } = await import("effect");
  const errors = await import("./exec/errors");
  fake.open = vi.fn((host: Host, location: RepoLocation, hooks: Hooks) =>
    E.gen(function* () {
      // Opening takes a moment, so concurrent opens overlap.
      yield* E.sleep("20 millis");
      if (location.path.startsWith("/missing")) {
        return yield* E.fail(
          new errors.NotARepositoryError({
            message: `${location.path} is not a Git repository`,
            path: location.path,
          }),
        );
      }
      // Sub-directories resolve to the work tree root.
      const path = location.path.replace(/\/sub(\/.*)?$/, "");
      const prefix = location.kind === "local" ? "local:" : `ssh://${location.host}`;
      return {
        id: `${prefix}${path}`,
        host,
        hooks,
        setHiddenRefs: vi.fn(),
        invalidateGraph: vi.fn(),
        dispose: vi.fn(),
      } as unknown as Repository;
    }),
  );
  return { Repository: { open: fake.open } };
});
vi.mock("./git/watcher", () => ({
  watchRepository: vi.fn((repo: { id: string }, listener: (s: Set<string>) => void) => {
    const dispose = vi.fn();
    fake.watchers.push({ repo, listener, dispose });
    return dispose;
  }),
}));

type Events = [string, unknown][];
const setup = () => {
  const events: Events = [];
  const hidden = vi.fn((id: string) => (id === "local:/repo" ? ["refs/heads/secret"] : []));
  const layer = ReposLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Hosts, {
          get: (id: string) => ({ id, kind: id === "local" ? "local" : "ssh" }) as Host,
          configuredSshHosts: Effect.succeed([]),
          connect: () => Effect.void,
        }),
        Layer.succeed(Notifier, { emit: (event, payload) => void events.push([event, payload]) }),
        Layer.succeed(RepoSettings, { hidden, setHidden: () => {} }),
      ),
    ),
  );
  const runtime = ManagedRuntime.make(layer);
  const run = <A, E>(f: (repos: Repos["Service"]) => Effect.Effect<A, E>) =>
    runtime.runPromise(Effect.flatMap(Repos, f));
  const runExit = <A, E>(f: (repos: Repos["Service"]) => Effect.Effect<A, E>) =>
    runtime.runPromiseExit(Effect.flatMap(Repos, f));
  return { runtime, run, runExit, events, hidden };
};
let current: ReturnType<typeof setup> | null = null;
const repos = () => (current = setup());

beforeEach(() => {
  fake.open.mockClear();
  fake.watchers.length = 0;
});
afterEach(async () => {
  await current?.runtime.dispose();
  current = null;
});

const local = (path: string): RepoLocation => ({ kind: "local", path });

describe("Repos", () => {
  it("opens a repository once, applies its settings and watches it", async () => {
    const { run } = repos();
    const a = await run((r) => r.open(local("/repo")));
    const b = await run((r) => r.open(local("/repo")));
    expect(a).toBe(b);
    expect(a.id).toBe("local:/repo");
    expect(fake.open).toHaveBeenCalledTimes(1);
    expect(fake.open.mock.calls[0]![0]).toMatchObject({ id: "local" });
    expect(a.setHiddenRefs).toHaveBeenCalledWith(["refs/heads/secret"]);
    expect(fake.watchers.map((w) => w.repo)).toEqual([a]);
  });

  it("uses the SSH host of remote locations", async () => {
    const { run } = repos();
    const repo = await run((r) => r.open({ kind: "ssh", host: "fedora", path: "/srv/x" }));
    expect(repo.id).toBe("ssh://fedora/srv/x");
    expect(fake.open.mock.calls[0]![0]).toMatchObject({ id: "fedora", kind: "ssh" });
  });

  it("shares concurrent opens of the same location", async () => {
    const { run } = repos();
    const [a, b, c] = await run((r) =>
      Effect.all([r.open(local("/repo")), r.open(local("/repo")), r.get("local:/repo")], {
        concurrency: "unbounded",
      }),
    );
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(fake.open).toHaveBeenCalledTimes(1);
    expect(fake.watchers).toHaveLength(1);
  });

  it("maps sub-directories to the repository they belong to", async () => {
    const { run } = repos();
    const sub = await run((r) => r.open(local("/repo/sub")));
    expect(sub.id).toBe("local:/repo");
    expect(await run((r) => r.get("local:/repo/sub"))).toBe(sub);
    expect(await run((r) => r.open(local("/repo")))).toBe(sub);
    expect(await run((r) => r.open(local("/repo/sub/deeper")))).toBe(sub);
    // The second sub-directory needed a probe; the repository was registered once.
    expect(fake.open).toHaveBeenCalledTimes(2);
    expect(fake.watchers).toHaveLength(1);
  });

  it("opens repositories lazily by id", async () => {
    const { run } = repos();
    const repo = await run((r) => r.get("ssh://fedora/srv/x"));
    expect(repo.id).toBe("ssh://fedora/srv/x");
    expect(await run((r) => r.get("ssh://fedora/srv/x"))).toBe(repo);
    expect(fake.open).toHaveBeenCalledTimes(1);
  });

  it("reports locations that are not repositories, every time", async () => {
    const { runExit } = repos();
    for (let i = 0; i < 2; i++) {
      const exit = await runExit((r) => r.open(local("/missing")));
      expect(exit).toEqual(
        Exit.fail(
          new NotARepositoryError({
            message: "/missing is not a Git repository",
            path: "/missing",
          }),
        ),
      );
    }
    expect(fake.open).toHaveBeenCalledTimes(2);
    expect(fake.watchers).toHaveLength(0);
  });

  it("forwards changes and graph progress to the renderer", async () => {
    const { run, events } = repos();
    const repo = await run((r) => r.open(local("/repo")));
    const { listener } = fake.watchers[0]!;

    listener(new Set<RepoChangeScope>(["worktree", "index"]));
    expect(repo.invalidateGraph).not.toHaveBeenCalled();
    listener(new Set<RepoChangeScope>(["refs"]));
    listener(new Set<RepoChangeScope>(["head"]));
    expect(repo.invalidateGraph).toHaveBeenCalledTimes(2);

    const hooks = fake.open.mock.calls[0]![2] as Hooks;
    hooks.onGraphProgress(repo, { version: 3 });
    expect(events).toEqual([
      ["repo.changed", { repo: "local:/repo", scopes: ["worktree", "index"] }],
      ["repo.changed", { repo: "local:/repo", scopes: ["refs"] }],
      ["repo.changed", { repo: "local:/repo", scopes: ["head"] }],
      ["repo.graphProgress", { repo: "local:/repo", info: { version: 3 } }],
    ]);
  });

  it("closes repositories, including by an alias", async () => {
    const { run } = repos();
    const first = await run((r) => r.open(local("/repo/sub")));
    await run((r) => r.close("local:/repo/sub"));
    expect(fake.watchers[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    await run((r) => r.close("local:/repo"));
    await run((r) => r.close("local:/never-opened"));
    expect(fake.watchers[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(first.dispose).toHaveBeenCalledTimes(1);

    const second = await run((r) => r.get("local:/repo/sub"));
    expect(second).not.toBe(first);
    expect(fake.open).toHaveBeenCalledTimes(2);
  });

  it("stops all watchers and graph loads on shutdown", async () => {
    const { run, runtime } = repos();
    const opened = await run((r) => Effect.all([r.open(local("/repo")), r.open(local("/other"))]));
    await runtime.dispose();
    current = null;
    expect(fake.watchers.map((w) => w.dispose.mock.calls.length)).toEqual([1, 1]);
    expect(opened.map((r) => vi.mocked(r.dispose).mock.calls.length)).toEqual([1, 1]);
  });
});
