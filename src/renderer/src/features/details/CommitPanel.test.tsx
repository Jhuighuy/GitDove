// @vitest-environment happy-dom
import type { CommitDetails, FileChange, RefsSnapshot } from "@shared/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRepoUiStore } from "@/stores/repo-ui";
import { CommitPanel } from "./CommitPanel";

const mocks = vi.hoisted(() => ({
  commit: null as unknown,
  refs: null as unknown,
  copy: vi.fn(),
  selectCommit: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  useEvent: () => {},
  api: async (method: string) => {
    if (method === "repo.refs") return mocks.refs;
    if (method === "repo.commitDetails") {
      const c = mocks.commit;
      if (c instanceof Error) throw c;
      return typeof c === "function" ? c() : c;
    }
    throw new Error(`unexpected ${method}`);
  },
}));
vi.mock("../commands", () => ({
  commands: { copy: mocks.copy, selectCommit: mocks.selectCommit },
}));

const repo = "local:/repo";
const HASH = "0123456789abcdef0123456789abcdef01234567";

const file = (path: string, extra: Partial<FileChange> = {}): FileChange => ({
  path,
  oldPath: null,
  kind: "modified",
  additions: 1,
  deletions: 2,
  binary: false,
  ...extra,
});

const details = (extra: Partial<CommitDetails> = {}): CommitDetails => ({
  hash: HASH,
  parents: ["aaaaaaa1111111"],
  author: { name: "Ada Lovelace", email: "ada@example.com", time: 1_700_000_000 },
  committer: { name: "Ada Lovelace", email: "ada@example.com", time: 1_700_000_000 },
  subject: "Add the engine",
  body: "It computes\nBernoulli numbers.",
  files: [
    file("src/engine.ts", { additions: 10, deletions: 3 }),
    file("docs/new.md", { kind: "renamed", oldPath: "docs/old.md", additions: null }),
  ],
  ...extra,
});

const snapshot = (stashes: RefsSnapshot["stashes"] = []): RefsSnapshot => ({
  refs: [],
  stashes,
  remotes: [],
  worktrees: [],
  submodules: [],
});

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.commit = details();
  mocks.refs = snapshot();
  useRepoUiStore.setState({ byRepo: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(hash = HASH) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CommitPanel repo={repo} hash={hash} />
      </QueryClientProvider>,
    ),
  );
  await act(async () => new Promise((r) => setTimeout(r, 0)));
}

const text = () => container.textContent ?? "";
const buttonByText = (t: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === t)!;

it("shows a spinner while loading", async () => {
  mocks.commit = () => new Promise(() => {});
  await render();
  expect(text()).toContain("Loading commit…");
});

it("shows errors and missing commits", async () => {
  mocks.commit = new Error("bad object");
  await render();
  expect(text()).toBe("bad object");
  mocks.commit = null;
  await render("ffff");
  expect(text()).toBe("Commit not found");
});

it("shows the commit message, author and file stats", async () => {
  await render();
  expect(text()).toContain("commit:");
  expect(container.querySelector("h2")?.textContent).toBe("Add the engine");
  expect(container.querySelector("pre")?.textContent).toBe("It computes\nBernoulli numbers.");
  expect(text()).toContain("Ada Lovelace");
  expect(text()).toContain("authored ");
  expect(text()).not.toContain("committed by");
  expect(text()).toContain("2 files changed");
  expect(text()).toContain("+10 -5");
  expect(text()).toContain("parent:");
  expect([...container.querySelectorAll("li")].map((l) => l.title)).toEqual([
    "src/engine.ts",
    "docs/old.md → docs/new.md",
  ]);
});

it("shows a separate committer, merge parents and singular counts", async () => {
  mocks.commit = details({
    body: "",
    parents: ["aaaaaaa1111111", "bbbbbbb2222222"],
    committer: { name: "Bot", email: "bot@example.com", time: 1_700_000_000 },
    files: [file("x")],
  });
  await render();
  expect(container.querySelector("pre")).toBeNull();
  expect(text()).toContain("committed by Bot");
  expect(text()).toContain("parents:");
  expect(text()).toContain("1 file changed");
  await act(async () => buttonByText("bbbbbbb").click());
  expect(mocks.selectCommit).toHaveBeenCalledWith(repo, "bbbbbbb2222222");
});

it("hides parents of root commits", async () => {
  mocks.commit = details({ parents: [] });
  await render();
  expect(text()).not.toContain("parent");
});

it("names stashes and copies the hash", async () => {
  mocks.refs = snapshot([{ index: 0, name: "stash@{0}", hash: HASH, message: "wip", time: 0 }]);
  await render();
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  expect(text()).toContain("stash@{0}");
  expect(text()).not.toContain("commit:");
  await act(async () => container.querySelector<HTMLElement>('[title="Copy SHA"]')!.click());
  expect(mocks.copy).toHaveBeenCalledWith(HASH, "Commit SHA copied");
  expect(container.querySelector('[title="Copy SHA"]')?.textContent).toBe("0123456");
});

it("opens file diffs and highlights the open one", async () => {
  await render();
  const rows = () => [...container.querySelectorAll("li")];
  await act(async () => rows()[1]!.click());
  expect(useRepoUiStore.getState().byRepo[repo]?.diff).toEqual({
    kind: "commit",
    hash: HASH,
    path: "docs/new.md",
    oldPath: "docs/old.md",
  });
  expect(rows().map((r) => r.className.includes("bg-primary/25"))).toEqual([false, true]);
  await act(async () => rows()[0]!.click());
  expect(useRepoUiStore.getState().byRepo[repo]?.diff).toEqual({
    kind: "commit",
    hash: HASH,
    path: "src/engine.ts",
  });
  // A diff of another commit is not highlighted here.
  await act(async () =>
    useRepoUiStore.getState().openDiff(repo, { kind: "commit", hash: "other", path: "x" }),
  );
  expect(rows().some((r) => r.className.includes("bg-primary/25"))).toBe(false);
});
