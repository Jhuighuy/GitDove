import type { RepoId, RepoLocation } from "@shared/domain";
import { repoIdOf, repoLocationOf } from "@shared/domain";
import type { EventName, Events } from "@shared/ipc";
import log from "electron-log/main";
import { Cause, Context, Deferred, Effect, Exit, FiberSet, Layer, Logger } from "effect";
import { InvalidInputError, type NotARepositoryError, RepoNotOpenError } from "./exec/errors";
import { Hosts, LOCAL_HOST } from "./exec/hosts";
import { type GitError, Repository } from "./git/repository";
import { type Watch, watchRepository } from "./git/watcher";

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

/** Writes Effect logs to the app log (Help › Show Logs) instead of the console. */
export const electronLogger = Logger.make(({ logLevel, message, cause }) => {
  const parts: unknown[] = Array.isArray(message) ? [...message] : [message];
  if (cause.reasons.length > 0) parts.push(Cause.pretty(cause));
  switch (logLevel) {
    case "Fatal":
    case "Error":
      return log.error(...parts);
    case "Warn":
      return log.warn(...parts);
    case "Info":
      return log.info(...parts);
    default:
      return log.debug(...parts);
  }
});

/** Replaces the default (console) logger; provide it to every layer so their fibers use it. */
export const LoggerLive = Logger.layer([electronLogger]);

type OpenError = GitError | NotARepositoryError;

/** What uses an open repository: a renderer, by `webContents.id`. */
export type Owner = number;

interface Entry {
  readonly repo: Repository;
  readonly owners: Set<Owner>;
  readonly watch: Watch;
  /** Whether some owner shows it (see `Repos.setVisible`). */
  visible: boolean;
  readonly dispose: () => void;
}

/**
 * Registry of open repositories. Each one is kept open (watched, its graph loaded, its SSH
 * connection alive) while some owner uses it.
 */
export class Repos extends Context.Service<
  Repos,
  {
    /**
     * Opens (or returns the already open) repository at a location for `owner`. It is the user's
     * request: an SSH host that failed to connect a moment ago is tried again right away.
     */
    readonly open: (location: RepoLocation, owner: Owner) => Effect.Effect<Repository, OpenError>;
    /**
     * Returns an open repository for `owner`. One that is not open is opened, e.g. for tabs
     * restored on launch, unless it was explicitly closed (by `owner`, or by every owner): late
     * requests from a closed tab must not bring it back.
     */
    readonly get: (
      id: RepoId,
      owner: Owner,
    ) => Effect.Effect<Repository, OpenError | RepoNotOpenError | InvalidInputError>;
    /** `owner` closed the repository; it is closed once no owner uses it. */
    readonly release: (id: RepoId, owner: Owner) => Effect.Effect<void>;
    /** `owner` went away (e.g. its window closed): releases everything it used. */
    readonly releaseAll: (owner: Owner) => Effect.Effect<void>;
    /**
     * Whether `owner` shows the repository (e.g. in its active tab). A repository that no owner
     * shows does as little as possible: its remote is polled rarely, and file changes and graph
     * checks wait until it is shown. Never opens the repository.
     */
    readonly setVisible: (id: RepoId, owner: Owner, visible: boolean) => Effect.Effect<void>;
  }
>()("gitdove/Repos") {}

export const ReposLive = Layer.effect(
  Repos,
  Effect.gen(function* () {
    const hosts = yield* Hosts;
    const notifier = yield* Notifier;
    const settings = yield* RepoSettings;
    // Background work of repositories (graph loads, watchers) runs with this layer's services
    // (e.g. its logger) and is interrupted when the layer is released, i.e. at quit.
    const fork = yield* FiberSet.makeRuntime();
    const entries = new Map<RepoId, Entry>();
    /** Requested id -> pending open. */
    const opening = new Map<RepoId, Deferred.Deferred<Repository, OpenError>>();
    /** Requested id -> owners waiting for its pending open. */
    const claims = new Map<RepoId, Set<Owner>>();
    /** Requested id (e.g. a sub-directory) -> canonical id. */
    const aliases = new Map<RepoId, RepoId>();
    /** Ids (canonical or aliases) explicitly closed and not opened again since. */
    const closed = new Set<RepoId>();
    /**
     * Ids, as owners name them -> owners that closed them while others kept them open, and did
     * not open them again since: their late requests must not claim them again.
     */
    const releasedBy = new Map<RepoId, Set<Owner>>();
    const forgetRelease = (owner: Owner, ids: Iterable<RepoId>) => {
      for (const id of ids) {
        const set = releasedBy.get(id);
        if (set?.delete(owner) && set.size === 0) releasedBy.delete(id);
      }
    };
    const lookup = (id: RepoId) => entries.get(aliases.get(id) ?? id);
    /** Ids, as owners name them -> owners that do not show them (see `setVisible`). */
    const hiddenBy = new Map<RepoId, Set<Owner>>();
    /** The ids an entry is known by: its own and its aliases. */
    const idsOf = (entry: Entry) => [
      entry.repo.id,
      ...[...aliases].flatMap(([k, v]) => (v === entry.repo.id ? [k] : [])),
    ];

    /** Shows or hides a repository: it is shown while some owner (or nobody yet) shows it. */
    const updateVisibility = (entry: Entry) => {
      const ids = idsOf(entry);
      const shows = (o: Owner) => !ids.some((id) => hiddenBy.get(id)?.has(o));
      const visible = entry.owners.size === 0 || [...entry.owners].some(shows);
      if (visible === entry.visible) return;
      entry.visible = visible;
      entry.repo.setVisible(visible);
      entry.watch.setVisible(visible);
    };

    /** Forgets which of `ids` `owner` hid. */
    const unhide = (owner: Owner, ids: Iterable<RepoId>) => {
      for (const id of ids) {
        const set = hiddenBy.get(id);
        if (set?.delete(owner) && set.size === 0) hiddenBy.delete(id);
      }
    };

    const register = (repo: Repository): Entry => {
      const existing = entries.get(repo.id);
      if (existing) {
        // Opened concurrently by another name (e.g. a sub-directory): keep the first.
        repo.dispose();
        return existing;
      }
      repo.setHiddenRefs(settings.hidden(repo.id));
      const watch = watchRepository(repo, (scopes) => {
        if (scopes.has("refs") || scopes.has("head")) repo.invalidateGraph();
        notifier.emit("repo.changed", { repo: repo.id, scopes: [...scopes] });
      });
      const dispose = () => {
        watch.dispose();
        repo.dispose();
      };
      const entry: Entry = { repo, owners: new Set<Owner>(), watch, visible: true, dispose };
      entries.set(repo.id, entry);
      return entry;
    };

    const closeEntry = (entry: Entry) => {
      entry.dispose();
      entries.delete(entry.repo.id);
      for (const [k, v] of aliases) if (v === entry.repo.id) aliases.delete(k);
    };

    /**
     * Opens a repository for `owner`, sharing concurrent opens of the same location. Owners are
     * claimed up front, so a release while the open is pending takes effect once it completes.
     */
    const open = (
      location: RepoLocation,
      owner: Owner,
      reconnect: boolean,
    ): Effect.Effect<Repository, OpenError> =>
      Effect.suspend(() => {
        const requested = repoIdOf(location);
        closed.delete(requested);
        forgetRelease(owner, [requested]);
        const ready = lookup(requested);
        if (ready) {
          ready.owners.add(owner);
          closed.delete(ready.repo.id);
          forgetRelease(owner, idsOf(ready));
          updateVisibility(ready);
          return Effect.succeed(ready.repo);
        }
        let waiting = claims.get(requested);
        if (!waiting) claims.set(requested, (waiting = new Set()));
        waiting.add(owner);
        const pending = opening.get(requested);
        if (pending) return Deferred.await(pending);

        const deferred = Deferred.makeUnsafe<Repository, OpenError>();
        opening.set(requested, deferred);
        const host = hosts.get(location.kind === "local" ? LOCAL_HOST : location.host);
        // Connecting first skips the backoff after failed attempts (see `Hosts.connect`).
        const connect =
          reconnect && location.kind === "ssh" ? hosts.connect(location.host) : Effect.void;
        // In the background: callers only wait for it, so one that is interrupted (e.g. a
        // cancelled query) does not interrupt the open the others wait for.
        fork(
          connect.pipe(
            Effect.andThen(
              Repository.open(host, location, {
                onGraphProgress: (repo, info) =>
                  notifier.emit("repo.graphProgress", { repo: repo.id, info }),
                fork,
              }),
            ),
            Effect.map(register),
            Effect.onExit((exit) => {
              opening.delete(requested);
              const owners = claims.get(requested) ?? new Set();
              claims.delete(requested);
              if (Exit.isFailure(exit)) return Deferred.failCause(deferred, exit.cause);
              const entry = exit.value;
              if (entry.repo.id !== requested) aliases.set(requested, entry.repo.id);
              for (const o of owners) {
                entry.owners.add(o);
                forgetRelease(o, idsOf(entry));
              }
              if (entry.owners.size > 0) {
                closed.delete(entry.repo.id);
                updateVisibility(entry);
              } else {
                // Every owner closed it (or went away) while it was opening. If it was closed,
                // late requests must not reopen it, by any of its names.
                if (closed.has(requested)) for (const id of idsOf(entry)) closed.add(id);
                closeEntry(entry);
              }
              return Deferred.succeed(deferred, entry.repo);
            }),
          ),
        );
        return Deferred.await(deferred);
      });

    const get = (id: RepoId, owner: Owner) =>
      Effect.suspend(
        (): Effect.Effect<Repository, OpenError | RepoNotOpenError | InvalidInputError> => {
          const entry = lookup(id);
          if (entry && !releasedBy.get(id)?.has(owner)) {
            if (!entry.owners.has(owner)) {
              entry.owners.add(owner);
              updateVisibility(entry);
            }
            return Effect.succeed(entry.repo);
          }
          if (entry || closed.has(id)) {
            return Effect.fail(
              new RepoNotOpenError({ message: "The repository is closed", repo: id }),
            );
          }
          let location: RepoLocation;
          try {
            location = repoLocationOf(id);
          } catch {
            return Effect.fail(new InvalidInputError({ message: `Invalid repository id: ${id}` }));
          }
          return open(location, owner, false);
        },
      );

    const release = (id: RepoId, owner: Owner) =>
      Effect.sync(() => {
        const waiting = claims.get(id);
        waiting?.delete(owner);
        const entry = lookup(id);
        unhide(owner, entry ? [id, ...idsOf(entry)] : [id]);
        if (entry) {
          entry.owners.delete(owner);
          if (entry.owners.size > 0) {
            for (const name of [id, ...idsOf(entry)]) {
              let set = releasedBy.get(name);
              if (!set) releasedBy.set(name, (set = new Set()));
              set.add(owner);
            }
            return updateVisibility(entry);
          }
          closed.add(entry.repo.id);
          for (const [k, v] of aliases) if (v === entry.repo.id) closed.add(k);
          closeEntry(entry);
        }
        if (!waiting?.size) closed.add(id);
      });

    const releaseAll = (owner: Owner) =>
      Effect.sync(() => {
        for (const waiting of claims.values()) waiting.delete(owner);
        unhide(owner, [...hiddenBy.keys()]);
        forgetRelease(owner, [...releasedBy.keys()]);
        for (const entry of entries.values()) {
          if (!entry.owners.delete(owner)) continue;
          if (entry.owners.size === 0) closeEntry(entry);
          else updateVisibility(entry);
        }
      });

    const setVisible = (id: RepoId, owner: Owner, visible: boolean) =>
      Effect.sync(() => {
        if (visible) unhide(owner, [id]);
        else {
          let set = hiddenBy.get(id);
          if (!set) hiddenBy.set(id, (set = new Set()));
          set.add(owner);
        }
        const entry = lookup(id);
        if (entry) updateVisibility(entry);
      });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const e of entries.values()) e.dispose();
        entries.clear();
      }),
    );

    return {
      open: (location: RepoLocation, owner: Owner) => open(location, owner, true),
      get,
      release,
      releaseAll,
      setVisible,
    };
  }),
);
