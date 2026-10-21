// @vitest-environment happy-dom
import type { Ref, RefsSnapshot } from "@shared/domain";
import { stashKey } from "@shared/visibility";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSectionStack } from "./SectionStack";
import { Sidebar } from "./Sidebar";

const mocks = vi.hoisted(() => ({
  hidden: [] as string[],
  setHidden: [] as string[][],
  commands: [] as unknown[][],
  repo: "",
}));

vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  useEvent: () => {},
  api: async (method: string, _repo: string, arg?: string[]) => {
    switch (method) {
      case "repo.refs":
        return snapshot;
      case "repo.info":
        return { workTree: "/repo", head: { branch: "main", hash: "h0", detached: false } };
      case "repo.hiddenRefs":
        return mocks.hidden;
      case "repo.setHiddenRefs":
        mocks.setHidden.push(arg!);
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
          void mocks.commands.push([command, ...args.filter((a) => a !== mocks.repo)]),
    },
  ),
}));

const ref = (name: string, extra: Partial<Ref> = {}): Ref => {
  const remote = name.startsWith("refs/remotes/") ? name.split("/")[2]! : null;
  return {
    name,
    short: name.replace(/^refs\/(heads|remotes|tags)\//, ""),
    kind: remote ? "remote" : name.startsWith("refs/tags/") ? "tag" : "branch",
    hash: `hash-of-${name}`,
    upstream: null,
    ahead: 0,
    behind: 0,
    upstreamGone: false,
    isHead: false,
    remote,
    ...extra,
  };
};

const main = ref("refs/heads/main", { isHead: true, upstream: "origin/main", ahead: 1, behind: 2 });
const feature = ref("refs/heads/feature", { upstreamGone: true });
const originMain = ref("refs/remotes/origin/main");
const originFeature = ref("refs/remotes/origin/feature");
const tag = ref("refs/tags/v1.0");
const stash = { index: 0, name: "stash@{0}", hash: "stash-hash", message: "WIP on main", time: 0 };
const origin = { name: "origin", fetchUrl: "git@github.com:me/repo.git", pushUrl: "" };

const base: RefsSnapshot = {
  refs: [main, feature, originMain, originFeature, ref("refs/remotes/origin/HEAD"), tag],
  stashes: [stash],
  remotes: [origin],
  worktrees: [
    { path: "/repo", hash: "h0", branch: "main", isMain: true, locked: false },
    { path: "/wt/feature", hash: "h1", branch: "feature", isMain: false, locked: false },
    { path: "/wt/loose", hash: "h2", branch: null, isMain: false, locked: false },
  ],
  submodules: [
    { path: "libs/a", hash: "a", status: "ok" },
    { path: "libs/b", hash: "b", status: "uninitialized" },
  ],
};
let snapshot = base;

let root: Root;
let n = 0;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.hidden = [];
  mocks.setHidden = [];
  mocks.commands = [];
  snapshot = base;
  // Expand every section, including the ones collapsed by default.
  useSectionStack.setState({
    open: { worktrees: true, tags: true, submodules: true },
    weights: {},
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

async function render(snap = base, hidden: string[] = [], repo = `local:/repo${++n}`) {
  snapshot = snap;
  mocks.hidden = hidden;
  mocks.repo = repo;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <Sidebar repo={repo} />
      </QueryClientProvider>,
    ),
  );
  await act(() =>
    vi.waitFor(() => {
      if (!document.querySelector('[title="feature"]')) throw new Error("not loaded");
      if (!document.body.textContent?.includes("Viewing")) throw new Error("no visibility");
    }),
  );
  await act(async () => new Promise((r) => setTimeout(r, 0)));
}

const row = (title: string) => {
  const el = document.querySelector<HTMLElement>(`[title="${CSS.escape(title)}"]`);
  if (!el) throw new Error(`No row "${title}"`);
  return el;
};
const header = (title: string) => {
  const el = [...document.querySelectorAll<HTMLElement>("button")].find((b) =>
    b.textContent?.startsWith(title),
  );
  if (!el) throw new Error(`No "${title}" section`);
  return el;
};
const fire = (el: HTMLElement, type: string) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 10, clientY: 10 }));
  });
const items = () =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((e) =>
    e.textContent?.trim(),
  );
const item = (label: string) => {
  const el = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (e) => e.textContent?.trim() === label,
  );
  if (!el) throw new Error(`No "${label}" menu item in ${JSON.stringify(items())}`);
  return el;
};

/** Opens the context menu of an element and clicks the item at `path` (submenu triggers first). */
const menu = async (el: HTMLElement, ...path: string[]) => {
  await fire(el, "contextmenu");
  for (const label of path) {
    await act(async () => item(label).click());
    await act(async () => new Promise((r) => setTimeout(r, 0)));
  }
};

const RESETS = [
  ["Soft — keep all changes staged", "soft"],
  ["Mixed — keep working copy, reset index", "mixed"],
  ["Hard — discard all changes", "hard"],
] as const;

it("runs local branch actions", async () => {
  await render();
  const cases: [string, unknown[]][] = [
    ["Push", ["pushBranch", feature]],
    ["Set upstream…", ["setUpstream", feature]],
    ["Merge feature into main", ["merge", "feature"]],
    ["Rebase main onto feature", ["rebase", "feature"]],
    ["Checkout feature", ["checkoutRef", feature]],
    ["Create worktree from feature…", ["createWorktree", "feature", "feature"]],
    ["Create branch here…", ["createBranch", feature.hash, "feature"]],
    ["Create tag here…", ["createTag", feature.hash]],
    ["Rename feature…", ["renameBranch", "feature"]],
    ["Delete feature", ["deleteBranch", feature]],
    ["Copy branch name", ["copy", "feature", "Branch name copied"]],
    ["Copy commit SHA", ["copy", feature.hash, "Commit SHA copied"]],
  ];
  for (const [label] of cases) await menu(row("feature"), label);
  for (const [label] of RESETS) await menu(row("feature"), "Reset main to this commit", label);
  expect(mocks.commands).toEqual([
    ...cases.map(([, call]) => call),
    ...RESETS.map(([, mode]) => ["reset", feature.hash, mode]),
  ]);
  // Without an upstream there is nothing to pull from.
  await fire(row("feature"), "contextmenu");
  expect(item("Pull (fast-forward if possible)").getAttribute("aria-disabled")).toBe("true");
});

it("offers fewer actions on the checked-out branch", async () => {
  await render();
  await menu(row("main"), "Pull (fast-forward if possible)");
  expect(mocks.commands).toEqual([["pullBranch", main]]);
  await fire(row("main"), "contextmenu");
  expect(items()).not.toContain("Checkout main");
  expect(items()).not.toContain("Delete main");
  expect(items()).not.toContain("Hide from graph");
  expect(items()).toContain("Rename main…");
});

it("hides, solos and shows branches from their menus", async () => {
  await render();
  await menu(row("feature"), "Hide from graph");
  expect(mocks.setHidden.at(-1)).toEqual(["refs/heads/feature"]);
  await menu(row("feature"), "Show in graph");
  expect(mocks.setHidden.at(-1)).toEqual([]);
  await menu(row("origin/feature"), "Solo (hide everything else)");
  expect(mocks.setHidden.at(-1)).not.toContain("refs/remotes/origin/feature");
  expect(mocks.setHidden.at(-1)).toContain("refs/heads/feature");
  await menu(row("v1.0"), "Show all");
  expect(mocks.setHidden.at(-1)).toEqual([]);
});

it("runs remote branch actions", async () => {
  await render();
  const r = originFeature;
  const cases: [string, unknown[]][] = [
    ["Checkout origin/feature", ["checkoutRef", r]],
    ["Merge origin/feature into main", ["merge", "origin/feature"]],
    ["Rebase main onto origin/feature", ["rebase", "origin/feature"]],
    [
      "Create worktree from origin/feature…",
      ["createWorktree", "origin/feature", "origin/feature"],
    ],
    ["Create branch here…", ["createBranch", r.hash, "origin/feature"]],
    ["Create tag here…", ["createTag", r.hash]],
    ["Delete origin/feature on remote", ["deleteBranch", r]],
    ["Copy branch name", ["copy", "origin/feature", "Branch name copied"]],
    ["Copy commit SHA", ["copy", r.hash, "Commit SHA copied"]],
  ];
  for (const [label] of cases) await menu(row("origin/feature"), label);
  await menu(row("origin/feature"), "Reset main to this commit", "Hard — discard all changes");
  expect(mocks.commands).toEqual([...cases.map(([, c]) => c), ["reset", r.hash, "hard"]]);
});

it("runs tag actions", async () => {
  await render();
  const cases: [string, unknown[]][] = [
    ["Checkout v1.0 (detached)", ["checkout", "v1.0"]],
    ["Create branch here…", ["createBranch", tag.hash, "v1.0"]],
    ["Push v1.0 to remote", ["pushTag", "v1.0"]],
    ["Delete v1.0 locally", ["deleteTag", "v1.0"]],
    ["Delete v1.0 on remote", ["deleteRemoteTag", "v1.0"]],
    ["Copy tag name", ["copy", "v1.0", "Tag name copied"]],
    ["Copy commit SHA", ["copy", tag.hash, "Commit SHA copied"]],
  ];
  for (const [label] of cases) await menu(row("v1.0"), label);
  expect(mocks.commands).toEqual(cases.map(([, c]) => c));
  await menu(row("v1.0"), "Hide from graph");
  expect(mocks.setHidden.at(-1)).toEqual(["refs/tags/v1.0"]);
});

it("runs stash actions", async () => {
  await render();
  const title = "stash@{0}: WIP on main";
  for (const label of ["Apply stash", "Pop stash", "Create branch here…", "Delete stash"])
    await menu(row(title), label);
  expect(mocks.commands).toEqual([
    ["applyStash", 0],
    ["pop", 0],
    ["createBranch", "stash-hash", "stash@{0}"],
    ["dropStash", 0],
  ]);
  await menu(row(title), "Hide from graph");
  expect(mocks.setHidden.at(-1)).toEqual([stashKey("stash-hash")]);
});

it("runs worktree actions", async () => {
  await render();
  // The current worktree cannot be opened again nor removed.
  await fire(row("/repo"), "contextmenu");
  expect(item("Open in new tab").getAttribute("aria-disabled")).toBe("true");
  expect(items()).not.toContain("Remove worktree");
  for (const label of ["Reveal in Finder", "Copy path"]) await menu(row("/repo"), label);
  for (const label of ["Open in new tab", "Remove worktree"]) await menu(row("/wt/feature"), label);
  expect(mocks.commands).toEqual([
    ["reveal", "/repo"],
    ["copy", "/repo", "Path copied"],
    ["openSibling", "/wt/feature"],
    ["removeWorktree", "/wt/feature"],
  ]);
});

it("does not offer to reveal remote worktrees", async () => {
  await render(base, [], `ssh://fedora/repo${++n}`);
  await fire(row("/wt/feature"), "contextmenu");
  expect(items()).not.toContain("Reveal in Finder");
  expect(items()).toContain("Copy path");
});

it("runs submodule actions", async () => {
  await render();
  for (const label of ["Open in new tab", "Update", "Copy path"]) await menu(row("libs/a"), label);
  await menu(row("libs/b"), "Initialize and update");
  expect(mocks.commands).toEqual([
    ["openSibling", "libs/a"],
    ["updateSubmodule", "libs/a"],
    ["copy", "libs/a", "Path copied"],
    ["updateSubmodule", "libs/b"],
  ]);
});

it("runs section actions", async () => {
  await render();
  await menu(header("Local"), "Create branch…");
  await menu(header("Tags"), "Create tag at HEAD…");
  await menu(header("Worktrees"), "Create worktree…");
  await menu(header("Worktrees"), "Prune stale worktrees");
  // With a single remote, its actions are in the section menu.
  for (const label of [
    "Fetch origin",
    "Edit origin URL…",
    "Copy origin URL",
    "Add remote…",
    "Remove origin",
  ])
    await menu(header("Remote"), label);
  expect(mocks.commands).toEqual([
    ["createBranch", "HEAD", "main"],
    ["createTag", "HEAD"],
    ["createWorktree", "HEAD", "main"],
    ["pruneWorktrees"],
    ["fetchRemote", "origin"],
    ["editRemoteUrl", "origin", origin.fetchUrl],
    ["copy", origin.fetchUrl, "Remote URL copied"],
    ["addRemote"],
    ["removeRemote", "origin"],
  ]);
});

it("hides and shows whole sections", async () => {
  await render();
  // Local branches hide one by one (new branches stay visible), the checked-out one stays.
  await menu(header("Local"), "Hide all");
  expect(mocks.setHidden.at(-1)).toEqual(["refs/heads/feature"]);
  await menu(header("Local"), "Show all");
  expect(mocks.setHidden.at(-1)).toEqual([]);
  await menu(header("Remote"), "Hide all");
  expect(mocks.setHidden.at(-1)).toEqual(["refs/remotes/"]);
  await menu(header("Tags"), "Hide all");
  expect(mocks.setHidden.at(-1)).toEqual(["refs/remotes/", "refs/tags/"]);
  await menu(header("Remote"), "Show all");
  expect(mocks.setHidden.at(-1)).toEqual(["refs/tags/"]);
});

it("offers remote actions on each of several remotes", async () => {
  const upstream = { name: "upstream", fetchUrl: "https://gitlab.com/x/repo.git", pushUrl: "" };
  const fork = { name: "fork", fetchUrl: "https://bitbucket.org/x/repo.git", pushUrl: "" };
  const other = { name: "other", fetchUrl: "/srv/repo.git", pushUrl: "" };
  await render({
    ...base,
    refs: [...base.refs, ref("refs/remotes/upstream/main")],
    remotes: [origin, upstream, fork, other],
  });
  // Each remote has its own row (with a host icon).
  for (const r of [origin, upstream, fork, other])
    expect(row(r.fetchUrl).querySelector("svg")).not.toBeNull();
  await menu(header("Remote"), "Add remote…");
  await menu(header("Remote"), "Fetch all");
  for (const label of ["Fetch upstream", "Edit URL…", "Copy URL", "Remove upstream"])
    await menu(row(upstream.fetchUrl), label);
  expect(mocks.commands).toEqual([
    ["addRemote"],
    ["fetch"],
    ["fetchRemote", "upstream"],
    ["editRemoteUrl", "upstream", upstream.fetchUrl],
    ["copy", upstream.fetchUrl, "Remote URL copied"],
    ["removeRemote", "upstream"],
  ]);
  await menu(row(upstream.fetchUrl), "Hide upstream branches");
  expect(mocks.setHidden.at(-1)).toEqual(["refs/remotes/upstream/"]);
});

it("shows tracking state, worktree and submodule details", async () => {
  await render();
  expect(row("main").textContent).toContain("1↑ 2↓");
  expect(row("feature").textContent).toContain("gone");
  expect(row("/repo").textContent).toBe("repo (main)main");
  expect(row("/wt/loose").textContent).toBe("loose (detached)");
  expect(row("libs/a").textContent).toBe("libs/a");
  expect(row("libs/b").textContent).toBe("libs/buninitialized");
});

it("opens items by double-clicking them", async () => {
  await render();
  for (const title of ["/repo", "/wt/feature", "libs/b", "stash@{0}: WIP on main", "v1.0"])
    await fire(row(title), "dblclick");
  // The current worktree is already open.
  expect(mocks.commands).toEqual([
    ["openSibling", "/wt/feature"],
    ["openSibling", "libs/b"],
    ["applyStash", 0],
    ["checkout", "v1.0"],
  ]);
  mocks.commands = [];
  for (const title of ["stash@{0}: WIP on main", "v1.0"]) await fire(row(title), "click");
  expect(mocks.commands).toEqual([
    ["selectCommit", "stash-hash"],
    ["selectCommit", tag.hash],
  ]);
});

it("toggles stash visibility and shows everything again", async () => {
  await render();
  const title = "stash@{0}: WIP on main";
  await act(async () => row(title).querySelector("button")!.click());
  expect(mocks.setHidden.at(-1)).toEqual([stashKey("stash-hash")]);
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  expect(header("Stashes").textContent).toContain("0/1");
  const showAll = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === "Show all",
  )!;
  await act(async () => showAll.click());
  expect(mocks.setHidden.at(-1)).toEqual([]);
});

it("filters worktrees, stashes and submodules", async () => {
  await render();
  const filter = document.querySelector<HTMLInputElement>('input[placeholder="Filter"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      filter,
      "LIBS/B",
    );
    filter.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(document.querySelector('[title="libs/b"]')).not.toBeNull();
  expect(document.querySelector('[title="libs/a"]')).toBeNull();
  expect(document.querySelector('[title="/repo"]')).toBeNull();
  expect(document.querySelector('[title="stash@{0}: WIP on main"]')).toBeNull();
});
