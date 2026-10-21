// @vitest-environment happy-dom
import { buildPatch, hunkPatch } from "@shared/diff/patch";
import type { DiffLine, DiffTarget, FileDiff } from "@shared/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useLayout, useRepoUiStore } from "@/stores/repo-ui";
import { DiffView } from "./DiffView";

const mocks = vi.hoisted(() => ({
  patches: [] as unknown[][],
  ensured: [] as unknown[][],
  diffs: new Map<string, FileDiff | Error>(),
  highlight: true,
}));

vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  api: async (method: string, _repo: string, ...args: unknown[]) => {
    if (method === "repo.applyPatch") {
      mocks.patches.push(args);
      return undefined;
    }
    if (method === "repo.diff") {
      const d = mocks.diffs.get((args[0] as DiffTarget).path);
      if (d instanceof Error) throw d;
      return d;
    }
    throw new Error(`unexpected ${method}`);
  },
}));
// A highlighter that marks the first four characters of every line as one token.
vi.mock("./highlight", () => ({
  useHighlighter: () =>
    mocks.highlight
      ? {
          ensure: (...args: unknown[]) => void mocks.ensured.push(args),
          tokens: (_theme: string, _side: number, index: number) =>
            index < 0 ? null : Uint32Array.from([4, 1]),
        }
      : null,
  tokenStyle: (i: number) => ({ color: `rgb(${i}, 0, 0)` }),
}));

const ctx = (oldNo: number, newNo: number, text: string): DiffLine => ({
  kind: "context",
  oldNo,
  newNo,
  text,
});
const del = (oldNo: number, text: string): DiffLine => ({ kind: "del", oldNo, newNo: null, text });
const add = (newNo: number, text: string): DiffLine => ({ kind: "add", oldNo: null, newNo, text });

const diff = (path: string, extra: Partial<FileDiff> = {}): FileDiff => ({
  path,
  oldPath: null,
  binary: false,
  truncated: false,
  hunks: [
    {
      header: "@@ -1,4 +1,3 @@",
      oldStart: 1,
      oldLines: 4,
      newStart: 1,
      newLines: 3,
      // Line ids 0-4.
      lines: [
        ctx(1, 1, "keep"),
        del(2, "const a = 1;"),
        del(3, "old b"),
        add(2, "const a = 2;"),
        ctx(4, 3, "tail"),
      ],
    },
    {
      header: "@@ -10 +9 @@",
      oldStart: 10,
      oldLines: 1,
      newStart: 9,
      newLines: 1,
      // Line ids 5-6.
      lines: [del(10, "x"), add(9, "y")],
    },
  ],
  ...extra,
});

let root: Root;
let container: HTMLElement;
const REPO = "local:/repo";

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.patches = [];
  mocks.ensured = [];
  mocks.highlight = true;
  mocks.diffs = new Map([["src/a.ts", diff("src/a.ts")]]);
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
  vi.restoreAllMocks();
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

async function render(target: DiffTarget = { kind: "unstaged", path: "src/a.ts" }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <DiffView repo={REPO} target={target} />
      </QueryClientProvider>,
    ),
  );
  await settle();
  await settle();
  await settle();
}

const line = (id: number) => container.querySelector<HTMLElement>(`[data-line="${id}"]`)!;
/** Presses on a line's numbers, which select lines. */
const mouse = (id: number, type: string, init: MouseEventInit = {}) =>
  act(async () => {
    const gutter = line(id).querySelector("[data-gutter]")!;
    gutter.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, ...init }));
  });
const textOf = (id: number) => line(id).querySelector<HTMLElement>("[data-text]")!;
const buttonByText = (label: string) => {
  const el = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!el) throw new Error(`No "${label}" button`);
  return el;
};
const status = () => container.textContent?.match(/\d+ lines? selected/)?.[0] ?? null;
const selectedIds = () =>
  [...container.querySelectorAll<HTMLElement>("[data-line]")]
    .filter((el) => el.className.includes("bg-sky-500/25"))
    .map((el) => Number(el.dataset.line));

it("shows the path, the target and lines with syntax and word highlighting", async () => {
  await render({ kind: "commit", hash: "0123456789abcdef", path: "src/a.ts" });
  expect(container.textContent).toContain("src/a.ts");
  expect(container.textContent).toContain("0123456");
  // Line numbers, sign and text.
  expect(line(1).textContent).toBe("2-const a = 1;");
  expect(line(3).textContent).toBe("2+const a = 2;");
  // Syntax tokens are styled...
  const first = line(0).querySelector<HTMLElement>("span[style]:not([class*=text-right])");
  expect(first?.textContent).toBe("keep");
  expect(first?.style.color).toBe("rgb(1, 0, 0)");
  // ...and the changed word of a replaced line is emphasized on both sides.
  expect(line(1).querySelector(".bg-red-500\\/30")?.textContent).toBe("1");
  expect(line(3).querySelector(".bg-emerald-500\\/30")?.textContent).toBe("2");
  // A deletion without a counterpart has no emphasis.
  expect(line(2).querySelector("[class*=500\\/30]")).toBeNull();
  // Visible lines of both sides are requested from the highlighter.
  expect(mocks.ensured).toContainEqual(["dark", 0, 1, 4]);
  expect(mocks.ensured).toContainEqual(["dark", 1, 0, 3]);
  // Commits have no hunk actions.
  expect(container.textContent).not.toContain("Hunk");
});

it("stages and discards hunks of unstaged changes", async () => {
  await render();
  const data = mocks.diffs.get("src/a.ts") as FileDiff;
  const [, stageSecond] = [...container.querySelectorAll("button")].filter(
    (b) => b.textContent === "Stage Hunk",
  );
  await act(async () => stageSecond!.click());
  const [discardFirst] = [...container.querySelectorAll("button")].filter(
    (b) => b.textContent === "Discard Hunk",
  );
  await act(async () => discardFirst!.click());
  await settle();
  expect(mocks.patches).toEqual([
    [hunkPatch(data, 1, false), { cached: true, reverse: false }],
    [hunkPatch(data, 0, true), { cached: false, reverse: true }],
  ]);
});

it("offers no actions on untracked files", async () => {
  await render({ kind: "unstaged", path: "src/a.ts", untracked: true });
  expect(container.textContent).not.toContain("Hunk");
  await mouse(1, "mousedown");
  expect(status()).toBeNull();
});

it("selects lines by clicking, Cmd-clicking and Shift-clicking", async () => {
  await render();
  await mouse(1, "mousedown");
  expect(status()).toBe("1 line selected");
  expect(selectedIds()).toEqual([1]);
  // Clicking the only selected line again deselects it.
  await mouse(1, "mousedown");
  expect(status()).toBeNull();

  await mouse(1, "mousedown");
  await mouse(6, "mousedown", { metaKey: true });
  expect(selectedIds()).toEqual([1, 6]);
  await mouse(1, "mousedown", { ctrlKey: true });
  expect(selectedIds()).toEqual([6]);
  // Shift selects from the last anchor, over changed lines only.
  await mouse(6, "mousedown", { shiftKey: true });
  expect(selectedIds()).toEqual([1, 2, 3, 5, 6]);
  expect(status()).toBe("5 lines selected");

  // Clicking a context line clears the selection; other buttons do nothing.
  await mouse(0, "mousedown", { button: 2 });
  expect(selectedIds()).toHaveLength(5);
  await mouse(0, "mousedown");
  expect(selectedIds()).toEqual([]);
});

it("selects a range by dragging", async () => {
  await render();
  await mouse(1, "mousedown");
  await mouse(3, "mousemove", { buttons: 1 });
  expect(selectedIds()).toEqual([1, 2, 3]);
  // Moving back over the anchor keeps the range.
  await mouse(1, "mousemove", { buttons: 1 });
  expect(selectedIds()).toEqual([1, 2, 3]);
  await act(async () => window.dispatchEvent(new MouseEvent("mouseup")));
  await mouse(6, "mousemove", { buttons: 1 });
  expect(selectedIds()).toEqual([1, 2, 3]);
});

it("stages, discards and unstages selected lines", async () => {
  await render();
  const data = mocks.diffs.get("src/a.ts") as FileDiff;
  await mouse(1, "mousedown");
  await mouse(3, "mousedown", { metaKey: true });
  await act(async () => buttonByText("Stage Lines").click());
  await settle();
  const selected = new Set([1, 3]);
  expect(mocks.patches).toEqual([
    [
      buildPatch(data, (h, i) => selected.has([0, 5][h]! + i), false),
      { cached: true, reverse: false },
    ],
  ]);
  expect(status()).toBeNull();

  await mouse(6, "mousedown");
  await act(async () => buttonByText("Discard Lines").click());
  await settle();
  expect(mocks.patches[1]).toEqual([
    buildPatch(data, (h, i) => h === 1 && i === 1, true),
    { cached: false, reverse: true },
  ]);

  await render({ kind: "staged", path: "src/a.ts" });
  await mouse(5, "mousedown");
  await act(async () => buttonByText("Unstage Lines").click());
  await settle();
  expect(mocks.patches[2]).toEqual([
    buildPatch(data, (h, i) => h === 1 && i === 0, true),
    { cached: true, reverse: true },
  ]);
});

it("clears the selection on Escape before closing", async () => {
  useRepoUiStore.getState().openDiff(REPO, { kind: "unstaged", path: "src/a.ts" });
  await render();
  const diffOpen = () => useRepoUiStore.getState().byRepo[REPO]?.diff ?? null;
  const escape = () =>
    act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  await mouse(1, "mousedown");
  await escape();
  expect(status()).toBeNull();
  expect(diffOpen()).not.toBeNull();
  await escape();
  expect(diffOpen()).toBeNull();
});

it("shows lines side by side in split view, scrolling both columns together", async () => {
  await render();
  await act(async () => container.querySelector<HTMLElement>("[aria-label='Split view']")!.click());
  await settle();
  // The replaced line sits next to its replacement; the extra deletion has an empty cell.
  const pair = line(1).parentElement!;
  expect(pair.querySelector('[data-line="3"]')).not.toBeNull();
  expect(line(2).parentElement!.querySelector(".bg-muted\\/30")).not.toBeNull();
  expect(line(1).textContent).toBe("2-const a = 1;");
  expect(line(3).textContent).toBe("2+const a = 2;");

  // A drag stays within its column.
  await mouse(1, "mousedown");
  await mouse(5, "mousemove", { buttons: 1 });
  expect(selectedIds()).toEqual([1, 2, 5]);

  const bars = [...container.querySelectorAll<HTMLElement>(".overflow-x-auto")];
  expect(bars).toHaveLength(2);
  const scroller = container.querySelector<HTMLElement>(".overflow-y-auto.font-mono")!;
  await act(async () => {
    bars[1]!.scrollLeft = 30;
    bars[1]!.dispatchEvent(new Event("scroll"));
  });
  expect(bars[0]!.scrollLeft).toBe(30);
  expect(scroller.style.getPropertyValue("--sx")).toBe("30px");
  // Horizontal wheel moves the bars; vertical wheel does not.
  await act(async () => {
    scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaX: 20, deltaY: 1 }));
    scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaX: 1, deltaY: 50 }));
  });
  expect(bars[0]!.scrollLeft).toBe(50);
});

it("renders plain text without a highlighter", async () => {
  mocks.highlight = false;
  await render();
  expect(line(0).querySelector("span[style]:not([class*=text-right])")).toBeNull();
  expect(line(0).textContent).toBe("11 keep");
});

it("reports binary, truncated and failed diffs", async () => {
  mocks.diffs.set("bin.dat", diff("bin.dat", { binary: true, hunks: [] }));
  mocks.diffs.set("big.txt", diff("big.txt", { truncated: true }));
  mocks.diffs.set("bad.txt", new Error("diff failed"));
  await render({ kind: "unstaged", path: "bin.dat" });
  expect(container.textContent).toContain("Binary file — no textual diff.");
  await render({ kind: "unstaged", path: "big.txt" });
  expect(container.textContent).toContain("Diff truncated — file is too large.");
  await render({ kind: "unstaged", path: "bad.txt" });
  expect(container.querySelector(".text-destructive")?.textContent).toBe("diff failed");
});

it("selects a line on a click on its text, but not after selecting text", async () => {
  await render();
  const click = (id: number) =>
    act(async () => {
      const text = textOf(id);
      text.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      text.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    });
  await click(1);
  expect(selectedIds()).toEqual([1]);

  // A drag over the text selects text instead.
  vi.spyOn(window, "getSelection").mockReturnValue({ isCollapsed: false } as Selection);
  await click(3);
  expect(selectedIds()).toEqual([1]);
});

/** Selects text from `start` in one line's text to `end` in another's, and copies it. */
const copy = async (from: [number, number], to: [number, number]) => {
  const point = (id: number, offset: number): [Node, number] => {
    const walker = document.createTreeWalker(textOf(id), NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && offset > node.textContent!.length) {
      offset -= node.textContent!.length;
      node = walker.nextNode();
    }
    return [node!, offset];
  };
  const range = document.createRange();
  range.setStart(...point(...from));
  range.setEnd(...point(...to));
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  const setData = vi.fn();
  const event = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { setData } });
  await act(async () => textOf(from[0]).dispatchEvent(event));
  return setData.mock.calls.at(-1)?.[1] as string | undefined;
};

it("copies the selected text of the lines, without numbers and signs", async () => {
  await render();
  expect(await copy([1, 6], [3, 5])).toBe("a = 1;\nold b\nconst");
});

it("selects and copies text within one column in split view", async () => {
  await render();
  await act(async () => container.querySelector<HTMLElement>("[aria-label='Split view']")!.click());
  await settle();
  const scroller = container.querySelector<HTMLElement>(".overflow-y-auto.font-mono")!;
  // Pressing on the right column makes the left one unselectable, and copies from the right.
  await act(async () => {
    textOf(3).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  });
  expect(scroller.dataset.selectSide).toBe("1");
  expect(scroller.className).toContain("data-[select-side=1]:**:data-[side=0]:select-none");
  // Context lines sit in both columns; the right one has the replacement and no extra deletion.
  expect(await copy([3, 0], [4, 4])).toBe("const a = 2;\ntail");
});
