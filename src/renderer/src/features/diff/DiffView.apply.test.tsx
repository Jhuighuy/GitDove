// @vitest-environment happy-dom
// Staging through the app's own query client: `runAction` and `refreshRepo` always use it, so
// this is where their refresh after an action meets the diff on screen.
import type { DiffLine, DiffTarget, FileDiff } from "@shared/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "@/lib/queries";
import { useLayout } from "@/stores/repo-ui";
import { DiffView } from "./DiffView";

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  /** Resolves the pending `repo.diff` refetch, once one is held. */
  release: null as (() => void) | null,
  hold: false,
}));

vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  api: async (method: string, _repo: string, ...args: unknown[]) => {
    mocks.calls.push(method);
    if (method === "repo.applyPatch") return undefined;
    if (method === "repo.status") {
      return { staged: [], unstaged: [], conflicted: [], truncated: false };
    }
    if (method === "repo.diff") {
      if (mocks.hold) await new Promise<void>((r) => (mocks.release = r));
      return diff((args[0] as DiffTarget).path);
    }
    throw new Error(`unexpected ${method}`);
  },
}));
vi.mock("./highlight", () => ({ useHighlighter: () => null, tokenStyle: () => undefined }));

const ctx = (oldNo: number, newNo: number, text: string): DiffLine => ({
  kind: "context",
  oldNo,
  newNo,
  text,
});

const diff = (path: string): FileDiff => ({
  path,
  oldPath: null,
  binary: false,
  truncated: false,
  hunks: [
    {
      header: "@@ -1,2 +1,2 @@",
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      lines: [
        ctx(1, 1, "a"),
        { kind: "del", oldNo: 2, newNo: null, text: "b" },
        { kind: "add", oldNo: null, newNo: 2, text: "c" },
      ],
    },
  ],
});

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.calls = [];
  mocks.hold = false;
  mocks.release = null;
  queryClient.clear();
  useLayout.setState({ diffMode: "unified", diffViews: {} });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  queryClient.clear();
  vi.restoreAllMocks();
});

const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
};

const stageHunk = () =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === "Stage Hunk");

it("fetches the open diff once after staging a hunk, and waits for it", async () => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <DiffView repo="local:/repo" target={{ kind: "unstaged", path: "a.ts" }} />
      </QueryClientProvider>,
    ),
  );
  await settle();
  expect(stageHunk()?.disabled).toBe(false);
  mocks.calls = [];
  mocks.hold = true;
  await act(async () => stageHunk()!.click());
  await settle();
  // The refresh after the action is still running: the hunk stays out of reach.
  expect(stageHunk()?.disabled).toBe(true);
  mocks.hold = false;
  await act(async () => mocks.release?.());
  await settle();
  expect(mocks.calls).toEqual(["repo.applyPatch", "repo.status", "repo.diff"]);
  expect(stageHunk()?.disabled).toBe(false);
});
