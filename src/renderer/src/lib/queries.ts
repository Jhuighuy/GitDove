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
import { isHidden } from "@shared/visibility";
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
  graphPage: (repo: RepoId, version: number, page: number) =>
    ["repo", repo, "graph", "page", version, page] as const,
  commit: (repo: RepoId, hash: string) => ["repo", repo, "commit", hash] as const,
  diff: (repo: RepoId, target: DiffTarget) => ["repo", repo, "diff", target] as const,
  // Under "diff" so that it goes stale together with diffs.
  fileVersions: (repo: RepoId, target: DiffTarget) =>
    ["repo", repo, "diff", target, "versions"] as const,
  search: (repo: RepoId, q: string) => ["repo", repo, "search", q] as const,
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
 * Returns the graph rows in `[start, end)`, fetching pages on demand. While a
 * new graph version loads, rows from the previous version are kept on screen.
 */
export const useGraphRows = (
  repo: RepoId,
  info: GraphInfo | undefined,
  start: number,
  end: number,
) => {
  const pages = useMemo(() => {
    if (!info || end <= start) return [];
    const first = Math.floor(start / GRAPH_PAGE);
    const last = Math.floor(Math.max(start, end - 1) / GRAPH_PAGE);
    const out: number[] = [];
    for (let p = first; p <= last; p++) out.push(p);
    return out;
  }, [info, start, end]);

  const client = useQueryClient();
  const results = useQueries({
    queries: pages.map((page) => ({
      queryKey: keys.graphPage(repo, info!.version, page),
      queryFn: () =>
        api("repo.graphRows", repo, info!.version, page * GRAPH_PAGE, (page + 1) * GRAPH_PAGE),
      // While the graph is still streaming in, the last page grows.
      staleTime: info!.complete || (page + 1) * GRAPH_PAGE <= info!.count ? Infinity : 0,
      gcTime: 60 * 1000,
      placeholderData: () => previousPage(client, repo, info!.version, page),
    })),
  });

  return useMemo(() => {
    const rows = new Map<number, GraphRow>();
    results.forEach((r, i) => {
      const base = pages[i]! * GRAPH_PAGE;
      r.data?.forEach((row, j) => rows.set(base + j, row));
    });
    return rows;
  }, [results, pages]);
};

const previousPage = (client: QueryClient, repo: RepoId, version: number, page: number) => {
  for (let v = version - 1; v >= Math.max(0, version - 5); v--) {
    const data = client.getQueryData<GraphRow[]>(keys.graphPage(repo, v, page));
    if (data) return data;
  }
  return undefined;
};

/** Index of refs by commit hash, without refs hidden from the graph. */
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
      if (!ref.isHead && hiddenSet.size > 0 && isHidden(hiddenSet, ref.name)) continue;
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
