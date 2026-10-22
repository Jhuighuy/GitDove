// @vitest-environment happy-dom
import type { Comparison, GraphRow } from "@shared/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type PickedCommit, useRepoUiStore } from "@/stores/repo-ui";
import { CommitsPanel } from "./CommitsPanel";

const mocks = vi.hoisted(() => ({
  compared: [] as unknown[][],
  more: {} as Partial<Comparison>,
}));

vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  useEvent: () => {},
  api: async (method: string, ...args: unknown[]) => {
    if (method === "repo.refs")
      return { refs: [], stashes: [], remotes: [], worktrees: [], submodules: [] };
    if (method === "repo.compare") {
      mocks.compared.push(args.slice(1));
      const [, base, tip] = args as [string, string | null, string];
      return {
        base: base ?? "e".repeat(40),
        tip,
        files: [
          {
            path: "a.ts",
            oldPath: null,
            kind: "modified",
            additions: 3,
            deletions: 1,
            binary: false,
          },
          { path: "b.ts", oldPath: null, kind: "added", additions: 2, deletions: 0, binary: false },
        ],
        ...mocks.more,
      } satisfies Comparison;
    }
    throw new Error(`unexpected ${method}`);
  },
}));

const repo = "local:/repo";
const picked = (i: number, parents = [`p${i}`]): PickedCommit => ({
  index: i,
  row: {
    hash: `${i}`.repeat(40),
    parents,
    subject: `Commit ${i}`,
    authorName: "Ada",
    authorEmail: "ada@example.com",
    authorTime: 1_700_000_000,
    committerTime: 0,
    lane: 0,
    color: 0,
    edges: [],
    width: 1,
  } satisfies GraphRow,
});

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  // Gives the virtualized file lists a viewport, so that rows render.
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.compared = [];
  mocks.more = {};
  useRepoUiStore.setState({ byRepo: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function render(commits: PickedCommit[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CommitsPanel repo={repo} commits={commits} />
      </QueryClientProvider>,
    ),
  );
  await act(async () => new Promise((r) => setTimeout(r, 0)));
}

it("lists the commits and the changes from the oldest one's parent to the newest", async () => {
  await render([picked(1), picked(4)]);
  expect(container.textContent).toContain("2 commits selected");
  expect(container.textContent).toContain("Commit 1");
  expect(container.textContent).toContain("Commit 4");
  expect(mocks.compared).toEqual([["p4", "1".repeat(40)]]);
  expect(container.textContent).toContain("2 files changed");
  expect(container.textContent).toContain("+5 -1");

  // Files open as diffs over the range; a commit opens on its own.
  const file = [...container.querySelectorAll<HTMLElement>("[role=option]")].find((li) =>
    li.textContent?.includes("b.ts"),
  )!;
  await act(async () => file.click());
  expect(useRepoUiStore.getState().byRepo[repo]?.diff).toEqual({
    kind: "commit",
    hash: "1".repeat(40),
    base: "p4",
    path: "b.ts",
  });
  const commit = [...container.querySelectorAll<HTMLElement>("li button")].find((b) =>
    b.textContent?.includes("Commit 4"),
  )!;
  await act(async () => commit.click());
  expect(useRepoUiStore.getState().byRepo[repo]?.selection).toEqual({
    kind: "commit",
    hash: "4".repeat(40),
  });
});

it("says how many files a truncated comparison leaves out", async () => {
  mocks.more = { truncated: true, totalFiles: 10_002 };
  await render([picked(1), picked(4)]);
  expect(container.textContent).toContain("10,002 files changed");
  expect(container.textContent).toContain("…and 10,000 more files");
});

it("compares a root commit with the empty tree", async () => {
  await render([picked(1), picked(2, [])]);
  expect(mocks.compared).toEqual([[null, "1".repeat(40)]]);
});
