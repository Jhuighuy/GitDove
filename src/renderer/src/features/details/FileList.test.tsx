// @vitest-environment happy-dom
import type { ChangeKind, FileChange } from "@shared/domain";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChangeBadge, FileList } from "./FileList";

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
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

const rows = () => [...container.querySelectorAll("li")];

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
  await act(async () =>
    root.render(
      <FileList
        files={[
          file("src/lib/a.ts", { additions: 3, deletions: 1 }),
          file("README.md", { kind: "added", additions: 10, deletions: 0 }),
          file("new/b.ts", { kind: "renamed", oldPath: "old/b.ts" }),
        ]}
        selectedPath="README.md"
        onOpen={() => {}}
      />,
    ),
  );
  const [a, readme, b] = rows();
  expect(a!.title).toBe("src/lib/a.ts");
  expect(a!.textContent).toBe("Ma.tssrc/lib+3 -1");
  // Zero counts are left out; without a folder only the name is shown.
  expect(readme!.textContent).toBe("AREADME.md+10 ");
  expect(b!.title).toBe("old/b.ts → new/b.ts");
  expect(b!.textContent).toBe("Rb.tsnew");
  // Only the selected file is highlighted.
  expect(rows().map((r) => r.className.includes("bg-primary/25"))).toEqual([false, true, false]);
});

it("opens files and reports context menus", async () => {
  const onOpen = vi.fn();
  const onContextMenu = vi.fn();
  const files = [file("a.ts"), file("b.ts")];
  await act(async () =>
    root.render(
      <FileList files={files} selectedPath={null} onOpen={onOpen} onContextMenu={onContextMenu} />,
    ),
  );
  await act(async () => rows()[1]!.click());
  expect(onOpen).toHaveBeenCalledWith(files[1]);
  await act(async () => {
    rows()[0]!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  });
  expect(onContextMenu).toHaveBeenCalledWith(files[0]);
});

it("renders hover actions per file", async () => {
  const files = [file("a.ts"), file("b.ts")];
  await act(async () =>
    root.render(
      <FileList
        files={files}
        selectedPath={null}
        onOpen={() => {}}
        renderActions={(f) => <button type="button">act {f.path}</button>}
      />,
    ),
  );
  expect([...container.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
    "act a.ts",
    "act b.ts",
  ]);
  // Without a handler, a context menu does nothing.
  await act(async () => {
    rows()[0]!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  });
});

it("keeps line counts next to the hover actions", async () => {
  await act(async () =>
    root.render(
      <FileList
        files={[file("a.ts", { additions: 3, deletions: 1 })]}
        selectedPath={null}
        onOpen={() => {}}
        renderActions={() => <button type="button">act</button>}
      />,
    ),
  );
  const row = rows()[0]!;
  const stats = [...row.querySelectorAll("span")].find((s) => s.textContent === "+3 -1")!;
  expect(stats.className).not.toContain("hidden");
  // Actions come first, so the counts stay put at the row's end.
  expect(row.lastElementChild).toBe(stats);
});
