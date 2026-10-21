// @vitest-environment happy-dom
import type { RefsSnapshot } from "@shared/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { allVisibilityNames, useVisibility } from "./visibility";

const mocks = vi.hoisted(() => ({
  hidden: [] as string[],
  fail: false,
  calls: [] as string[],
  toasts: [] as string[],
}));

vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  api: async (method: string, _repo: string, arg?: string[]) => {
    mocks.calls.push(method);
    switch (method) {
      case "repo.refs":
        return snapshot;
      case "repo.hiddenRefs":
        return mocks.hidden;
      case "repo.setHiddenRefs":
        if (mocks.fail) throw new Error("read-only config");
        mocks.hidden = arg!;
        return undefined;
    }
    throw new Error(`unexpected ${method}`);
  },
}));
vi.mock("sonner", () => ({
  toast: {
    error: (title: string, o: { description: string }) =>
      mocks.toasts.push(`${title}: ${o.description}`),
  },
}));

const snapshot = {
  refs: [
    { name: "refs/heads/main", short: "main" },
    { name: "refs/remotes/origin/HEAD", short: "origin/HEAD" },
    { name: "refs/remotes/origin/main", short: "origin/main" },
  ],
  stashes: [{ hash: "s1" }],
} as unknown as RefsSnapshot;

let root: Root | undefined;
const probe = { vis: null as unknown as ReturnType<typeof useVisibility> };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.hidden = [];
  mocks.fail = false;
  mocks.calls = [];
  mocks.toasts = [];
});

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = "";
});

/** Reports the visibility state of the repository. */
function Probe({ onValue }: { onValue: (v: ReturnType<typeof useVisibility>) => void }) {
  const value = useVisibility("local:/repo");
  // Report after commit: renders can be replayed or dropped.
  useEffect(() => {
    onValue(value);
  });
  return null;
}

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

async function render() {
  const r = createRoot(document.createElement("div"));
  root = r;
  await act(async () =>
    r.render(
      <QueryClientProvider client={new QueryClient()}>
        <Probe onValue={(v) => (probe.vis = v)} />
      </QueryClientProvider>,
    ),
  );
  await act(() => vi.waitFor(() => expect(probe.vis.all).toHaveLength(3)));
}

it("lists refs (without symbolic HEADs) and stashes", () => {
  expect(allVisibilityNames(snapshot)).toEqual([
    "refs/heads/main",
    "refs/remotes/origin/main",
    "stash:s1",
  ]);
  expect(allVisibilityNames(undefined)).toEqual([]);
});

it("hides, shows and solos names", async () => {
  await render();
  expect(probe.vis.anyHidden).toBe(false);
  await act(async () => probe.vis.hide(["refs/remotes/origin/"]));
  await settle();
  expect(probe.vis.isHidden("refs/remotes/origin/main")).toBe(true);
  expect(probe.vis.anyHidden).toBe(true);
  await act(async () => probe.vis.toggle("refs/remotes/origin/main"));
  await settle();
  expect(probe.vis.hidden).toEqual([]);
  await act(async () => probe.vis.solo(["stash:s1"]));
  await settle();
  expect(probe.vis.hidden).toEqual(["refs/heads/main", "refs/remotes/origin/main"]);
  await act(async () => probe.vis.show(["refs/heads/main"]));
  await settle();
  expect(probe.vis.hidden).toEqual(["refs/remotes/origin/main"]);
  await act(async () => probe.vis.showAll());
  await settle();
  expect(mocks.hidden).toEqual([]);
});

it("toggles groups by prefix or name by name", async () => {
  await render();
  await act(async () =>
    probe.vis.toggleGroup(["refs/remotes/origin/main"], "refs/remotes/origin/"),
  );
  await settle();
  expect(probe.vis.hidden).toEqual(["refs/remotes/origin/"]);
  await act(async () =>
    probe.vis.toggleGroup(["refs/remotes/origin/main"], "refs/remotes/origin/"),
  );
  await settle();
  expect(probe.vis.hidden).toEqual([]);
  await act(async () => probe.vis.toggleGroup(["refs/heads/main"]));
  await settle();
  expect(probe.vis.hidden).toEqual(["refs/heads/main"]);
  // An empty group is never "all hidden".
  await act(async () => probe.vis.toggleGroup([]));
  await settle();
  expect(probe.vis.hidden).toEqual(["refs/heads/main"]);
});

it("reports a failed save and reloads the saved state", async () => {
  mocks.hidden = ["refs/heads/main"];
  await render();
  await act(() => vi.waitFor(() => expect(probe.vis.hidden).toEqual(["refs/heads/main"])));
  mocks.fail = true;
  await act(async () => probe.vis.showAll());
  await settle();
  await settle();
  expect(mocks.toasts).toEqual(["Could not update graph visibility: Error: read-only config"]);
  // The optimistic update is rolled back from the main process.
  await act(() => vi.waitFor(() => expect(probe.vis.hidden).toEqual(["refs/heads/main"])));
  expect(mocks.calls.filter((c) => c === "repo.hiddenRefs")).toHaveLength(2);
});
