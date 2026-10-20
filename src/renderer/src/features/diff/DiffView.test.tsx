// @vitest-environment happy-dom
import type { DiffTarget, FileDiff } from "@shared/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useLayout, useRepoUiStore } from "@/stores/repo-ui";
import { DiffView } from "./DiffView";

const mocks = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  api: async (method: string, _repo: string, target: DiffTarget): Promise<FileDiff> => {
    mocks.calls.push(`${method} ${target.path}`);
    const hunks = target.path.endsWith(".svg")
      ? [
          {
            header: "@@ -1 +1 @@",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [
              { kind: "del" as const, oldNo: 1, newNo: null, text: "<svg/>" },
              { kind: "add" as const, oldNo: null, newNo: 1, text: "<svg></svg>" },
            ],
          },
        ]
      : [];
    return { path: target.path, oldPath: null, binary: false, hunks, truncated: false };
  },
}));
vi.mock("./highlight", () => ({ useHighlighter: () => null, tokenStyle: () => undefined }));
vi.mock("./ImageDiff", () => ({
  ImageDiff: ({ mime, mode }: { mime: string; mode: string }) => (
    <div data-testid="image">
      {mime} {mode}
    </div>
  ),
}));

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.calls = [];
  useLayout.setState({ diffMode: "unified", diffViews: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

/** Gives the virtualized list a viewport, so that lines render. */
const withViewport = () => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
};

async function render(path: string, target: DiffTarget = { kind: "unstaged", path }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <DiffView repo="local:/repo" target={target} />
      </QueryClientProvider>,
    ),
  );
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  await act(async () => new Promise((r) => setTimeout(r, 0)));
}

const button = (name: string) =>
  container.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`);
const click = (name: string) => act(() => button(name)!.click());

it("shows text files as a diff without a view toggle", async () => {
  await render("a.ts");
  expect(button("Image")).toBeNull();
  expect(button("Unified view")).not.toBeNull();
  expect(container.textContent).toContain("No changes.");
  expect(mocks.calls).toEqual(["repo.diff a.ts"]);
});

it("shows raster images rendered, without fetching a text diff", async () => {
  await render("a.png");
  expect(container.querySelector("[data-testid=image]")?.textContent).toBe("image/png unified");
  expect(button("Text diff")).toBeNull();
  // The layout toggle switches between swipe and side by side.
  await click("Side by side");
  expect(container.querySelector("[data-testid=image]")?.textContent).toBe("image/png split");
  expect(mocks.calls).toEqual([]);
});

it("switches SVGs between text and image, and remembers the choice", async () => {
  await render("a.svg");
  expect(button("Text diff")?.getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector("[data-testid=image]")).toBeNull();
  await click("Image");
  expect(container.querySelector("[data-testid=image]")?.textContent).toBe("image/svg+xml unified");
  expect(useLayout.getState().diffViews).toEqual({ svg: "image" });
  await render("b.svg");
  expect(button("Image")?.getAttribute("aria-pressed")).toBe("true");
});

it("drops a line selection when switching to the image view", async () => {
  withViewport();
  await render("a.svg");
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  const line = container.querySelector<HTMLElement>("[data-line]");
  await act(async () => line!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  expect(container.textContent).toContain("1 line selected");
  await click("Image");
  expect(container.textContent).not.toContain("selected");
  await click("Text diff");
  expect(container.textContent).not.toContain("selected");
});

it("offers hunk actions, except across a rename", async () => {
  withViewport();
  await render("a.svg", { kind: "staged", path: "a.svg" });
  expect(container.textContent).toContain("Unstage Hunk");
  await render("a.svg", { kind: "staged", path: "a.svg", oldPath: "old.svg" });
  expect(container.textContent).toContain("@@ -1 +1 @@");
  expect(container.textContent).not.toContain("Unstage Hunk");
});

it("closes on Escape, also from the swipe slider but not from text fields", async () => {
  useRepoUiStore.getState().openDiff("local:/repo", { kind: "unstaged", path: "a.png" });
  await render("a.png");
  const press = (target: HTMLElement) =>
    act(() => target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  const diff = () => useRepoUiStore.getState().byRepo["local:/repo"]?.diff ?? null;

  const text = document.createElement("input");
  container.append(text);
  press(text);
  expect(diff()).not.toBeNull();

  const slider = document.createElement("input");
  slider.type = "range";
  container.append(slider);
  press(slider);
  expect(diff()).toBeNull();
});
