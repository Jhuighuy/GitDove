// @vitest-environment happy-dom
import type { ChangeKind, FileChange } from "@shared/domain";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChangeBadge, type FileAction, FileList } from "./FileList";

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  // Gives the virtualized list a viewport, so that rows render.
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const file = (path: string, extra: Partial<FileChange> = {}): FileChange => ({
  path,
  oldPath: null,
  kind: "modified",
  additions: null,
  deletions: null,
  binary: false,
  ...extra,
});

const rows = () => [...container.querySelectorAll("[role=option]")] as HTMLElement[];
const list = () => container.querySelector("[role=listbox]") as HTMLElement;

type ListProps = Omit<React.ComponentProps<typeof FileList>, "scroller" | "label">;

/** A file list in its own scroll area. */
function Scrolled(props: ListProps) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setScroller} style={{ height: 400, overflow: "auto" }}>
      <FileList {...props} label="Files" scroller={scroller} />
    </div>
  );
}

const show = (props: ListProps) => act(async () => root.render(<Scrolled {...props} />));
const key = (k: string) =>
  act(async () => {
    list().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });

it("shows a badge per change kind", async () => {
  const kinds: [ChangeKind, string, string][] = [
    ["added", "A", "Added"],
    ["untracked", "U", "Untracked"],
    ["modified", "M", "Modified"],
    ["deleted", "D", "Deleted"],
    ["renamed", "R", "Renamed"],
    ["copied", "C", "Copied"],
    ["typechange", "T", "Type changed"],
    ["conflicted", "!", "Conflicted"],
  ];
  await act(async () =>
    root.render(
      <>
        {kinds.map(([kind]) => (
          <ChangeBadge key={kind} kind={kind} />
        ))}
      </>,
    ),
  );
  const badges = [...container.querySelectorAll("span")];
  expect(badges.map((b) => [b.textContent, b.title])).toEqual(kinds.map(([, l, t]) => [l, t]));
});

it("lists files with their folder, stats and rename source", async () => {
  await show({
    files: [
      file("src/lib/a.ts", { additions: 3, deletions: 1 }),
      file("README.md", { kind: "added", additions: 10, deletions: 0 }),
      file("new/b.ts", { kind: "renamed", oldPath: "old/b.ts" }),
    ],
    selectedPath: "README.md",
    onOpen: () => {},
  });
  const [a, readme, b] = rows();
  expect(a!.title).toBe("src/lib/a.ts");
  expect(a!.textContent).toBe("Ma.tssrc/lib+3 -1");
  // Zero counts are left out; without a folder only the name is shown.
  expect(readme!.textContent).toBe("AREADME.md+10 ");
  expect(b!.title).toBe("old/b.ts → new/b.ts");
  expect(b!.textContent).toBe("Rb.tsnew");
  // Only the selected file is highlighted, and it is the list's active option.
  expect(rows().map((r) => r.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
  expect(list().getAttribute("aria-activedescendant")).toBe(readme!.id);
});

it("renders only the rows on screen", async () => {
  const files = Array.from({ length: 5000 }, (_, i) => file(`f${i}.ts`));
  await show({ files, selectedPath: null, onOpen: () => {} });
  expect(rows().length).toBeGreaterThan(10);
  expect(rows().length).toBeLessThan(60);
  expect(list().style.height).toBe(`${5000 * 24}px`);
});

it("opens files when clicked, but not when clicking an action", async () => {
  const onOpen = vi.fn();
  const run = vi.fn();
  const files = [file("a.ts"), file("b.ts")];
  const actions: FileAction[] = [{ label: "Stage file", icon: "+", run }];
  await show({ files, selectedPath: null, onOpen, actions });
  await act(async () => rows()[1]!.click());
  expect(onOpen).toHaveBeenCalledWith(files[1]);
  await act(async () => rows()[0]!.querySelector("button")!.click());
  expect(run).toHaveBeenCalledWith(files[0]);
  expect(onOpen).toHaveBeenCalledTimes(1);
});

it("renders actions per file, disabled with a reason", async () => {
  const files = [file("a.ts"), file("b.ts")];
  const actions: FileAction[] = [{ label: "Stage file", icon: "+", keys: ["s"], run: () => {} }];
  await show({ files, selectedPath: null, onOpen: () => {}, actions });
  const buttons = () => [...container.querySelectorAll("button")];
  expect(buttons().map((b) => b.getAttribute("aria-label"))).toEqual(["Stage file", "Stage file"]);
  expect((buttons()[0]!.parentElement as HTMLElement).title).toBe("Stage file (S)");
  // Keyboard users reach actions through their keys, not the tab order.
  expect(buttons()[0]!.tabIndex).toBe(-1);

  await show({ files, selectedPath: null, onOpen: () => {}, actions, disabledReason: "Busy." });
  expect(buttons().every((b) => b.disabled)).toBe(true);
  expect((buttons()[0]!.parentElement as HTMLElement).title).toBe("Busy.");
});

it("moves the selection with the keyboard and runs actions with their keys", async () => {
  const onOpen = vi.fn();
  const run = vi.fn();
  const files = [file("a.ts"), file("b.ts"), file("c.ts")];
  const actions: FileAction[] = [{ label: "Stage file", icon: "+", keys: ["s"], run }];
  await show({ files, selectedPath: null, onOpen, actions });
  expect(list().tabIndex).toBe(0);
  // Without a selection, the first file opens; actions need a selected file.
  await key("s");
  expect(run).not.toHaveBeenCalled();
  await key("ArrowDown");
  expect(onOpen).toHaveBeenLastCalledWith(files[0]);

  await show({ files, selectedPath: "b.ts", onOpen, actions });
  await key("ArrowDown");
  expect(onOpen).toHaveBeenLastCalledWith(files[2]);
  await key("ArrowUp");
  expect(onOpen).toHaveBeenLastCalledWith(files[0]);
  await key("End");
  expect(onOpen).toHaveBeenLastCalledWith(files[2]);
  await key("Enter");
  expect(onOpen).toHaveBeenLastCalledWith(files[1]);
  await key("S");
  expect(run).toHaveBeenCalledWith(files[1]);

  // Disabled actions do nothing.
  run.mockClear();
  await show({ files, selectedPath: "b.ts", onOpen, actions, disabledReason: "Busy." });
  await key("s");
  expect(run).not.toHaveBeenCalled();
});

it("keeps line counts next to the actions", async () => {
  await show({
    files: [file("a.ts", { additions: 3, deletions: 1 })],
    selectedPath: null,
    onOpen: () => {},
    actions: [{ label: "Act", icon: "x", run: () => {} }],
  });
  const row = rows()[0]!;
  const stats = [...row.querySelectorAll("span")].find((s) => s.textContent === "+3 -1")!;
  expect(stats.className).not.toContain("hidden");
  // Actions come first, so the counts stay put at the row's end.
  expect(row.lastElementChild).toBe(stats);
});
