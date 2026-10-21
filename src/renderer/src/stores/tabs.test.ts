import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: mocks.api }));

const { useTabs } = await import("./tabs");

const A = "local:/a";
const B = "ssh://host/b";
const C = "local:/c";

const s = () => useTabs.getState();
const repos = () => s().tabs.map((t) => t.repo);
const activeRepo = () => s().tabs.find((t) => t.key === s().active)?.repo;
const lastSaved = () => {
  const calls = mocks.api.mock.calls.filter(([m]) => m === "app.setState");
  return calls.at(-1)?.[1];
};

const load = async (tabs: string[], activeTab: string | null = null, recent: string[] = []) => {
  mocks.api.mockImplementation(async (method: string) =>
    method === "app.getState" ? { tabs, activeTab, recent } : undefined,
  );
  await s().load();
  mocks.api.mockClear();
};

beforeEach(() => {
  mocks.api.mockReset();
  mocks.api.mockResolvedValue(undefined);
  useTabs.setState({ tabs: [], active: null, recent: [], loaded: false });
});

it("loads saved tabs and the active one", async () => {
  await load([A, B], B, [B, A]);
  expect(s().loaded).toBe(true);
  expect(repos()).toEqual([A, B]);
  expect(activeRepo()).toBe(B);
  expect(s().recent).toEqual([B, A]);
  expect(new Set(s().tabs.map((t) => t.key)).size).toBe(2);
});

it("loads a blank tab when nothing was open, and activates the first tab by default", async () => {
  await load([]);
  expect(repos()).toEqual([null]);
  expect(s().active).toBe(s().tabs[0]!.key);
  await load([A, B], C);
  expect(activeRepo()).toBe(A);
});

it("opens a repository in the active blank tab and persists the state", async () => {
  await load([]);
  const blank = s().active;
  s().openRepo(A);
  expect(s().tabs).toEqual([{ key: blank, repo: A }]);
  expect(s().recent).toEqual([A]);
  expect(lastSaved()).toEqual({ tabs: [A], activeTab: A, recent: [A] });
});

it("opens a repository in a new tab when the active tab has one", async () => {
  await load([A], A);
  s().openRepo(B);
  expect(repos()).toEqual([A, B]);
  expect(activeRepo()).toBe(B);
  expect(lastSaved()).toEqual({ tabs: [A, B], activeTab: B, recent: [B] });
});

it("opens a repository in a given tab", async () => {
  await load([A, C], A);
  s().openRepo(B, s().tabs[1]!.key);
  expect(repos()).toEqual([A, B]);
  expect(activeRepo()).toBe(B);
});

it("focuses an already open repository, dropping the blank tab it was opened from", async () => {
  await load([A, B], B);
  s().newTab();
  const blank = s().active!;
  expect(repos()).toEqual([A, B, null]);
  s().openRepo(A, blank);
  expect(repos()).toEqual([A, B]);
  expect(activeRepo()).toBe(A);
  // Without a tab, nothing is dropped.
  s().newTab();
  s().openRepo(B);
  expect(repos()).toEqual([A, B, null]);
  expect(activeRepo()).toBe(B);
});

it("keeps the 30 most recent repositories, newest first, without duplicates", async () => {
  await load([], null, [B, A]);
  s().openRepo(A);
  expect(s().recent).toEqual([A, B]);
  for (let i = 0; i < 40; i++) s().openRepo(`local:/r${i}`);
  expect(s().recent).toHaveLength(30);
  expect(s().recent[0]).toBe("local:/r39");
  s().removeRecent("local:/r39");
  expect(s().recent[0]).toBe("local:/r38");
  expect(lastSaved()?.recent[0]).toBe("local:/r38");
});

it("reuses an existing blank tab for a new tab", async () => {
  await load([A]);
  s().newTab();
  const blank = s().active;
  s().activate(s().tabs[0]!.key);
  s().newTab();
  expect(s().tabs).toHaveLength(2);
  expect(s().active).toBe(blank);
});

it("closes tabs, activating the neighbour and closing the repository", async () => {
  await load([A, B, C], B);
  const [a, b, c] = s().tabs.map((t) => t.key);
  s().closeTab(b!);
  expect(repos()).toEqual([A, C]);
  expect(s().active).toBe(c);
  expect(mocks.api).toHaveBeenCalledWith("repo.close", B);
  // Closing an inactive tab keeps the active one.
  s().closeTab(a!);
  expect(s().active).toBe(c);
  // Closing the last tab leaves a blank one.
  s().closeTab(c!);
  expect(repos()).toEqual([null]);
  expect(s().active).toBe(s().tabs[0]!.key);
  // Closing the last, rightmost tab activates the one before it.
  await load([A, B], B);
  s().closeTab(s().tabs[1]!.key);
  expect(activeRepo()).toBe(A);
  // Unknown tabs are ignored.
  mocks.api.mockClear();
  s().closeTab("nope");
  expect(mocks.api).not.toHaveBeenCalled();
});

it("does not close a repository that is still open in another tab", async () => {
  await load([A]);
  useTabs.setState({ tabs: [...s().tabs, { key: "dup", repo: A }] });
  s().closeTab("dup");
  expect(mocks.api).not.toHaveBeenCalledWith("repo.close", A);
  // Closing a blank tab closes nothing either.
  s().newTab();
  mocks.api.mockClear();
  s().closeTab(s().active!);
  expect(mocks.api.mock.calls.map(([m]) => m)).toEqual(["app.setState"]);
});

it("tolerates failures to save state or close repositories", async () => {
  mocks.api.mockRejectedValue(new Error("gone"));
  useTabs.setState({ tabs: [{ key: "t", repo: A }], active: "t" });
  s().closeTab("t");
  s().openRepo(B);
  await new Promise((r) => setTimeout(r, 0));
  expect(repos()).toEqual([B]);
});

it("activates and cycles through tabs", async () => {
  await load([A, B, C], A);
  const keys = s().tabs.map((t) => t.key);
  s().activate(keys[1]!);
  expect(s().active).toBe(keys[1]);
  mocks.api.mockClear();
  s().activate(keys[1]!);
  expect(mocks.api).not.toHaveBeenCalled();
  s().cycle(1);
  expect(s().active).toBe(keys[2]);
  s().cycle(1);
  expect(s().active).toBe(keys[0]);
  s().cycle(-1);
  expect(s().active).toBe(keys[2]);
  // A single tab does not cycle.
  await load([A]);
  const only = s().active;
  s().cycle(1);
  expect(s().active).toBe(only);
});
