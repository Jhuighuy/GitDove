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
  owners: {
    byRef: { "refs/heads/main": ["ann@x"], "refs/remotes/origin/main": ["ann@corp", "bob@x"] },
    people: {
      "ann@x": { name: "Ann Lee", time: 1 },
      "ann@corp": { name: "ann lee", time: 5 },
      "bob@x": { name: "Bob", time: 1 },
    },
    me: { email: null, name: "Bob" },
  },
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

it("filters branches by contributor", async () => {
  await render();
  const bob = {
    person: "bob",
    name: "Bob",
    avatarEmail: "bob@x",
    emails: [{ email: "bob@x", name: "Bob", branches: 1 }],
    branches: 1,
    isMe: true,
  };
  const ann = {
    person: "ann lee",
    name: "Ann Lee",
    avatarEmail: "ann@corp",
    emails: [
      { email: "ann@x", name: "Ann Lee", branches: 1 },
      { email: "ann@corp", name: "ann lee", branches: 1 },
    ],
    branches: 2,
    isMe: false,
  };
  expect(probe.vis.contributors).toEqual([bob, ann]);
  const step = async (action: () => void, hidden: string[]) => {
    await act(async () => action());
    await settle();
    expect(probe.vis.hidden).toEqual(hidden);
  };
  const main = "refs/heads/main";
  await step(() => probe.vis.toggleContributor(ann), ["person:ann lee"]);
  expect(probe.vis.contributorVisibility(ann)).toBe("hidden");
  expect(probe.vis.isFiltered(main)).toBe(true);
  expect(probe.vis.isHidden(main)).toBe(true);
  // A branch someone else works on too stays visible.
  expect(probe.vis.isHidden("refs/remotes/origin/main")).toBe(false);
  expect(probe.vis.anyHidden).toBe(true);
  expect(probe.vis.ownersOf(main)).toEqual([ann]);
  // The eye of a filtered branch does nothing; showing its owners brings it back.
  await step(() => probe.vis.toggle(main), ["person:ann lee"]);
  await step(() => probe.vis.toggleGroup([main]), ["person:ann lee"]);
  await step(() => probe.vis.showOwners(main), []);
  // Its own eye is remembered while the filter hides it.
  await step(() => probe.vis.toggle(main), [main]);
  await step(() => probe.vis.toggleContributor(ann), [main, "person:ann lee"]);
  expect(probe.vis.isHiddenByEye(main)).toBe(true);
  await step(() => probe.vis.toggleContributor(ann), [main]);
  await step(() => probe.vis.toggle(main), []);
  // Showing one email splits the contributor.
  await step(() => probe.vis.toggleContributor(ann), ["person:ann lee"]);
  await step(() => probe.vis.toggleEmail(ann, "ann@x"), ["author:ann@corp"]);
  expect(probe.vis.contributorVisibility(ann)).toBe("partial");
  await step(() => probe.vis.toggleEmail(ann, "ann@x"), ["author:ann@corp", "author:ann@x"]);
  expect(probe.vis.contributorVisibility(ann)).toBe("hidden");
  await step(() => probe.vis.toggleContributor(ann), []);
  await step(() => probe.vis.soloContributors(["bob"]), ["person:ann lee"]);
  await step(() => probe.vis.showAllContributors(), []);
});

it("keeps the own state of filtered branches when a group changes", async () => {
  await render();
  const [main, originMain] = ["refs/heads/main", "refs/remotes/origin/main"];
  const group = [main, originMain];
  const ann = probe.vis.contributors.find((c) => c.person === "ann lee")!;
  const step = async (action: () => void, hidden: string[]) => {
    await act(async () => action());
    await settle();
    expect(probe.vis.hidden).toEqual(hidden);
  };
  // With main filtered, the group changes only origin/main, so not by prefix.
  await step(() => probe.vis.toggleContributor(ann), ["person:ann lee"]);
  await step(() => probe.vis.toggleGroup(group, "refs/"), ["person:ann lee", originMain]);
  await step(() => probe.vis.toggleGroup(group, "refs/"), ["person:ann lee"]);
  await step(() => probe.vis.toggleContributor(ann), []);
  expect(probe.vis.isHidden(main)).toBe(false);
  // Showing a group by prefix keeps a filtered member hidden by its own eye.
  await step(() => probe.vis.hideGroup(group, "refs/"), ["refs/"]);
  await step(() => probe.vis.toggleContributor(ann), ["refs/", "person:ann lee"]);
  await step(() => probe.vis.showGroup(group, "refs/"), [main, "person:ann lee"]);
});
