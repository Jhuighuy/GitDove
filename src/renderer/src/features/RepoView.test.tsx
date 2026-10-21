// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useLayout, useRepoUiStore } from "@/stores/repo-ui";
import { useTabs } from "@/stores/tabs";
import { RepoView } from "./RepoView";

const mocks = vi.hoisted(() => ({
  api: [] as unknown[][],
  commands: [] as unknown[][],
  refreshed: [] as string[],
  listeners: new Map<string, Set<(payload: unknown) => void>>(),
  openError: null as Error | null,
  open: null as (() => void) | null,
}));

vi.mock("@/lib/api", async () => {
  const { useEffect, useRef } = await import("react");
  return {
    ApiError: class extends Error {},
    api: async (method: string, ...args: unknown[]) => {
      mocks.api.push([method, ...args]);
      if (method === "repo.open") {
        if (mocks.open) await new Promise<void>((r) => (mocks.open = r));
        if (mocks.openError) throw mocks.openError;
        return { name: "repo" };
      }
      if (method === "app.setState") return undefined;
      throw new Error(`unexpected ${method}`);
    },
    useEvent: (event: string, listener: (payload: unknown) => void) => {
      const ref = useRef(listener);
      ref.current = listener;
      useEffect(() => {
        const fn = (p: unknown) => ref.current(p);
        let set = mocks.listeners.get(event);
        if (!set) mocks.listeners.set(event, (set = new Set()));
        set.add(fn);
        return () => void set.delete(fn);
      }, [event]);
    },
  };
});
vi.mock("@/lib/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries")>()),
  refreshRepo: (repo: string) => {
    mocks.refreshed.push(repo);
    return Promise.resolve();
  },
}));
vi.mock("./commands", () => ({
  commands: new Proxy(
    {},
    {
      get:
        (_, command: string) =>
        (...args: unknown[]) =>
          void mocks.commands.push([command, ...args]),
    },
  ),
}));
vi.mock("./toolbar/Toolbar", () => ({ Toolbar: () => <div data-testid="toolbar" /> }));
vi.mock("./sidebar/Sidebar", () => ({ Sidebar: () => <div data-testid="sidebar" /> }));
vi.mock("./graph/CommitGraph", () => ({ CommitGraph: () => <div data-testid="graph" /> }));
vi.mock("./diff/DiffView", () => ({
  DiffView: ({ target }: { target: { path: string } }) => (
    <div data-testid="diff">{target.path}</div>
  ),
}));
vi.mock("./details/DetailsPanel", () => ({ DetailsPanel: () => <div data-testid="details" /> }));

let root: Root;
let container: HTMLElement;
let n = 0;
let repo = "";

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.api = [];
  mocks.commands = [];
  mocks.refreshed = [];
  mocks.openError = null;
  mocks.open = null;
  useLayout.setState({ sidebar: true, details: true });
  repo = `local:/repos/r${++n}`;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

async function render(active = true, id = repo) {
  const client = new QueryClient();
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <RepoView repo={id} active={active} />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

const has = (id: string) => container.querySelector(`[data-testid=${id}]`) !== null;
const menu = (command: string) =>
  act(async () => {
    for (const l of mocks.listeners.get("menu.command") ?? []) l({ command });
  });
const button = (label: string) => {
  const el = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!el) throw new Error(`No "${label}" button`);
  return el;
};

it("shows progress while opening, then the repository layout", async () => {
  mocks.open = () => {};
  await render(true, "ssh://fedora/home/me/cholx");
  expect(container.textContent).toContain("Connecting to fedora…");
  await act(async () => mocks.open?.());
  await settle();
  expect(mocks.api[0]).toEqual([
    "repo.open",
    { kind: "ssh", host: "fedora", path: "/home/me/cholx" },
  ]);
  expect(["toolbar", "sidebar", "graph", "details"].map(has)).toEqual([true, true, true, true]);
});

it("says it is opening a local repository", async () => {
  mocks.open = () => {};
  await render();
  expect(container.textContent).toContain("Opening repository…");
  await act(async () => mocks.open?.());
});

it("shows the diff instead of the graph, and hides panels", async () => {
  await render();
  await act(async () =>
    useRepoUiStore.getState().openDiff(repo, { kind: "unstaged", path: "a.ts" }),
  );
  expect(has("graph")).toBe(false);
  expect(container.querySelector("[data-testid=diff]")?.textContent).toBe("a.ts");
  await act(async () => useLayout.setState({ sidebar: false, details: false }));
  expect(has("sidebar")).toBe(false);
  expect(has("details")).toBe(false);
});

it("runs menu commands in the active tab only", async () => {
  await render();
  for (const c of ["refresh", "fetch", "pull", "push", "stash", "pop", "new-branch", "open-repo"])
    await menu(c);
  expect(mocks.refreshed).toEqual([repo]);
  expect(mocks.commands).toEqual([
    ["fetch", repo],
    ["pull", repo],
    ["push", repo],
    ["stash", repo],
    ["pop", repo],
    ["createBranch", repo, "HEAD"],
  ]);
  await menu("toggle-sidebar");
  await menu("toggle-details");
  expect(useLayout.getState()).toMatchObject({ sidebar: false, details: false });

  await render(false);
  mocks.commands = [];
  await menu("fetch");
  await menu("toggle-sidebar");
  expect(mocks.commands).toEqual([]);
  expect(useLayout.getState().sidebar).toBe(false);
});

it("refreshes when the window regains focus, while active", async () => {
  await render();
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(mocks.refreshed).toEqual([repo]);
  await render(false);
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(mocks.refreshed).toEqual([repo]);
});

it("offers to retry or close a repository that fails to open", async () => {
  mocks.openError = new Error("not a git repository");
  useTabs.setState({ tabs: [{ key: "t1", repo }], active: "t1", recent: [repo, "local:/other"] });
  await render();
  expect(container.textContent).toContain(`Could not open /repos/r${n}`);
  expect(container.textContent).toContain("not a git repository");

  mocks.openError = null;
  await act(async () => button("Retry").click());
  await settle();
  expect(has("toolbar")).toBe(true);
  expect(mocks.api.filter(([m]) => m === "repo.open")).toHaveLength(2);
});

it("closes the tab of a repository that fails to open", async () => {
  mocks.openError = new Error("gone");
  useTabs.setState({
    tabs: [
      { key: "t1", repo },
      { key: "t2", repo: "local:/other" },
    ],
    active: "t1",
    recent: [repo, "local:/other"],
  });
  await render();
  await act(async () => button("Close").click());
  const tabs = useTabs.getState();
  expect(tabs.recent).toEqual(["local:/other"]);
  expect(tabs.tabs.map((t) => t.key)).toEqual(["t2"]);

  // Without a tab (e.g. already closed) it only forgets the repository.
  useTabs.setState({ tabs: [], recent: [repo] });
  await act(async () => button("Close").click());
  expect(useTabs.getState().recent).toEqual([]);
});

it("gives each tab's panels their own ids", async () => {
  // The panel library keys layout state by id; a shared one made a tab opened after a hidden
  // one keep that tab's unmeasured layout.
  const client = new QueryClient();
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <RepoView repo={repo} active={false} />
        <RepoView repo={`${repo}-other`} active />
      </QueryClientProvider>,
    ),
  );
  await settle();
  const ids = [...container.querySelectorAll("[id]")].map((el) => el.id);
  const groups = [...container.querySelectorAll('[data-slot="resizable-panel-group"]')];
  expect(groups).toHaveLength(2);
  expect(new Set(ids).size).toBe(ids.length);
});
