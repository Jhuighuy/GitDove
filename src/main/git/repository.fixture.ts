/**
 * Shared setup for the Repository integration tests (`repository.*.test.ts`). They run in
 * throwaway repositories, locally and (when `GITDOVE_INT_SSH_HOST` is set) on a remote host under
 * /tmp. Each test gets a fresh repository with two commits on `main` and a bare `origin` it is
 * pushed to; both are copied from a template made once per file, which is much faster than
 * building them with a dozen git commands per test.
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, beforeEach } from "vitest";
import type { Ref, RepoLocation } from "@shared/domain";
import { type Host, Hosts, HostsLive, LOCAL_HOST } from "../exec/hosts";
import { Repository, type RepositoryHooks } from "./repository";

/** Hosts the tests run on: always locally, and over SSH when configured. */
export const targets: string[] = [LOCAL_HOST];
if (process.env.GITDOVE_INT_SSH_HOST) targets.push(process.env.GITDOVE_INT_SSH_HOST);

/** The local host runs scripts with /bin/sh. */
export const noShell = process.platform === "win32";

export const IDENTITY = "git config user.name T && git config user.email t@x";

/** Text of the added lines of a diff. */
export const added = (d: {
  readonly hunks: readonly { readonly lines: readonly { kind: string; text: string }[] }[];
}) => d.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "add").map((l) => l.text));

export interface RepoFixture {
  readonly host: Host;
  /** Directory holding every repository of this file. */
  readonly root: string;
  /** The current test's repository and its bare `origin`. */
  readonly dir: string;
  readonly origin: string;
  readonly repo: Repository;
  /** Number of the current test, for unique paths under `root`. */
  readonly n: number;
  readonly run: <A, E>(effect: Effect.Effect<A, E, Hosts>) => Promise<A>;
  /** Runs an effect that must fail and returns its error. */
  readonly fails: <A, E>(effect: Effect.Effect<A, E, Hosts>) => Promise<E>;
  /** Runs a shell script (in the test's repository by default) and returns its trimmed output. */
  readonly sh: (script: string, cwd?: string) => Promise<string>;
  readonly head: () => Promise<string>;
  readonly branchRef: (name: string) => Promise<Ref | undefined>;
  readonly open: (path: string, hooks?: RepositoryHooks) => Promise<Repository>;
  /** A clone of `origin` that can push commits for `repo` to pull. */
  readonly otherClone: () => Promise<string>;
}

/** Registers the hooks that give each test of the enclosing suite a fresh repository. */
export const useRepoFixture = (hostId: string): RepoFixture => {
  const runtime = ManagedRuntime.make(Layer.mergeAll(HostsLive));
  const state = {
    host: undefined as unknown as Host,
    root: "",
    dir: "",
    origin: "",
    repo: undefined as unknown as Repository,
    n: 0,
  };
  const run = <A, E>(effect: Effect.Effect<A, E, Hosts>) => runtime.runPromise(effect);
  const fails = <A, E>(effect: Effect.Effect<A, E, Hosts>) =>
    runtime.runPromise(Effect.flip(effect));
  const sh = async (script: string, cwd = state.dir) =>
    (await run(state.host.sh(script, { cwd }))).stdout.toString().trim();
  const open = (path: string, hooks: RepositoryHooks = { onGraphProgress: () => {} }) => {
    const location: RepoLocation =
      hostId === LOCAL_HOST ? { kind: "local", path } : { kind: "ssh", host: hostId, path };
    return run(Repository.open(state.host, location, hooks));
  };

  beforeAll(async () => {
    state.host = await run(Effect.map(Hosts, (hosts) => hosts.get(hostId)));
    state.root = await sh("mktemp -d /tmp/gitdove-ops.XXXXXX", "/");
    await sh(
      "git init -q --bare -b main template-origin.git && mkdir template && cd template && " +
        `git init -q -b main . && ${IDENTITY} && ` +
        "printf 'a\\nb\\nc\\n' > f.txt && git add f.txt && git commit -qm one && " +
        "printf 'a\\nb\\nc\\nd\\n' > f.txt && git commit -qam two && " +
        "git remote add origin ../template-origin.git && git push -q -u origin main",
      state.root,
    );
  });

  afterAll(async () => {
    if (state.root) await sh(`rm -rf -- '${state.root}'`, "/");
    await runtime.dispose();
  });

  beforeEach(async () => {
    state.n++;
    state.dir = `${state.root}/repo${state.n}`;
    state.origin = `${state.root}/origin${state.n}.git`;
    await sh(
      `cp -R template '${state.dir}' && cp -R template-origin.git '${state.origin}' && ` +
        `git -C '${state.dir}' remote set-url origin '${state.origin}'`,
      state.root,
    );
    state.repo = await open(state.dir);
  });

  return {
    get host() {
      return state.host;
    },
    get root() {
      return state.root;
    },
    get dir() {
      return state.dir;
    },
    get origin() {
      return state.origin;
    },
    get repo() {
      return state.repo;
    },
    get n() {
      return state.n;
    },
    run,
    fails,
    sh,
    head: () => sh("git rev-parse HEAD"),
    branchRef: async (name) =>
      (await run(state.repo.refs())).refs.find((r) => r.name === `refs/heads/${name}`),
    open,
    otherClone: async () => {
      const other = `${state.root}/other${state.n}`;
      await sh(
        `git clone -q '${state.origin}' '${other}' && cd '${other}' && ${IDENTITY}`,
        state.root,
      );
      return other;
    },
  };
};
