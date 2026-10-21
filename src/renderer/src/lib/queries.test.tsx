// @vitest-environment happy-dom
import type { GraphInfo, GraphRow, Ref } from "@shared/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  listeners: new Map<string, (payload: unknown) => void>(),
}));
vi.mock("./api", () => ({
  ApiError: class ApiError extends Error {
    constructor(readonly tag: string) {
      super(tag);
    }
  },
  api: mocks.api,
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
    keys.graphPage(repo, 1, 2),
    keys.commit(repo, "h"),
    keys.diff(repo, target),
    keys.search(repo, "x"),
  ]) {
    expect(key.slice(0, 2)).toEqual(keys.repo(repo));
  }
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
  committerTime: 0,
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

type RowsProps = { info: GraphInfo | undefined; start: number; end: number };
const useRows = ({ info, start, end }: RowsProps) => q.useGraphRows(repo, info, start, end);

it("fetches the graph pages covering a range of rows", async () => {
  mocks.api.mockImplementation(graphRows);
  const { result } = await renderHook(useRows, {
    info: graphInfo(),
    start: GRAPH_PAGE - 2,
    end: GRAPH_PAGE + 2,
  });
  await until(() => expect(result.current.size).toBe(2 * GRAPH_PAGE));
  expect(calls()).toEqual([
    ["repo.graphRows", repo, 1, 0, GRAPH_PAGE],
    ["repo.graphRows", repo, 1, GRAPH_PAGE, 2 * GRAPH_PAGE],
  ]);
  expect(result.current.get(GRAPH_PAGE + 1)?.hash).toBe(`v1:${GRAPH_PAGE + 1}`);
  expect(result.current.get(0)?.hash).toBe("v1:0");
});

it("fetches nothing without graph info or for an empty range", async () => {
  const { result, rerender } = await renderHook(useRows, { info: undefined, start: 0, end: 10 });
  expect(result.current.size).toBe(0);
  await rerender({ info: graphInfo(), start: 10, end: 10 });
  expect(result.current.size).toBe(0);
  expect(calls()).toEqual([]);
});

it("refetches the growing last page while the graph streams in", async () => {
  mocks.api.mockImplementation(graphRows);
  await renderHook(useRows, {
    info: graphInfo({ complete: false, count: GRAPH_PAGE + 10 }),
    start: 0,
    end: GRAPH_PAGE + 1,
  });
  await until(() => expect(calls()).toHaveLength(2));
  const staleTime = (page: number) =>
    (
      client.getQueryCache().find({ queryKey: keys.graphPage(repo, 1, page) })!.observers[0]!
        .options as { staleTime?: number }
    ).staleTime;
  expect(staleTime(0)).toBe(Infinity);
  expect(staleTime(1)).toBe(0);
});

it("keeps rows of a previous graph version while the new version loads", async () => {
  client.setQueryData(keys.graphPage(repo, 3, 0), [row("old")]);
  mocks.api.mockReturnValue(new Promise(() => {}));
  const { result } = await renderHook(useRows, {
    info: graphInfo({ version: 5 }),
    start: 0,
    end: 1,
  });
  expect(result.current.get(0)?.hash).toBe("old");
  // Versions too far back are not used.
  client.clear();
  client.setQueryData(keys.graphPage(repo, 1, 0), [row("ancient")]);
  const r2 = await renderHook(useRows, { info: graphInfo({ version: 7 }), start: 0, end: 1 });
  expect(r2.result.current.size).toBe(0);
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

it("invalidates queries on repository change events", async () => {
  const invalidated: unknown[] = [];
  vi.spyOn(client, "invalidateQueries").mockImplementation(async (f) => {
    invalidated.push(f?.queryKey);
  });
  await renderHook(() => q.useRepoEvents(), null);
  const changed = (...scopes: string[]) => {
    invalidated.length = 0;
    mocks.listeners.get("repo.changed")!({ repo, scopes });
    return [...invalidated];
  };
  const refsKeys = [keys.info(repo), keys.refs(repo)];
  const wtKeys = [keys.status(repo), ["repo", repo, "diff"]];
  expect(changed("refs")).toEqual(refsKeys);
  expect(changed("config")).toEqual(refsKeys);
  expect(changed("index")).toEqual(wtKeys);
  expect(changed("worktree")).toEqual(wtKeys);
  expect(changed("head")).toEqual([...refsKeys, ...wtKeys]);
  expect(changed()).toEqual([]);
});

it("stores graph progress from events", async () => {
  await renderHook(() => q.useRepoEvents(), null);
  mocks.listeners.get("repo.graphProgress")!({ repo, info: graphInfo({ count: 42 }) });
  expect(client.getQueryData(keys.graphInfo(repo))).toEqual(graphInfo({ count: 42 }));
});

it("refreshes everything of a repository", async () => {
  const spy = vi.spyOn(q.queryClient, "invalidateQueries").mockResolvedValue();
  await q.refreshRepo(repo);
  expect(spy).toHaveBeenCalledWith({ queryKey: ["repo", repo] });
  spy.mockRestore();
});
