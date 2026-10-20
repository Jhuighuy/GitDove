import type { RepoId, RepoLocation } from "@shared/domain";
import { repoIdOf, repoLocationOf } from "@shared/domain";
import type { EventName, Events } from "@shared/ipc";
import { Context, Deferred, Effect, Exit, Layer } from "effect";
import type { NotARepositoryError } from "./exec/errors";
import { Hosts, LOCAL_HOST } from "./exec/hosts";
import { type GitError, Repository } from "./git/repository";
import { watchRepository } from "./git/watcher";

/** Pushes events to the renderer(s). */
export class Notifier extends Context.Service<
  Notifier,
  { readonly emit: <E extends EventName>(event: E, payload: Events[E]) => void }
>()("gitdove/Notifier") {}

/** Persistent per-repository settings (graph visibility, …). */
export class RepoSettings extends Context.Service<
  RepoSettings,
  {
    readonly hidden: (repo: RepoId) => readonly string[];
    readonly setHidden: (repo: RepoId, hidden: readonly string[]) => void;
  }
>()("gitdove/RepoSettings") {}

type OpenError = GitError | NotARepositoryError;

interface Entry {
  readonly repo: Repository;
  readonly dispose: () => void;
}

/** Registry of open repositories. */
export class Repos extends Context.Service<
  Repos,
  {
    /** Opens (or returns the already open) repository at a location. */
    readonly open: (location: RepoLocation) => Effect.Effect<Repository, OpenError>;
    /** Returns an open repository, opening it lazily if needed. */
    readonly get: (id: RepoId) => Effect.Effect<Repository, OpenError>;
    readonly close: (id: RepoId) => Effect.Effect<void>;
  }
>()("gitdove/Repos") {}

export const ReposLive = Layer.effect(
  Repos,
  Effect.gen(function* () {
    const hosts = yield* Hosts;
    const notifier = yield* Notifier;
    const settings = yield* RepoSettings;
    const entries = new Map<RepoId, Entry>();
    /** Requested id -> pending open. */
    const opening = new Map<RepoId, Deferred.Deferred<Repository, OpenError>>();
    /** Requested id (e.g. a sub-directory) -> canonical id. */
    const aliases = new Map<RepoId, RepoId>();
    const lookup = (id: RepoId) => entries.get(aliases.get(id) ?? id);

    const register = (repo: Repository): Repository => {
      const existing = entries.get(repo.id);
      if (existing) return existing.repo;
      repo.setHiddenRefs(settings.hidden(repo.id));
      const dispose = watchRepository(repo, (scopes) => {
        if (scopes.has("refs") || scopes.has("head")) repo.invalidateGraph();
        notifier.emit("repo.changed", { repo: repo.id, scopes: [...scopes] });
      });
      entries.set(repo.id, { repo, dispose });
      return repo;
    };

    const open = (location: RepoLocation): Effect.Effect<Repository, OpenError> =>
      Effect.suspend(() => {
        const requested = repoIdOf(location);
        const ready = lookup(requested);
        if (ready) return Effect.succeed(ready.repo);
        const pending = opening.get(requested);
        if (pending) return Deferred.await(pending);

        const deferred = Deferred.makeUnsafe<Repository, OpenError>();
        opening.set(requested, deferred);
        const host = hosts.get(location.kind === "local" ? LOCAL_HOST : location.host);
        return Repository.open(host, location, {
          onGraphProgress: (repo, info) =>
            notifier.emit("repo.graphProgress", { repo: repo.id, info }),
        }).pipe(
          Effect.map(register),
          Effect.onExit((exit) => {
            opening.delete(requested);
            if (Exit.isSuccess(exit) && exit.value.id !== requested)
              aliases.set(requested, exit.value.id);
            return Deferred.done(deferred, exit);
          }),
        );
      });

    const close = (id: RepoId) =>
      Effect.sync(() => {
        const entry = lookup(id);
        if (!entry) return;
        entry.dispose();
        entries.delete(entry.repo.id);
        for (const [k, v] of aliases) if (v === entry.repo.id) aliases.delete(k);
      });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const e of entries.values()) e.dispose();
        entries.clear();
      }),
    );

    return {
      open,
      get: (id) =>
        Effect.suspend(() => {
          const entry = lookup(id);
          return entry ? Effect.succeed(entry.repo) : open(repoLocationOf(id));
        }),
      close,
    };
  }),
);
