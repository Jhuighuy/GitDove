// @vitest-environment happy-dom
import type { GraphInfo, UpdaterStatus } from "@shared/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { keys } from "@/lib/queries";
import { useBusyStore } from "@/stores/busy";
import { APP, notify, useStatusStore } from "@/stores/status";
import { StatusBar } from "./StatusBar";

const mocks = vi.hoisted(() => ({
  api: [] as unknown[][],
  commands: [] as unknown[][],
  updater: { kind: "idle" } as UpdaterStatus,
  listeners: new Map<string, (payload: never) => void>(),
}));

vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  useEvent: (event: string, listener: (payload: never) => void) =>
    mocks.listeners.set(event, listener),
  api: async (method: string, ...args: unknown[]) => {
    mocks.api.push([method, ...args]);
    if (method === "updater.status") return mocks.updater;
    if (method === "updater.install") return undefined;
    throw new Error(`unexpected ${method}`);
  },
}));
vi.mock("../commands", () => ({
  commands: { cancel: (...args: unknown[]) => void mocks.commands.push(["cancel", ...args]) },
}));

const SSH = "ssh://fedora.lab.example.com/home/me/project";
const LOCAL = "local:/work/project";

let root: Root;
let container: HTMLElement;
let client: QueryClient;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.api = [];
  mocks.commands = [];
  mocks.updater = { kind: "idle" };
  mocks.listeners.clear();
  useBusyStore.setState({ byRepo: {} });
  useStatusStore.setState({ notices: {}, activities: [] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const render = (repo: string | null) =>
  act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <StatusBar repo={repo} />
      </QueryClientProvider>,
    ),
  );
const text = () => container.textContent ?? "";
/** Sets cached query data; the query delivers updates on the next tick. */
const setCached = (key: readonly unknown[], data: unknown) =>
  act(async () => {
    client.setQueryData(key, data);
    await new Promise((r) => setTimeout(r, 0));
  });

it("shows where the active repository lives", async () => {
  await render(SSH);
  const host = container.querySelector<HTMLElement>("[title='fedora.lab.example.com']")!;
  expect(host.textContent).toBe("fedora.lab.example.com");
  expect(container.querySelector("[title='/home/me/project']")).not.toBeNull();
  expect(text()).not.toContain("Local");

  await render(LOCAL);
  expect(text()).toContain("Local");
  expect(text()).toContain("/work/project");

  // A blank tab has no repository.
  await render(null);
  expect(text()).toBe("");
});

it("shows history still loading, without asking an unopened repository", async () => {
  await render(LOCAL);
  expect(mocks.api.filter(([m]) => m === "repo.graphInfo")).toEqual([]);
  const info: GraphInfo = { version: 1, count: 1234, complete: false, maxLanes: 2 };
  await setCached(keys.graphInfo(LOCAL), info);
  expect(text()).toContain("Loading history… 1,234 commits");
  await setCached(keys.graphInfo(LOCAL), { ...info, complete: true });
  expect(text()).not.toContain("Loading history");
});

it("shows the running operation, with a cancel button for network operations", async () => {
  await render(SSH);
  await act(async () =>
    useBusyStore.getState().start(SSH, { label: "Checking out feature…", cancellable: false }),
  );
  expect(container.querySelector("output")?.textContent).toBe("Checking out feature…");
  expect(container.querySelector("[aria-label='Cancel']")).toBeNull();
  await act(async () => useBusyStore.getState().finish(SSH));
  expect(container.querySelector("output")).toBeNull();

  await act(async () =>
    useBusyStore.getState().start(SSH, { label: "Pulling…", cancellable: true }),
  );
  await act(async () => container.querySelector<HTMLElement>("[aria-label='Cancel']")!.click());
  expect(mocks.commands).toEqual([["cancel", SSH]]);
  // Another tab's operation is not shown.
  await render(LOCAL);
  expect(text()).not.toContain("Pulling…");
});

it("shows results of the active repository and of the app", async () => {
  await render(LOCAL);
  await act(async () => notify(LOCAL, "Pushed main"));
  expect(text()).toContain("Pushed main");
  await act(async () => notify(SSH, "Fetched"));
  expect(text()).not.toContain("Fetched");
  await act(async () => notify(APP, "Commit SHA copied", "info"));
  expect(text()).toContain("Commit SHA copied");
  // A running operation takes the result's place.
  await act(async () =>
    useBusyStore.getState().start(LOCAL, { label: "Pulling…", cancellable: false }),
  );
  expect(text()).not.toContain("Pushed main");
  expect(text()).toContain("Pulling…");
});

it("shows app-wide activity, e.g. while a repository opens", async () => {
  await render(null);
  let end = () => {};
  await act(async () => {
    end = useStatusStore.getState().startActivity("Connecting to fedora…");
  });
  expect(container.querySelector("output")?.textContent).toBe("Connecting to fedora…");
  await act(async () => end());
  expect(container.querySelector("output")).toBeNull();
});

it("offers to restart for a downloaded update", async () => {
  mocks.updater = { kind: "ready", version: "0.1.45" };
  await render(null);
  expect(text()).toContain("GitDove 0.1.45 is ready");
  const restart = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "Restart",
  )!;
  await act(async () => restart.click());
  expect(mocks.api).toContainEqual(["updater.install"]);
});

it("shows an update that arrives later", async () => {
  await render(LOCAL);
  expect(text()).not.toContain("is ready");
  await act(async () =>
    mocks.listeners.get("updater.status")!({ kind: "downloading", percent: 50 } as never),
  );
  expect(text()).not.toContain("is ready");
  await act(async () =>
    mocks.listeners.get("updater.status")!({ kind: "ready", version: "0.1.46" } as never),
  );
  expect(text()).toContain("GitDove 0.1.46 is ready");
});
