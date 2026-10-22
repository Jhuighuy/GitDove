// @vitest-environment happy-dom
import type { OperationInfo, RepoInfo, WorkingStatus } from "@shared/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useBusyStore } from "@/stores/busy";
import { OperationBar } from "./OperationBar";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  status: null as unknown,
  info: null as unknown,
  commands: { abort: vi.fn(), continue: vi.fn(), skip: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ ApiError: class extends Error {}, api: mocks.api }));
vi.mock("../commands", () => ({ commands: mocks.commands }));

const repo = "local:/repo";
const conflicted = (n: number): WorkingStatus => ({
  staged: [],
  unstaged: [],
  conflicted: Array.from({ length: n }, (_, i) => ({
    path: `f${i}`,
    oldPath: null,
    kind: "conflicted" as const,
    additions: null,
    deletions: null,
    binary: false,
  })),
  truncated: false,
});
const operation = (extra: Partial<OperationInfo> = {}): OperationInfo => ({
  branch: "main",
  onto: "0123456789abcdef",
  commit: "fedcba9876543210",
  subject: "Fix the thing",
  step: 2,
  total: 5,
  remaining: 3,
  editing: false,
  ...extra,
});
const info = (state: RepoInfo["state"], op: OperationInfo | null): Partial<RepoInfo> => ({
  head: { branch: null, hash: "h", detached: true },
  state,
  operation: op,
});

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.api.mockImplementation(async (method: string) =>
    method === "repo.status" ? mocks.status : mocks.info,
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(state: Partial<RepoInfo>, status = conflicted(0)) {
  mocks.info = state;
  mocks.status = status;
  await act(async () => root.unmount());
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <OperationBar repo={repo} />
      </QueryClientProvider>,
    ),
  );
  await act(async () => new Promise((r) => setTimeout(r, 0)));
}

const text = () => container.textContent ?? "";
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === label) ?? null;
const click = (label: string) => act(async () => button(label)!.click());

it("shows nothing while no operation is in progress", async () => {
  await render(info("clean", null));
  expect(container.innerHTML).toBe("");
});

it("asks to resolve conflicts before continuing a rebase", async () => {
  await render(info("rebasing", operation()), conflicted(2));
  expect(text()).toContain("Rebasing main onto 0123456");
  expect(text()).toContain("2 of 5");
  expect(text()).toContain("fedcba9");
  expect(text()).toContain("Fix the thing");
  expect(text()).toContain("Conflicts in 2 files");
  expect(button("Continue")!.disabled).toBe(true);
  await click("Abort");
  await click("Skip");
  expect(mocks.commands.abort).toHaveBeenCalledWith(repo);
  expect(mocks.commands.skip).toHaveBeenCalledWith(repo);

  await render(info("rebasing", operation()));
  expect(button("Continue")!.disabled).toBe(false);
  await click("Continue");
  expect(mocks.commands.continue).toHaveBeenCalledWith(repo);
});

it("explains an edit stop", async () => {
  await render(info("rebasing", operation({ editing: true })));
  expect(text()).toContain("Stopped to edit this commit");
});

it("commits a merge instead of skipping", async () => {
  await render(info("merging", operation({ step: null, total: null, remaining: 0 })));
  expect(text()).toContain("Merging into HEAD");
  expect(button("Skip")).toBeNull();
  expect(button("Commit Merge")).not.toBeNull();
});

it("counts what is left of a cherry-pick sequence", async () => {
  await render(info("cherry-picking", operation({ step: null, total: null, remaining: 2 })));
  expect(text()).toContain("Cherry-picking");
  expect(text()).toContain("2 more after this");
});

it("stops a bisect", async () => {
  await render(info("bisecting", null));
  await click("Stop Bisecting");
  expect(mocks.commands.abort).toHaveBeenCalledWith(repo);
});

it("waits for a running operation", async () => {
  await render(info("rebasing", operation()));
  await act(async () =>
    useBusyStore.getState().start(repo, { label: "Continuing…", cancellable: false }),
  );
  for (const label of ["Abort", "Skip", "Continue"]) expect(button(label)!.disabled).toBe(true);
  await act(async () => useBusyStore.getState().finish(repo));
});
