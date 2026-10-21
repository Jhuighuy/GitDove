// @vitest-environment happy-dom
import type { GraphInfo, RepoInfo } from "@shared/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useBusyStore } from "@/stores/busy";
import { StatusBar } from "./StatusBar";

const mocks = vi.hoisted(() => ({
  commands: [] as unknown[][],
  info: null as unknown,
  graph: null as unknown,
}));

vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  useEvent: () => {},
  api: async (method: string) => {
    if (method === "repo.info") return mocks.info;
    if (method === "repo.graphInfo") return mocks.graph;
    throw new Error(`unexpected ${method}`);
  },
}));
vi.mock("../commands", () => ({
  commands: { cancel: (...args: unknown[]) => void mocks.commands.push(["cancel", ...args]) },
}));

const REPO = "ssh://fedora.lab.example.com/home/me/project";

const info = (extra: Partial<RepoInfo> = {}): RepoInfo =>
  ({
    id: REPO,
    location: { kind: "ssh", host: "fedora.lab.example.com", path: "/home/me/project" },
    name: "project",
    workTree: "/home/me/project",
    gitDir: "/home/me/project/.git",
    bare: false,
    head: { branch: "main", hash: "0123456789abcdef", detached: false },
    state: "clean",
    ...extra,
  }) as RepoInfo;

const graph = (extra: Partial<GraphInfo> = {}): GraphInfo => ({
  version: 1,
  count: 10,
  complete: true,
  maxLanes: 1,
  ...extra,
});

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.commands = [];
  mocks.info = info();
  mocks.graph = graph();
  useBusyStore.setState({ byRepo: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

/** Renders the status bar and waits until `text` shows. */
async function render(text = "/home/me/project") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <StatusBar repo={REPO} />
      </QueryClientProvider>,
    ),
  );
  await act(() =>
    vi.waitFor(() => {
      if (!container.textContent?.includes(text)) throw new Error(`no ${text}`);
    }),
  );
}

it("shows the SSH host and the repository path", async () => {
  await render();
  const host = container.querySelector<HTMLElement>("[title='fedora.lab.example.com']")!;
  expect(host.textContent).toBe("fedora.lab.example.com");
  expect(container.querySelector("[title='/home/me/project']")).not.toBeNull();
  expect(container.textContent).not.toContain("Local");
});

it("says Local for a local repository", async () => {
  mocks.info = info({
    location: { kind: "local", path: "/work/project" },
    workTree: "/work/project",
  });
  await render("/work/project");
  expect(container.textContent).toContain("Local");
});

it("shows history still loading", async () => {
  mocks.graph = graph({ count: 1234, complete: false });
  await render("1,234");
  expect(container.textContent).toContain("Loading history… 1,234 commits");
});

it("shows the running operation, with a cancel button for network operations", async () => {
  await render();
  expect(container.querySelector("output")).toBeNull();
  await act(async () =>
    useBusyStore.getState().start(REPO, { label: "Checking out feature…", cancellable: false }),
  );
  expect(container.querySelector("output")?.textContent).toBe("Checking out feature…");
  expect(container.querySelector("[aria-label='Cancel']")).toBeNull();
  await act(async () => useBusyStore.getState().finish(REPO));
  expect(container.querySelector("output")).toBeNull();

  await act(async () =>
    useBusyStore.getState().start(REPO, { label: "Pulling…", cancellable: true }),
  );
  await act(async () => container.querySelector<HTMLElement>("[aria-label='Cancel']")!.click());
  expect(mocks.commands).toEqual([["cancel", REPO]]);
});
