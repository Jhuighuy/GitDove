// @vitest-environment happy-dom
import type { GraphInfo, GraphRow, Ref, RepoInfo } from "@shared/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  signals: [] as (AbortSignal | undefined)[],
  listeners: new Map<string, (payload: unknown) => void>(),
}));
vi.mock("./api", () => ({
  ApiError: class ApiError extends Error {
    constructor(readonly tag: string) {
      super(tag);
    }
  },
  api: mocks.api,
  apiWithSignal: (signal: AbortSignal | undefined, ...args: unknown[]) => {
    mocks.signals.push(signal);
    return mocks.api(...args);
  },
  useEvent: (event: string, listener: (payload: unknown) => void) => {
    mocks.listeners.set(event, listener);
  },
}));

const q = await import("./queries");
const { ApiError } = (await import("./api")) as unknown as {
  ApiError: new (tag: string) => Error;
};
const { GRAPH_PAGE, keys } = q;

const repo = "local:/repo";
let root: Root;
let client: QueryClient;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.api.mockReset();
  mocks.signals.length = 0;
  mocks.listeners.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
});

/** Renders a hook, returning a box with its latest value. */
async function renderHook<P, T>(hook: (props: P) => T, props: NoInfer<P>) {
  const result = { current: undefined as T };
  const Probe = (p: { props: P }) => {
    result.current = hook(p.props);
    return null;
  };
  const render = (next: P) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Probe props={next} />
        </QueryClientProvider>,
      ),
    );
  await render(props);
  return { result, rerender: render };
}

const until = (check: () => void) => act(() => vi.waitFor(check));
const calls = () => mocks.api.mock.calls;

it("retries only connection problems and defects, at most twice", () => {
  const retry = q.queryClient.getDefaultOptions().queries!.retry as (
    count: number,
    error: Error,
  ) => boolean;
  expect(retry(0, new Error("network"))).toBe(true);
  expect(retry(1, new ApiError("SshError"))).toBe(true);
  expect(retry(0, new ApiError("Defect"))).toBe(true);
  expect(retry(0, new ApiError("GitError"))).toBe(false);
  expect(retry(2, new ApiError("SshError"))).toBe(false);
  expect(q.queryClient.getDefaultOptions().queries).toMatchObject({
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
});

it("nests all keys under the repository", () => {
  const target = { kind: "unstaged", path: "a" } as const;
  for (const key of [
    keys.info(repo),
    keys.refs(repo),
    keys.status(repo),
    keys.graphInfo(repo),
    keys.graphPage(repo, 1, 2, GRAPH_PAGE),
    keys.commit(repo, "h"),
    keys.diff(repo, target),
    keys.search(repo, "x"),
    keys.hidden(repo),
  ]) {
    expect(key.slice(0, 2)).toEqual(keys.repo(repo));
  }
  // Opening a repository is not refreshed with its data.
  expect(keys.open(repo)).not.toEqual(expect.arrayContaining(["repo"]));
  // File versions go stale with diffs.
  expect(keys.fileVersions(repo, target).slice(0, 3)).toEqual(["repo", repo, "diff"]);
});

it("fetches repository data through the api", async () => {
  mocks.api.mockImplementation(async (method: string) => `${method} result`);
  const target = { kind: "staged", path: "f" } as const;
  const { result } = await renderHook(
    () => ({
      info: q.useRepoInfo(repo).data,
      refs: q.useRefs(repo).data,
      status: q.useStatus(repo).data,
      graph: q.useGraphInfo(repo).data,
      commit: q.useCommitDetails(repo, "abc").data,
      diff: q.useDiff(repo, target).data,
      versions: q.useFileVersions(repo, target).data,
    }),
    null,
  );
  await until(() => expect(result.current.versions).toBeDefined());
  expect(result.current).toEqual({
    info: "repo.info result",
    refs: "repo.refs result",
    status: "repo.status result",
    graph: "repo.graphInfo result",
    commit: "repo.commitDetails result",
    diff: "repo.diff result",
    versions: "repo.fileVersions result",
  });
  expect(calls()).toEqual(
    expect.arrayContaining([
      ["repo.info", repo],
      ["repo.refs", repo],
      ["repo.status", repo],
      ["repo.graphInfo", repo],
      ["repo.commitDetails", repo, "abc"],
      ["repo.diff", repo, target],
      ["repo.fileVersions", repo, target],
    ]),
  );
  // Each with its query's signal, so that the main process stops what nobody waits for.
  expect(mocks.signals).toHaveLength(calls().length);
  expect(mocks.signals.every((s) => s instanceof AbortSignal)).toBe(true);
});

it("cancels a query that no view waits for any more", async () => {
  mocks.api.mockReturnValue(new Promise(() => {}));
  await renderHook(() => q.useCommitDetails(repo, "abc"), null);
  await until(() => expect(mocks.signals).toHaveLength(1));
  expect(mocks.signals[0]!.aborted).toBe(false);
  await act(async () => root.unmount());
  root = createRoot(document.createElement("div"));
  expect(mocks.signals[0]!.aborted).toBe(true);
});

it("does not fetch commit details or diffs without a target", async () => {
  const { result } = await renderHook(
    () => [q.useCommitDetails(repo, null), q.useDiff(repo, null)] as const,
    null,
  );
  expect(calls()).toEqual([]);
  expect(result.current.map((r) => r.fetchStatus)).toEqual(["idle", "idle"]);
});

it("keeps the previous diff while the next one loads", async () => {
  let release!: () => void;
  mocks.api.mockImplementation(async (_m: string, _r: string, t: { path: string }) =>
    t.path === "a"
      ? "diff a"
      : new Promise((resolve) => (release = () => resolve(`diff ${t.path}`))),
  );
  const { result, rerender } = await renderHook(
    (path: string) => q.useDiff(repo, { kind: "unstaged", path }).data,
    "a",
  );
  await until(() => expect(result.current).toBe("diff a"));
  await rerender("b");
  expect(result.current).toBe("diff a");
  await act(async () => release());
  await until(() => expect(result.current).toBe("diff b"));
});

const row = (hash: string): GraphRow => ({
  hash,
  parents: [],
  subject: hash,
  authorName: "a",
  authorEmail: "a@x",
  authorTime: 0,
  lane: 0,
  color: 0,
  edges: [],
  width: 1,
});
const graphInfo = (extra: Partial<GraphInfo> = {}): GraphInfo => ({
  version: 1,
  count: 600,
  complete: true,
  maxLanes: 1,
  ...extra,
});
/** Returns rows named after their index. */
const graphRows = async (_m: string, _r: string, version: number, from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => row(`v${version}:${from + i}`));

/** Like the main process: serves only the rows built so far. */
const builtRows =
  (built: () => number) => (m: string, r: string, v: number, from: number, to: number) =>
    graphRows(m, r, v, from, Math.max(from, Math.min(to, built())));

type RowsProps = { info: GraphInfo | undefined; start: number; end: number };
const useRows = ({ info, start, end }: RowsProps) => q.useGraphRows(repo, info, start, end);

it("fetches the graph pages covering a range of rows", async () => {
  mocks.api.mockImplementation(graphRows);
  const { result } = await renderHook(useRows, {
    info: graphInfo(),
    start: GRAPH_PAGE - 2,
    end: GRAPH_PAGE + 2,
  });
  await until(() => expect(result.current.rows.size).toBe(2 * GRAPH_PAGE));
  expect(calls()).toEqual([
    ["repo.graphRows", repo, 1, 0, GRAPH_PAGE],
    ["repo.graphRows", repo, 1, GRAPH_PAGE, 2 * GRAPH_PAGE],
  ]);
  expect(result.current.rows.get(GRAPH_PAGE + 1)?.hash).toBe(`v1:${GRAPH_PAGE + 1}`);
  expect(result.current.rows.get(0)?.hash).toBe("v1:0");
  expect(result.current.current).toEqual(result.current.rows);
});

it("fetches nothing without graph info or for an empty range", async () => {
  const { result, rerender } = await renderHook(useRows, { info: undefined, start: 0, end: 10 });
  expect(result.current.rows.size).toBe(0);
  await rerender({ info: graphInfo(), start: 10, end: 10 });
  expect(result.current.rows.size).toBe(0);
  expect(calls()).toEqual([]);
});

it("refetches the growing last page while the graph streams in", async () => {
  let built = GRAPH_PAGE + 10;
  mocks.api.mockImplementation(builtRows(() => built));
  const props = (complete: boolean) => ({
    info: graphInfo({ complete, count: built }),
    start: GRAPH_PAGE,
    end: GRAPH_PAGE + 1,
  });
  const { result, rerender } = await renderHook(useRows, props(false));
  await until(() => expect(result.current.rows.size).toBe(10));

  built = GRAPH_PAGE + 100;
  await rerender(props(false));
  await until(() => expect(result.current.rows.size).toBe(100));

  built = 2 * GRAPH_PAGE + 5;
  await rerender(props(true));
  await until(() => expect(result.current.rows.size).toBe(GRAPH_PAGE));
  expect(result.current.rows.get(2 * GRAPH_PAGE - 1)?.hash).toBe(`v1:${2 * GRAPH_PAGE - 1}`);
});

it("keeps the shorter page on screen while the grown page loads", async () => {
  mocks.api.mockImplementation(builtRows(() => 10));
  const info = (count: number) => graphInfo({ complete: false, count });
  const { result, rerender } = await renderHook(useRows, { info: info(10), start: 0, end: 1 });
  await until(() => expect(result.current.rows.size).toBe(10));
  mocks.api.mockReturnValue(new Promise(() => {}));
  await rerender({ info: info(20), start: 0, end: 1 });
  expect(result.current.rows.size).toBe(10);
  // Shown, but not loaded for this graph.
  expect(result.current.current.size).toBe(0);
});

it("keeps rows of a previous graph version while the new version loads", async () => {
  client.setQueryData(keys.graphPage(repo, 3, 0, 1), [row("old")]);
  mocks.api.mockReturnValue(new Promise(() => {}));
  const { result } = await renderHook(useRows, {
    info: graphInfo({ version: 5 }),
    start: 0,
    end: 1,
  });
  expect(result.current.rows.get(0)?.hash).toBe("old");
  expect(result.current.current.size).toBe(0);
  // Versions too far back are not used.
  client.clear();
  client.setQueryData(keys.graphPage(repo, 1, 0, 1), [row("ancient")]);
  const r2 = await renderHook(useRows, { info: graphInfo({ version: 7 }), start: 0, end: 1 });
  expect(r2.result.current.rows.size).toBe(0);
});

const ref = (name: string, hash: string): Ref => ({
  name,
  short: name.replace(/^refs\/(heads|remotes|tags)\//, ""),
  kind: name.startsWith("refs/tags/") ? "tag" : "branch",
  hash,
  upstream: null,
  ahead: 0,
  behind: 0,
  upstreamGone: false,
  isHead: false,
  remote: null,
});

it("indexes refs by hash, without hidden refs", async () => {
  let hidden: string[] = [];
  mocks.api.mockImplementation(async (method: string) =>
    method === "repo.refs"
      ? {
          refs: [
            ref("refs/heads/main", "h1"),
            ref("refs/tags/v1", "h1"),
            ref("refs/heads/topic", "h2"),
            ref("refs/remotes/origin/main", "h1"),
          ],
          stashes: [],
          remotes: [],
          worktrees: [],
          submodules: [],
          owners: {
            byRef: { "refs/heads/topic": "ann@x" },
            people: { "ann@x": { name: "Ann", time: 0 } },
            me: { email: null, name: null },
          },
        }
      : hidden,
  );
  const names = (m: Map<string, Ref[]>) =>
    Object.fromEntries([...m].map(([h, refs]) => [h, refs.map((r) => r.short)]));
  const first = await renderHook(() => q.useRefsByHash(repo), null);
  await until(() => expect(first.result.current.size).toBe(2));
  expect(names(first.result.current)).toEqual({ h1: ["main", "v1", "origin/main"], h2: ["topic"] });
  expect(calls()).toContainEqual(["repo.hiddenRefs", repo]);

  client.clear();
  hidden = ["refs/remotes/", "refs/heads/topic"];
  const second = await renderHook(() => q.useRefsByHash(`${repo}2`), null);
  await until(() => expect(names(second.result.current)).toEqual({ h1: ["main", "v1"] }));

  // Branches of hidden contributors lose their pills too.
  client.clear();
  hidden = ["person:ann"];
  const third = await renderHook(() => q.useRefsByHash(`${repo}3`), null);
  await until(() =>
    expect(names(third.result.current)).toEqual({ h1: ["main", "v1", "origin/main"] }),
  );
});

it("keeps the checked-out branch even when it is hidden", async () => {
  // Hiding a branch and then checking it out used to drop its pill, leaving origin/x alone.
  mocks.api.mockImplementation(async (method: string) =>
    method === "repo.refs"
      ? {
          refs: [
            { ...ref("refs/heads/topic", "h2"), isHead: true },
            ref("refs/remotes/origin/topic", "h2"),
            ref("refs/heads/other", "h3"),
          ],
          stashes: [],
          remotes: [],
          worktrees: [],
          submodules: [],
          owners: { byRef: {}, people: {}, me: { email: null, name: null } },
        }
      : ["refs/heads/"],
  );
  const view = await renderHook(() => q.useRefsByHash(`${repo}-head`), null);
  await until(() => expect(view.result.current.size).toBe(1));
  expect(view.result.current.get("h2")!.map((r) => [r.short, r.isHead])).toEqual([
    ["topic", true],
    ["origin/topic", false],
  ]);
});

it("invalidates what a repository change event outdates", async () => {
  const invalidated: unknown[] = [];
  vi.spyOn(client, "invalidateQueries").mockImplementation(async (f) => {
    invalidated.push(f?.queryKey);
  });
  await renderHook(() => q.useRepoEvents(), null);
  const changed = async (...scopes: string[]) => {
    invalidated.length = 0;
    mocks.listeners.get("repo.changed")!({ repo, scopes });
    await act(async () => {});
    return [...invalidated];
  };
  const refsKeys = [keys.info(repo), keys.refs(repo)];
  const wtKeys = [keys.status(repo), keys.diffs(repo)];
  expect(await changed("refs")).toEqual([...refsKeys, keys.searches(repo)]);
  expect(await changed("config")).toEqual(refsKeys);
  expect(await changed("index")).toEqual(wtKeys);
  expect(await changed("worktree")).toEqual(wtKeys);
  expect(await changed("head")).toEqual([...refsKeys, keys.searches(repo), ...wtKeys]);
  expect(await changed()).toEqual([]);
});

it("leaves commit diffs alone on working tree changes", async () => {
  await renderHook(() => q.useRepoEvents(), null);
  const commit = { kind: "commit", hash: "c", path: "f" } as const;
  const unstaged = { kind: "unstaged", path: "f" } as const;
  for (const key of [
    keys.diff(repo, commit),
    keys.fileVersions(repo, commit),
    keys.diff(repo, unstaged),
    keys.fileVersions(repo, unstaged),
    keys.commit(repo, "c"),
  ])
    client.setQueryData(key, "data");
  mocks.listeners.get("repo.changed")!({ repo, scopes: ["worktree"] });
  const stale = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated;
  expect(stale(keys.diff(repo, unstaged))).toBe(true);
  expect(stale(keys.fileVersions(repo, unstaged))).toBe(true);
  expect(stale(keys.diff(repo, commit))).toBe(false);
  expect(stale(keys.fileVersions(repo, commit))).toBe(false);
  expect(stale(keys.commit(repo, "c"))).toBe(false);
});

it("coalesces bursts of changes into one more refetch after the running one", async () => {
  let release!: () => void;
  let statusCalls = 0;
  mocks.api.mockImplementation(async (method: string) => {
    if (method !== "repo.status") return null;
    statusCalls++;
    await new Promise<void>((r) => (release = r));
    return `status ${statusCalls}`;
  });
  const view = await renderHook(() => [q.useRepoEvents(), q.useStatus(repo).data][1], null);
  await act(async () => release());
  await until(() => expect(view.result.current).toBe("status 1"));

  for (let i = 0; i < 5; i++) mocks.listeners.get("repo.changed")!({ repo, scopes: ["index"] });
  await act(async () => {});
  expect(statusCalls).toBe(2);
  // The changes made while it ran need one more run, not five, and none was cancelled.
  await act(async () => release());
  await until(() => expect(statusCalls).toBe(3));
  await act(async () => release());
  await until(() => expect(view.result.current).toBe("status 3"));
  expect(statusCalls).toBe(3);
});

it("holds change events back while an operation runs in the repository", async () => {
  const { useBusyStore } = await import("@/stores/busy");
  const spy = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
  await renderHook(() => q.useRepoEvents(), null);
  useBusyStore.getState().start(repo, { label: "Rebasing…", cancellable: false });
  mocks.listeners.get("repo.changed")!({ repo, scopes: ["refs"] });
  mocks.listeners.get("repo.changed")!({ repo, scopes: ["index"] });
  expect(spy).not.toHaveBeenCalled();
  expect([...q.takeHeldChanges(repo)].toSorted()).toEqual(
    ["info", "refs", "search", "status", "workingDiffs"].toSorted(),
  );
  expect(q.takeHeldChanges(repo).size).toBe(0);
  // Network operations take long, and change refs only at the end: they hold nothing back.
  useBusyStore.getState().start(repo, { label: "Fetching…", cancellable: true });
  mocks.listeners.get("repo.changed")!({ repo, scopes: ["index"] });
  expect(spy).toHaveBeenCalled();
  useBusyStore.getState().finish(repo);
});

it("only marks data of background repositories stale, and refetches it when shown", async () => {
  mocks.api.mockResolvedValue("status");
  const statusCalls = () => calls().filter(([method]) => method === "repo.status");
  const visibility = () => calls().filter(([method]) => method === "repo.setVisible");
  await renderHook(() => [q.useRepoEvents(), q.useStatus(repo)], null);
  await until(() => expect(statusCalls()).toHaveLength(1));
  q.setBackgroundRepos([repo], client);
  q.setBackgroundRepos([repo], client);
  await act(async () => q.refreshRepo(repo, ["status"], client));
  expect(statusCalls()).toHaveLength(1);
  expect(client.getQueryState(keys.status(repo))?.isInvalidated).toBe(true);
  q.setBackgroundRepos([], client);
  await until(() => expect(statusCalls()).toHaveLength(2));
  // The main process is told only about changes.
  expect(visibility()).toEqual([
    ["repo.setVisible", repo, false],
    ["repo.setVisible", repo, true],
  ]);
});

it("refreshes everything but the opening and commits on request", async () => {
  const filters: unknown[] = [];
  const spy = vi.spyOn(q.queryClient, "invalidateQueries").mockImplementation(async (f) => {
    filters.push(f?.queryKey);
  });
  await q.refreshRepo(repo);
  expect(filters).toEqual([
    keys.info(repo),
    keys.refs(repo),
    keys.searches(repo),
    keys.status(repo),
    keys.diffs(repo),
    keys.graphInfo(repo),
    keys.hidden(repo),
  ]);
  spy.mockRestore();
});

it("seeds the caches from opening a repository, and forgets them on close", () => {
  const info = { id: repo } as RepoInfo;
  q.seedOpenedRepo(info, client);
  expect(client.getQueryData(keys.open(repo))).toBe(info);
  expect(client.getQueryData(keys.info(repo))).toBe(info);
  client.setQueryData(keys.status(repo), "status");
  client.setQueryData(keys.open("local:/other"), "other");
  q.forgetRepoQueries(repo, client);
  expect(client.getQueryData(keys.open(repo))).toBeUndefined();
  expect(client.getQueryData(keys.status(repo))).toBeUndefined();
  expect(client.getQueryData(keys.open("local:/other"))).toBe("other");
});

it("stores graph progress from events", async () => {
  await renderHook(() => q.useRepoEvents(), null);
  mocks.listeners.get("repo.graphProgress")!({ repo, info: graphInfo({ count: 42 }) });
  expect(client.getQueryData(keys.graphInfo(repo))).toEqual(graphInfo({ count: 42 }));
});
