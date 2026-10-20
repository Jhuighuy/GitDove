// @vitest-environment happy-dom
import type { GraphRow, Ref, Stash } from "@shared/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { CommitContextMenu, type MenuTarget } from "./CommitContextMenu";

const mocks = vi.hoisted(() => ({
  calls: [] as unknown[][],
  api: [] as unknown[][],
}));

vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  api: async (method: string, ...args: unknown[]) => {
    mocks.api.push([method, ...args.slice(1)]);
    switch (method) {
      case "repo.info":
        return { workTree: "/repo", head: { branch: "main", hash: "h", detached: false } };
      case "repo.refs":
        return { refs: [], stashes: [], remotes: [], worktrees: [], submodules: [] };
      case "repo.hiddenRefs":
        return [];
      case "repo.setHiddenRefs":
      case "repo.stageAll":
        return undefined;
    }
    throw new Error(`unexpected ${method}`);
  },
}));
vi.mock("../commands", () => ({
  commands: new Proxy(
    {},
    {
      get:
        (_, command: string) =>
        (...args: unknown[]) =>
          void mocks.calls.push([command, ...args.slice(command === "copy" ? 0 : 1)]),
    },
  ),
}));

const HASH = "0123456789abcdef0123456789abcdef01234567";
const REPO = "local:/repo";

const row: GraphRow = {
  hash: HASH,
  parents: [],
  subject: "Fix the thing",
  authorName: "A",
  authorEmail: "a@example.com",
  authorTime: 0,
  committerTime: 0,
  lane: 0,
  color: 0,
  edges: [],
  width: 1,
};

const ref = (name: string, extra: Partial<Ref> = {}): Ref => {
  const remote = name.startsWith("refs/remotes/") ? name.split("/")[2]! : null;
  return {
    name,
    short: name.replace(/^refs\/(heads|remotes|tags)\//, ""),
    kind: remote ? "remote" : name.startsWith("refs/tags/") ? "tag" : "branch",
    hash: HASH,
    upstream: null,
    ahead: 0,
    behind: 0,
    upstreamGone: false,
    isHead: false,
    remote,
    ...extra,
  };
};

let root: Root | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.calls = [];
  mocks.api = [];
});

const unmount = async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
};

afterEach(unmount);

async function open(target: MenuTarget | null, stashes: Stash[] = []) {
  await unmount();
  const container = document.createElement("div");
  document.body.append(container);
  const r = createRoot(container);
  root = r;
  const client = new QueryClient();
  await act(async () =>
    r.render(
      <QueryClientProvider client={client}>
        <ContextMenu>
          <ContextMenuTrigger render={<div data-testid="trigger" />} />
          <CommitContextMenu repo={REPO} target={target} stashes={stashes} />
        </ContextMenu>
      </QueryClientProvider>,
    ),
  );
  await act(() =>
    vi.waitFor(() => {
      if (!mocks.api.some(([m]) => m === "repo.info")) throw new Error("no info yet");
    }),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const trigger = document.querySelector<HTMLElement>("[data-testid=trigger]")!;
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
  });
}

const items = () =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((e) =>
    e.textContent?.trim(),
  );

const find = (label: string) => {
  const el = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (e) => e.textContent?.trim() === label,
  );
  if (!el) throw new Error(`No "${label}" menu item in ${JSON.stringify(items())}`);
  return el;
};

const click = (label: string) => act(async () => find(label).click());

/** Opens a submenu by its trigger's label. */
const sub = async (label: string) => {
  const el = find(label);
  await act(async () => {
    el.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    el.click();
  });
  await act(async () => new Promise((r) => setTimeout(r, 0)));
};

it("renders no items without a target", async () => {
  await open(null);
  expect(items()).toEqual([]);
});

it("stages or stashes everything from the WIP row", async () => {
  await open({ kind: "wip" });
  expect(items()).toEqual(["Stage all changes", "Stash all changes"]);
  await click("Stage all changes");
  await act(() => vi.waitFor(() => expect(mocks.api.at(-1)).toEqual(["repo.stageAll"])));
  await open({ kind: "wip" });
  await click("Stash all changes");
  expect(mocks.calls).toEqual([["stash"]]);
});

it("offers stash actions on stash commits", async () => {
  const stash: Stash = { index: 2, name: "stash@{2}", hash: HASH, message: "WIP", time: 0 };
  const target: MenuTarget = { kind: "commit", row, refs: [], stashIndex: 2 };
  for (const label of ["Apply stash", "Pop stash", "Delete stash"]) {
    await open(target, [stash]);
    expect(items()).toEqual(["Apply stash", "Pop stash", "Delete stash"]);
    await click(label);
  }
  expect(mocks.calls).toEqual([
    ["applyStash", 2],
    ["pop", 2],
    ["dropStash", 2],
  ]);
});

it("offers commit actions", async () => {
  const target: MenuTarget = { kind: "commit", row, refs: [], stashIndex: null };
  await open(target);
  expect(items()).toEqual([
    "Checkout this commit (detached)",
    "Create branch here…",
    "Create tag here…",
    "Cherry-pick commit",
    "Revert commit",
    "Reset main to this commit",
    "Copy commit SHA",
    "Copy commit message",
  ]);
  for (const label of [
    "Checkout this commit (detached)",
    "Create branch here…",
    "Create tag here…",
    "Cherry-pick commit",
    "Revert commit",
    "Copy commit SHA",
    "Copy commit message",
  ]) {
    await open(target);
    await click(label);
  }
  expect(mocks.calls).toEqual([
    ["checkout", HASH],
    ["createBranch", HASH, "0123456"],
    ["createTag", HASH],
    ["cherryPick", HASH],
    ["revert", HASH],
    ["copy", HASH, "Commit SHA copied"],
    ["copy", "Fix the thing", "Message copied"],
  ]);
});

it("resets HEAD to the commit", async () => {
  const target: MenuTarget = { kind: "commit", row, refs: [], stashIndex: null };
  for (const label of [
    "Soft — keep all changes staged",
    "Mixed — keep working copy, reset index",
    "Hard — discard all changes",
  ]) {
    await open(target);
    await sub("Reset main to this commit");
    await click(label);
  }
  expect(mocks.calls).toEqual([
    ["reset", HASH, "soft"],
    ["reset", HASH, "mixed"],
    ["reset", HASH, "hard"],
  ]);
});

it("offers branch actions for refs on the commit", async () => {
  const feature = ref("refs/heads/feature");
  const target: MenuTarget = { kind: "commit", row, refs: [feature], stashIndex: null };
  const labels = [
    "Checkout feature",
    "Merge feature into main",
    "Rebase main onto feature",
    "Rename feature…",
    "Copy branch name",
    "Delete feature",
    "Hide from graph",
  ];
  for (const label of labels) {
    await open(target);
    expect(items()[0]).toBe("feature");
    await sub("feature");
    await click(label);
  }
  expect(mocks.calls).toEqual([
    ["checkoutRef", feature],
    ["merge", "feature"],
    ["rebase", "feature"],
    ["renameBranch", "feature"],
    ["copy", "feature", "Branch name copied"],
    ["deleteBranch", feature],
  ]);
  expect(mocks.api.filter(([m]) => m === "repo.setHiddenRefs")).toEqual([
    ["repo.setHiddenRefs", ["refs/heads/feature"]],
  ]);
});

it("offers fewer actions for the checked-out branch and remote branches", async () => {
  const head = ref("refs/heads/main", { isHead: true });
  const remote = ref("refs/remotes/origin/main");
  await open({ kind: "commit", row, refs: [head, remote], stashIndex: null });
  await sub("main");
  const headItems = items();
  expect(headItems).toContain("Rename main…");
  expect(headItems).toContain("Copy branch name");
  expect(headItems).not.toContain("Checkout main");
  expect(headItems).not.toContain("Delete main");

  await open({ kind: "commit", row, refs: [head, remote], stashIndex: null });
  await sub("origin/main");
  expect(items()).toContain("Checkout origin/main");
  expect(items()).not.toContain("Rename origin/main…");
});

it("offers tag actions", async () => {
  const tag = ref("refs/tags/v1.0");
  const target: MenuTarget = { kind: "commit", row, refs: [tag], stashIndex: null };
  for (const label of ["Copy tag name", "Delete tag v1.0", "Hide from graph"]) {
    await open(target);
    await sub("Tag v1.0");
    await click(label);
  }
  expect(mocks.calls).toEqual([
    ["copy", "v1.0", "Tag name copied"],
    ["deleteTag", "v1.0"],
  ]);
  expect(mocks.api.filter(([m]) => m === "repo.setHiddenRefs")).toEqual([
    ["repo.setHiddenRefs", ["refs/tags/v1.0"]],
  ]);
});
