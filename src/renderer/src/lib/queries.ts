import type { DiffTarget, GraphInfo, GraphRow, Ref, RepoId } from "@shared/domain";
import type { RepoChangeScope } from "@shared/ipc";
import {
  keepPreviousData,
  QueryClient,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { isFilteredOut, isHidden } from "@shared/visibility";
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
  info: (repo: RepoId) => ["repo", repo, "info"] as const,
  refs: (repo: RepoId) => ["repo", repo, "refs"] as const,
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
  diff: (repo: RepoId, target: DiffTarget) => ["repo", repo, "diff", target] as const,
  // Under "diff" so that it goes stale together with diffs.
  fileVersions: (repo: RepoId, target: DiffTarget) =>
    ["repo", repo, "diff", target, "versions"] as const,
  search: (repo: RepoId, q: string) => ["repo", repo, "search", q] as const,
  isGitlab: (origin: string) => ["web", "isGitlab", origin] as const,
};

export const useRepoInfo = (repo: RepoId) =>
  useQuery({ queryKey: keys.info(repo), queryFn: () => api("repo.info", repo) });

export const useRefs = (repo: RepoId) =>
  useQuery({
    queryKey: keys.refs(repo),
    queryFn: () => api("repo.refs", repo),
    placeholderData: keepPreviousData,
  });

export const useStatus = (repo: RepoId) =>
  useQuery({
    queryKey: keys.status(repo),
    queryFn: () => api("repo.status", repo),
    placeholderData: keepPreviousData,
  });

export const useGraphInfo = (repo: RepoId) =>
  useQuery({
    queryKey: keys.graphInfo(repo),
    queryFn: () => api("repo.graphInfo", repo),
    placeholderData: keepPreviousData,
  });

export const useCommitDetails = (repo: RepoId, hash: string | null) =>
  useQuery({
    queryKey: keys.commit(repo, hash ?? ""),
    queryFn: () => api("repo.commitDetails", repo, hash!),
    enabled: hash !== null,
    // Commits are immutable.
    gcTime: 60 * 1000,
  });

/** The changes from `base` (the empty tree when null) to `tip`; null `tip` fetches nothing. */
export const useCompare = (repo: RepoId, base: string | null, tip: string | null) =>
  useQuery({
    queryKey: keys.compare(repo, base, tip ?? ""),
    queryFn: () => api("repo.compare", repo, base, tip!),
    enabled: tip !== null,
    // Commits are immutable.
    gcTime: 60 * 1000,
  });

export const useDiff = (repo: RepoId, target: DiffTarget | null) =>
  useQuery({
    queryKey: target ? keys.diff(repo, target) : ["none"],
    queryFn: () => api("repo.diff", repo, target!),
    enabled: target !== null,
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
) => {
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

  const client = useQueryClient();
  const version = info?.version ?? 0;
  const results = useQueries({
    queries: pages.map(({ page, size }) => ({
      queryKey: keys.graphPage(repo, version, page, size),
      queryFn: () =>
        api("repo.graphRows", repo, version, page * GRAPH_PAGE, page * GRAPH_PAGE + size),
      staleTime: Infinity,
      gcTime: 60 * 1000,
      placeholderData: () => placeholderPage(client, repo, version, page),
    })),
  });

  return useMemo(() => {
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
  }, [results, pages]);
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
  const { data: hidden } = useQuery({
    queryKey: [...keys.repo(repo), "hidden"],
    queryFn: () => api("repo.hiddenRefs", repo),
  });
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

/** Keeps all repository queries in sync with change events from the main process. */
export const useRepoEvents = () => {
  const client = useQueryClient();

  useEvent("repo.changed", ({ repo, scopes }) => {
    const s = new Set<RepoChangeScope>(scopes);
    if (s.has("refs") || s.has("head") || s.has("config")) {
      void client.invalidateQueries({ queryKey: keys.info(repo) });
      void client.invalidateQueries({ queryKey: keys.refs(repo) });
    }
    if (s.has("index") || s.has("worktree") || s.has("head")) {
      void client.invalidateQueries({ queryKey: keys.status(repo) });
      void client.invalidateQueries({ queryKey: ["repo", repo, "diff"] });
    }
  });

  useEvent("repo.graphProgress", ({ repo, info }) => {
    client.setQueryData(keys.graphInfo(repo), info);
  });
};

/** Forces a full refresh of a repository's data. */
export const refreshRepo = (repo: RepoId) =>
  queryClient.invalidateQueries({ queryKey: keys.repo(repo) });
