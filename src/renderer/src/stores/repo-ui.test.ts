// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it } from "vitest";
import type { GraphRow } from "@shared/domain";
import { type Selection, selectedHashes, useLayout, useRepoUi, useRepoUiStore } from "./repo-ui";

const A = "local:/a";
const B = "local:/b";
const ui = (repo: string) => useRepoUiStore.getState().byRepo[repo];

beforeEach(() => {
  useRepoUiStore.setState({ byRepo: {} });
  useLayout.setState({ sidebar: true, details: true, diffMode: "unified", diffViews: {} });
});

it("keeps selection and diff per repository", () => {
  const { select, openDiff } = useRepoUiStore.getState();
  select(A, { kind: "wip" });
  openDiff(B, { kind: "unstaged", path: "x" });
  expect(ui(A)).toEqual({ selection: { kind: "wip" }, diff: null, rebase: null, revealToken: 0 });
  expect(ui(B)).toEqual({
    selection: null,
    diff: { kind: "unstaged", path: "x" },
    rebase: null,
    revealToken: 0,
  });
});

it("closes the diff when the selection changes, but not when it is re-selected", () => {
  const { select, openDiff } = useRepoUiStore.getState();
  const diff = { kind: "commit", hash: "c1", path: "f" } as const;
  select(A, { kind: "commit", hash: "c1" });
  openDiff(A, diff);
  select(A, { kind: "commit", hash: "c1" });
  expect(ui(A)?.diff).toEqual(diff);
  select(A, { kind: "commit", hash: "c2" });
  expect(ui(A)?.diff).toBeNull();

  select(A, { kind: "wip" });
  openDiff(A, { kind: "staged", path: "g" });
  select(A, { kind: "wip" });
  expect(ui(A)?.diff).toEqual({ kind: "staged", path: "g" });
  select(A, null);
  expect(ui(A)).toMatchObject({ selection: null, diff: null });
});

it("bumps the reveal token only when asked", () => {
  const { select } = useRepoUiStore.getState();
  select(A, { kind: "commit", hash: "c1" }, true);
  select(A, { kind: "commit", hash: "c2" });
  select(A, { kind: "commit", hash: "c3" }, true);
  expect(ui(A)?.revealToken).toBe(2);
});

it("exposes a repository's UI state through a hook", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const seen: unknown[] = [];
  const Probe = () => {
    seen.push(useRepoUi(A));
    return null;
  };
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Probe)));
  expect(seen.at(-1)).toEqual({ selection: null, diff: null, rebase: null, revealToken: 0 });
  await act(async () => useRepoUiStore.getState().select(A, { kind: "wip" }));
  expect(seen.at(-1)).toMatchObject({ selection: { kind: "wip" } });
  await act(async () => root.unmount());
});

it("toggles and persists the layout", () => {
  const s = () => useLayout.getState();
  s().toggleSidebar();
  s().toggleDetails();
  s().setDiffMode("split");
  s().setDiffView("svg", "image");
  s().setDiffView("md", "diff");
  expect(s()).toMatchObject({
    sidebar: false,
    details: false,
    diffMode: "split",
    diffViews: { svg: "image", md: "diff" },
  });
  s().toggleSidebar();
  expect(s().sidebar).toBe(true);
  expect(JSON.parse(localStorage.getItem("gitdove.layout")!).state).toMatchObject({
    sidebar: true,
    diffMode: "split",
  });
});

it("keeps the diff of several commits while the same ones stay selected", () => {
  const commits = (...hashes: string[]): Selection => ({
    kind: "commits",
    commits: hashes.map((hash, index) => ({ index, row: { hash } as GraphRow })),
    anchor: hashes[0]!,
    version: 1,
  });
  const diff = { kind: "commit", hash: "a", base: "c", path: "f" } as const;
  const { select, openDiff } = useRepoUiStore.getState();
  select(A, commits("a", "b"));
  openDiff(A, diff);
  select(A, commits("a", "b"));
  expect(ui(A)?.diff).toEqual(diff);
  select(A, commits("a", "c"));
  expect(ui(A)?.diff).toBeNull();
  expect([...selectedHashes(ui(A)!.selection)]).toEqual(["a", "c"]);
  expect([...selectedHashes({ kind: "commit", hash: "x" })]).toEqual(["x"]);
  expect(selectedHashes({ kind: "wip" }).size).toBe(0);
});
