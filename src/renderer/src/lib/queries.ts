import type { DiffTarget, GraphInfo, GraphRow, Ref, RepoId, RepoInfo } from "@shared/domain";
import type { RepoChangeScope } from "@shared/ipc";
import {
  type InvalidateQueryFilters,
  keepPreviousData,
  QueryClient,
  skipToken,
  useQueries,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { isFilteredOut, isHidden } from "@shared/visibility";
import { busyOf } from "@/stores/busy";
import { api, ApiError, useEvent } from "./api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Freshness is driven by repository change events, not by timers.
      staleTime: Infinity,
      gcTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
      retry: (count, error) =>
        count < 2 &&
        !(error instanceof ApiError && error.tag !== "SshError" && error.tag !== "Defect"),
    },
  },
});

export const keys = {
  repo: (repo: RepoId) => ["repo", repo] as const,
  /**
   * Opening a repository (connecting to its host). Kept out of {@link keys.repo}: refreshing a
   * repository's data must not reopen it, nor turn a passing failure into the "could not open" page.
   */
  open: (repo: RepoId) => ["open", repo] as const,
  info: (repo: RepoId) => ["repo", repo, "info"] as const,
  refs: (repo: RepoId) => ["repo", repo, "refs"] as const,
  /** Names hidden from the graph (see `@shared/visibility`). */
  hidden: (repo: RepoId) => ["repo", repo, "hidden"] as const,
  status: (repo: RepoId) => ["repo", repo, "status"] as const,
  graphInfo: (repo: RepoId) => ["repo", repo, "graph", "info"] as const,
  graphPages: (repo: RepoId, version: number, page: number) =>
    ["repo", repo, "graph", "page", version, page] as const,
  // Rows never change once built, so a page is identified by how many of its rows exist.
  graphPage: (repo: RepoId, version: number, page: number, size: number) =>
    [...keys.graphPages(repo, version, page), size] as const,
  commit: (repo: RepoId, hash: string) => ["repo", repo, "commit", hash] as const,
  compare: (repo: RepoId, base: string | null, tip: string) =>
    ["repo", repo, "compare", base, tip] as const,
  diffs: (repo: RepoId) => ["repo", repo, "diff"] as const,
  diff: (repo: RepoId, target: DiffTarget) => [...keys.diffs(repo), target] as const,
  // Under "diff" so that it goes stale together with diffs.
  fileVersions: (repo: RepoId, target: DiffTarget) =>
    [...keys.diffs(repo), target, "versions"] as const,
  searches: (repo: RepoId) => ["repo", repo, "search"] as const,
  search: (repo: RepoId, q: string) => [...keys.searches(repo), q] as const,
  isGitlab: (origin: string) => ["web", "isGitlab", origin] as const,
};

export const useRepoInfo = (repo: RepoId) =>
  useQuery({ queryKey: keys.info(repo), queryFn: () => api("repo.info", repo) });

export const useRefs = (repo: RepoId) =>
  useQuery({ queryKey: keys.refs(repo), queryFn: () => api("repo.refs", repo) });

export const useHiddenRefs = (repo: RepoId) =>
  useQuery({ queryKey: keys.hidden(repo), queryFn: () => api("repo.hiddenRefs", repo) });

export const useStatus = (repo: RepoId) =>
  useQuery({ queryKey: keys.status(repo), queryFn: () => api("repo.status", repo) });

export const useGraphInfo = (repo: RepoId) =>
  useQuery({ queryKey: keys.graphInfo(repo), queryFn: () => api("repo.graphInfo", repo) });

// Commits never change and change events leave these queries alone, but a commit's file list
// can be large: drop it soon after no view shows it.
const COMMIT_GC_MS = 60 * 1000;

/**
 * The details of commit `hash`; null fetches nothing. With `keepPrevious`, the previous commit's
 * details stay while the next one loads (compare `data.hash`).
 */
export const useCommitDetails = (
  repo: RepoId,
  hash: string | null,
  { keepPrevious = false }: { readonly keepPrevious?: boolean } = {},
) =>
  useQuery({
    queryKey: keys.commit(repo, hash ?? ""),
    queryFn: hash === null ? skipToken : () => api("repo.commitDetails", repo, hash),
    gcTime: COMMIT_GC_MS,
    placeholderData: keepPrevious ? keepPreviousData : undefined,
  });

/** The changes from `base` (the empty tree when null) to `tip`; null `tip` fetches nothing. */
export const useCompare = (repo: RepoId, base: string | null, tip: string | null) =>
  useQuery({
    queryKey: keys.compare(repo, base, tip ?? ""),
    queryFn: tip === null ? skipToken : () => api("repo.compare", repo, base, tip),
    gcTime: COMMIT_GC_MS,
  });

export const useDiff = (repo: RepoId, target: DiffTarget | null) =>
  useQuery({
    queryKey: [...keys.diffs(repo), target],
    queryFn: target === null ? skipToken : () => api("repo.diff", repo, target),
    placeholderData: keepPreviousData,
    gcTime: 30 * 1000,
  });

export const useFileVersions = (repo: RepoId, target: DiffTarget) =>
  useQuery({
    queryKey: keys.fileVersions(repo, target),
    queryFn: () => api("repo.fileVersions", repo, target),
    // Whole files can be large: drop them as soon as no view shows them.
    gcTime: 0,
  });

export const GRAPH_PAGE = 256;

export interface GraphRows {
  /** Rows by index, including those kept on screen while their page (re)loads. */
  readonly rows: ReadonlyMap<number, GraphRow>;
  /** Only the rows of loaded pages, at their indexes in the current graph version. */
  readonly current: ReadonlyMap<number, GraphRow>;
}

/**
 * Returns the graph rows in `[start, end)`, fetching pages on demand. While the graph streams
 * in, a page that gains rows is fetched again. While a page loads, the rows it had before (or
 * rows from the previous graph version) are kept on screen: `rows` has them too, `current`
 * only the rows of loaded pages, at their indexes in graph `info.version`.
 */
export const useGraphRows = (
  repo: RepoId,
  info: GraphInfo | undefined,
  start: number,
  end: number,
): GraphRows => {
  const pages = useMemo(() => {
    if (!info || end <= start) return [];
    const out: { page: number; size: number }[] = [];
    const first = Math.floor(start / GRAPH_PAGE);
    const last = Math.ceil(Math.min(end, info.count) / GRAPH_PAGE);
    for (let page = first; page < last; page++) {
      out.push({ page, size: Math.min(GRAPH_PAGE, info.count - page * GRAPH_PAGE) });
    }
    return out;
  }, [info, start, end]);

  // `useQueries` returns a new array on every render; building the maps in a stable `combine`
  // keeps them (and the rows rendered from them) the same until a page or its data changes.
  const combine = useCallback(
    (results: UseQueryResult<GraphRow[]>[]): GraphRows => {
      const rows = new Map<number, GraphRow>();
      const current = new Map<number, GraphRow>();
      results.forEach((r, i) => {
        const base = pages[i]!.page * GRAPH_PAGE;
        r.data?.forEach((row, j) => {
          rows.set(base + j, row);
          if (!r.isPlaceholderData) current.set(base + j, row);
        });
      });
      return { rows, current };
    },
    [pages],
  );

  const client = useQueryClient();
  const version = info?.version ?? 0;
  return useQueries({
    queries: pages.map(({ page, size }) => ({
      queryKey: keys.graphPage(repo, version, page, size),
      queryFn: () =>
        api("repo.graphRows", repo, version, page * GRAPH_PAGE, page * GRAPH_PAGE + size),
      staleTime: Infinity,
      gcTime: 60 * 1000,
      placeholderData: () => placeholderPage(client, repo, version, page),
    })),
    combine,
  });
};

/** The fullest cached copy of a page, from this graph version or a recent previous one. */
const placeholderPage = (client: QueryClient, repo: RepoId, version: number, page: number) => {
  for (let v = version; v >= Math.max(0, version - 5); v--) {
    let best: GraphRow[] | undefined;
    for (const [, data] of client.getQueriesData<GraphRow[]>({
      queryKey: keys.graphPages(repo, v, page),
    })) {
      if (data && data.length > (best?.length ?? 0)) best = data;
    }
    if (best) return best;
  }
  return undefined;
};

/** Index of refs by commit hash, without refs hidden from the graph (by their eye or contributors). */
export const useRefsByHash = (repo: RepoId) => {
  const { data } = useRefs(repo);
  const { data: hidden } = useHiddenRefs(repo);
  return useMemo(() => {
    const map = new Map<string, Ref[]>();
    const hiddenSet = new Set(hidden ?? []);
    for (const ref of data?.refs ?? []) {
      // The graph always shows HEAD, so the checked-out branch keeps its pill (and its tick).
      if (
        !ref.isHead &&
        hiddenSet.size > 0 &&
        (isHidden(hiddenSet, ref.name) || isFilteredOut(hiddenSet, ref.name, data!.owners))
      )
        continue;
      let list = map.get(ref.hash);
      if (!list) {
        list = [];
        map.set(ref.hash, list);
      }
      list.push(ref);
    }
    return map;
  }, [data, hidden]);
};

// ---------------------------------------------------------------------------
// Refreshing
// ---------------------------------------------------------------------------

/**
 * What a change in a repository can make outdated. Commit details, comparisons and commit diffs
 * are not here: commits never change. Graph pages are not either: the main process reloads the
 * graph when refs change and reports new versions through `repo.graphProgress`.
 */
export type DataScope =
  | "status"
  /** Diffs (and whole files) of the working tree and the index. */
  | "workingDiffs"
  | "refs"
  | "info"
  /** Asks for the graph again (the main process loads it if it is outdated). */
  | "graph"
  | "search"
  | "hidden";

/** What changing the working tree or the index (staging, discarding, applying a patch) outdates. */
export const WORKING_TREE: readonly DataScope[] = ["status", "workingDiffs"];
/** What an operation that may also move refs or HEAD outdates. */
export const REPOSITORY: readonly DataScope[] = ["info", "refs", "search", ...WORKING_TREE];
/** Everything that can be refreshed (an explicit refresh). */
export const EVERYTHING: readonly DataScope[] = [...REPOSITORY, "graph", "hidden"];

const filtersOf = (repo: RepoId, scope: DataScope): InvalidateQueryFilters => {
  switch (scope) {
    case "workingDiffs":
      return {
        queryKey: keys.diffs(repo),
        predicate: (q) => (q.queryKey[3] as DiffTarget | null)?.kind !== "commit",
      };
    case "graph":
      return { queryKey: keys.graphInfo(repo) };
    case "search":
      return { queryKey: keys.searches(repo) };
    default:
      return { queryKey: [...keys.repo(repo), scope] };
  }
};

/** What a change reported by the main process outdates. */
export const scopesOfChange = (changes: readonly RepoChangeScope[]): Set<DataScope> => {
  const c = new Set(changes);
  const out = new Set<DataScope>();
  if (c.has("refs") || c.has("head") || c.has("config")) out.add("info").add("refs");
  if (c.has("refs") || c.has("head")) out.add("search");
  if (c.has("index") || c.has("worktree") || c.has("head")) {
    for (const s of WORKING_TREE) out.add(s);
  }
  return out;
};

/** Refetches of one scope of one repository: the running one, and at most one queued after it. */
interface Refetch {
  readonly done: Promise<void>;
  again?: Promise<void>;
}
const refetches = new WeakMap<QueryClient, Map<string, Refetch>>();

/** Repositories in background tabs: their data is only marked stale until they are shown. */
const background = new Set<RepoId>();

/**
 * Refetches the queries of `scope` in `repo`. Requests made while a refetch runs share one more
 * refetch after it, which sees every change made meanwhile. So bursts of change events neither
 * cancel each other's fetches (the git commands keep running in the main process) nor keep a
 * slow query from ever finishing.
 */
const refetchScope = (client: QueryClient, repo: RepoId, scope: DataScope): Promise<void> => {
  let byKey = refetches.get(client);
  if (!byKey) refetches.set(client, (byKey = new Map()));
  const key = `${scope}\0${repo}`;
  const running = byKey.get(key);
  if (running) {
    running.again ??= running.done.then(() => refetchScope(client, repo, scope));
    return running.again;
  }
  const entry: Refetch = {
    done: client
      .invalidateQueries({
        ...filtersOf(repo, scope),
        refetchType: background.has(repo) ? "none" : "active",
      })
      .catch(() => {})
      .finally(() => byKey.delete(key)),
  };
  byKey.set(key, entry);
  return entry.done;
};

/**
 * Refreshes `scopes` of `repo` and resolves once the data on screen is fresh. Repositories in
 * background tabs only mark it stale, and catch up when shown (see {@link setBackgroundRepos}).
 */
export const refreshRepo = (
  repo: RepoId,
  scopes: Iterable<DataScope> = EVERYTHING,
  client: QueryClient = queryClient,
): Promise<void> =>
  Promise.all([...new Set(scopes)].map((s) => refetchScope(client, repo, s))).then(() => {});

/** Tells the main process whether a repository is shown, so hidden ones do little work there. */
const setVisible = (repo: RepoId, visible: boolean) =>
  void api("repo.setVisible", repo, visible).catch(() => {});

/**
 * Sets which repositories are in background tabs; those brought forward catch up. The main
 * process polls and checks background repositories less (see `repo.setVisible`).
 */
export const setBackgroundRepos = (repos: Iterable<RepoId>, client: QueryClient = queryClient) => {
  const next = new Set(repos);
  for (const repo of background) {
    if (next.has(repo)) continue;
    setVisible(repo, true);
    void client.refetchQueries({ queryKey: keys.repo(repo), type: "active", stale: true });
  }
  for (const repo of next) if (!background.has(repo)) setVisible(repo, false);
  background.clear();
  for (const repo of next) background.add(repo);
};

/** Change events held back while an operation runs in a repository (see `runAction`). */
const held = new Map<RepoId, Set<DataScope>>();

/** Takes what the change events held back while an operation ran in `repo` outdated. */
export const takeHeldChanges = (repo: RepoId): Set<DataScope> => {
  const scopes = held.get(repo) ?? new Set<DataScope>();
  held.delete(repo);
  return scopes;
};

/** Keeps all repository queries in sync with change events from the main process. */
export const useRepoEvents = () => {
  const client = useQueryClient();

  useEvent("repo.changed", ({ repo, scopes }) => {
    const outdated = scopesOfChange(scopes);
    if (outdated.size === 0) return;
    // An operation (e.g. a rebase) can change the repository many times: refresh once, when it
    // is done. Network operations, which can take minutes, change refs only at the end.
    const busy = busyOf(repo);
    if (busy && !busy.cancellable) {
      const pending = held.get(repo) ?? new Set<DataScope>();
      for (const s of outdated) pending.add(s);
      held.set(repo, pending);
      return;
    }
    void refreshRepo(repo, outdated, client);
  });

  useEvent("repo.graphProgress", ({ repo, info }) => {
    client.setQueryData(keys.graphInfo(repo), info);
  });
};

/** Fills the caches with what opening a repository returned, so that it is not asked again. */
export const seedOpenedRepo = (info: RepoInfo, client: QueryClient = queryClient) => {
  client.setQueryData(keys.open(info.id), info);
  client.setQueryData(keys.info(info.id), info);
};

/** Drops everything cached for a closed repository: reopening it starts from fresh data. */
export const forgetRepoQueries = (repo: RepoId, client: QueryClient = queryClient) => {
  client.removeQueries({ queryKey: keys.repo(repo) });
  client.removeQueries({ queryKey: keys.open(repo) });
  held.delete(repo);
  background.delete(repo);
};
