// @vitest-environment happy-dom
import type { RebaseCommit, RebaseTodo } from "@shared/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRepoUiStore } from "@/stores/repo-ui";
import { RebaseEditor } from "./RebaseEditor";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  api: mocks.api,
  isMac: true,
  modKey: "⌘",
  useEvent: () => {},
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));

const repo = "local:/repo";
const commit = (c: string, pushed = false): RebaseCommit => ({
  hash: c.repeat(40),
  subject: `Commit ${c}`,
  message: `Commit ${c}`,
  authorName: "A",
  authorEmail: "a@x",
  authorTime: 0,
  pushed,
});
const todo: RebaseTodo = {
  base: "0".repeat(40),
  baseSubject: "Base",
  commits: [commit("a", true), commit("b"), commit("c")],
  merges: 0,
};

let root: Root;
let container: HTMLElement;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.api.mockImplementation(async (method: string) => {
    if (method === "repo.rebaseTodo") return todo;
    if (method === "repo.info") return { head: { branch: "main", hash: "h", detached: false } };
    if (method === "repo.rewrite") return "done";
    return [];
  });
  useRepoUiStore.getState().openRebase(repo, { base: todo.base, selected: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <RebaseEditor repo={repo} base={todo.base} selected={[]} />
      </QueryClientProvider>,
    ),
  );
  await act(async () => new Promise((r) => setTimeout(r, 0)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const list = () => container.querySelector<HTMLElement>('[role="listbox"]')!;
const subjects = () =>
  [...container.querySelectorAll('[role="option"]')].map(
    (o) => o.textContent!.match(/Commit \w/)![0],
  );
const press = (key: string, extra: KeyboardEventInit = {}) =>
  act(async () =>
    list().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...extra })),
  );
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith(label))!;

it("lists the commits newest first, with the base below", () => {
  expect(subjects()).toEqual(["Commit c", "Commit b", "Commit a"]);
  expect(container.textContent).toContain("Base");
  expect(container.textContent).toContain("1 of these commit was pushed");
  expect(button("Start Rebase").disabled).toBe(true);
});

it("plans a rebase from the keyboard and starts it", async () => {
  // The cursor starts on the newest commit: fold c into b, and drop a.
  await press("f");
  await press("ArrowDown");
  await press("ArrowDown");
  await press("d");
  expect(container.textContent).toContain("1 melded · 1 dropped");
  await press("ArrowUp");
  await press("ArrowUp", { altKey: true });
  expect(subjects()).toEqual(["Commit b", "Commit c", "Commit a"]);
  // With b moved to the top, c would fold into a, which is dropped.
  expect(container.textContent).toContain("There is no older commit to fold this one into");
  expect(button("Start Rebase").disabled).toBe(true);
  await act(async () => button("Reset").click());
  expect(subjects()).toEqual(["Commit c", "Commit b", "Commit a"]);

  // Squash c into b, which takes both messages.
  await press("s");
  await press("Enter", { metaKey: true });
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  expect(mocks.api).toHaveBeenCalledWith("repo.rewrite", repo, {
    base: todo.base,
    steps: [
      { hash: "a".repeat(40), action: "pick" },
      { hash: "b".repeat(40), action: "pick", message: "Commit b\n\nCommit c" },
      { hash: "c".repeat(40), action: "fixup" },
    ],
    label: "Rebase 3 commits",
  });
  expect(useRepoUiStore.getState().byRepo[repo]?.rebase).toBeNull();
});
