import type { RepoLocation } from "@shared/domain";
import type { RepoChangeScope } from "@shared/ipc";
import { Context, Effect, Exit, Layer, ManagedRuntime, RcMap } from "effect";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { InvalidInputError, NotARepositoryError, RepoNotOpenError } from "./exec/errors";
import { type Host, Hosts } from "./exec/hosts";
import type { Repository } from "./git/repository";
import { LoggerLive, Notifier, RepoSettings, Repos, ReposLive } from "./services";

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
const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("electron-log/main", () => ({ default: log }));
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
    const a = await run((r) => r.open(local("/repo"), 1));
    const b = await run((r) => r.open(local("/repo"), 1));
    expect(a).toBe(b);
    expect(a.id).toBe("local:/repo");
    expect(fake.open).toHaveBeenCalledTimes(1);
    expect(fake.open.mock.calls[0]![0]).toMatchObject({ id: "local" });
    expect(a.setHiddenRefs).toHaveBeenCalledWith(["refs/heads/secret"]);
    expect(fake.watchers.map((w) => w.repo)).toEqual([a]);
  });

  it("uses the SSH host of remote locations", async () => {
    const { run } = repos();
    const repo = await run((r) => r.open({ kind: "ssh", host: "fedora", path: "/srv/x" }, 1));
    expect(repo.id).toBe("ssh://fedora/srv/x");
    expect(fake.open.mock.calls[0]![0]).toMatchObject({ id: "fedora", kind: "ssh" });
  });

  it("shares concurrent opens of the same location", async () => {
    const { run } = repos();
    const [a, b, c] = await run((r) =>
      Effect.all([r.open(local("/repo"), 1), r.open(local("/repo"), 1), r.get("local:/repo", 1)], {
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
    const sub = await run((r) => r.open(local("/repo/sub"), 1));
    expect(sub.id).toBe("local:/repo");
    expect(await run((r) => r.get("local:/repo/sub", 1))).toBe(sub);
    expect(await run((r) => r.open(local("/repo"), 1))).toBe(sub);
    expect(await run((r) => r.open(local("/repo/sub/deeper"), 1))).toBe(sub);
    // The second sub-directory needed a probe; the repository was registered once.
    expect(fake.open).toHaveBeenCalledTimes(2);
    expect(fake.watchers).toHaveLength(1);
  });

  it("opens repositories lazily by id", async () => {
    const { run } = repos();
    const repo = await run((r) => r.get("ssh://fedora/srv/x", 1));
    expect(repo.id).toBe("ssh://fedora/srv/x");
    expect(await run((r) => r.get("ssh://fedora/srv/x", 1))).toBe(repo);
    expect(fake.open).toHaveBeenCalledTimes(1);
  });

  it("reports locations that are not repositories, every time", async () => {
    const { runExit } = repos();
    for (let i = 0; i < 2; i++) {
      const exit = await runExit((r) => r.open(local("/missing"), 1));
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
    const repo = await run((r) => r.open(local("/repo"), 1));
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
    const first = await run((r) => r.open(local("/repo/sub"), 1));
    await run((r) => r.release("local:/repo/sub", 1));
    expect(fake.watchers[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    await run((r) => r.release("local:/repo", 1));
    await run((r) => r.release("local:/never-opened", 1));
    expect(fake.watchers[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(first.dispose).toHaveBeenCalledTimes(1);

    const second = await run((r) => r.open(local("/repo/sub"), 1));
    expect(second).not.toBe(first);
    expect(fake.open).toHaveBeenCalledTimes(2);
  });

  it("keeps a repository open while any owner uses it", async () => {
    const { run } = repos();
    const repo = await run((r) => r.open(local("/repo"), 1));
    // Using it counts too, e.g. a restored tab in another window.
    await run((r) => r.get("local:/repo", 2));
    await run((r) => r.release("local:/repo", 1));
    expect(repo.dispose).not.toHaveBeenCalled();
    await run((r) => r.release("local:/repo", 1));
    expect(repo.dispose).not.toHaveBeenCalled();
    await run((r) => r.release("local:/repo", 2));
    expect(repo.dispose).toHaveBeenCalledTimes(1);
    expect(fake.watchers[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  it("releases everything an owner used when it goes away", async () => {
    const { run } = repos();
    const [a, b] = await run((r) =>
      Effect.all([r.open(local("/repo"), 1), r.open(local("/other"), 1)]),
    );
    await run((r) => r.get("local:/other", 2));
    await run((r) => r.releaseAll(1));
    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).not.toHaveBeenCalled();
    // Not closed explicitly: it opens lazily again, e.g. for a new window restoring its tabs.
    expect(await run((r) => r.get("local:/repo", 3))).not.toBe(a);
  });

  it("does not reopen an explicitly closed repository for late requests", async () => {
    const { run, runExit } = repos();
    await run((r) => r.open(local("/repo/sub"), 1));
    await run((r) => r.release("local:/repo", 1));
    for (const id of ["local:/repo", "local:/repo/sub"]) {
      expect(await runExit((r) => r.get(id, 1))).toEqual(
        Exit.fail(new RepoNotOpenError({ message: "The repository is closed", repo: id })),
      );
    }
    expect(fake.open).toHaveBeenCalledTimes(1);
    // Opening it again lifts that.
    const again = await run((r) => r.open(local("/repo"), 1));
    expect(await run((r) => r.get("local:/repo", 1))).toBe(again);
  });

  it("releases a repository closed while it was opening", async () => {
    const { run } = repos();
    const [repo] = await run((r) =>
      Effect.all(
        [
          r.open(local("/repo"), 1),
          Effect.andThen(Effect.sleep("5 millis"), r.release("local:/repo", 1)),
        ],
        {
          concurrency: "unbounded",
        },
      ),
    );
    expect(repo.dispose).toHaveBeenCalledTimes(1);
    expect(fake.watchers[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed ids", async () => {
    const { runExit } = repos();
    expect(await runExit((r) => r.get("nope", 1))).toEqual(
      Exit.fail(new InvalidInputError({ message: "Invalid repository id: nope" })),
    );
  });

  it("stops all watchers and graph loads on shutdown", async () => {
    const { run, runtime } = repos();
    const opened = await run((r) =>
      Effect.all([r.open(local("/repo"), 1), r.open(local("/other"), 1)]),
    );
    await runtime.dispose();
    current = null;
    expect(fake.watchers.map((w) => w.dispose.mock.calls.length)).toEqual([1, 1]);
    expect(opened.map((r) => vi.mocked(r.dispose).mock.calls.length)).toEqual([1, 1]);
  });
});

describe("LoggerLive", () => {
  it("writes Effect logs to the app log by level", async () => {
    const runtime = ManagedRuntime.make(LoggerLive);
    await runtime.runPromise(
      Effect.all([
        Effect.logInfo("hello", 42),
        Effect.logWarning("careful"),
        Effect.logError("bad", new Error("boom")),
        Effect.logFatal("worse"),
      ]),
    );
    await runtime.dispose();
    expect(log.info).toHaveBeenCalledWith("hello", 42);
    expect(log.warn).toHaveBeenCalledWith("careful");
    expect(log.error).toHaveBeenCalledWith("bad", expect.any(Error));
    expect(log.error).toHaveBeenCalledWith("worse");
  });

  it("reaches fibers that layers start, even for callers outside the runtime", async () => {
    // Like the SSH masters in `HostsLive`: an RcMap made while building a layer.
    class Pool extends Context.Service<Pool, RcMap.RcMap<string, string>>()("test/Pool") {}
    const PoolLive = Layer.effect(
      Pool,
      RcMap.make({ lookup: (key: string) => Effect.as(Effect.logInfo(`open ${key}`), key) }),
    );
    const runtime = ManagedRuntime.make(PoolLive.pipe(Layer.provide(LoggerLive)));
    const pool = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* Pool;
      }),
    );
    // A fiber of the default runtime, e.g. a watcher started with `Effect.runFork`.
    await Effect.runPromise(Effect.scoped(RcMap.get(pool, "fedora")));
    await runtime.dispose();
    expect(log.info).toHaveBeenCalledWith("open fedora");
  });
});
