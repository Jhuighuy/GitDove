// @vitest-environment happy-dom
import type { Ref, RefsSnapshot } from "@shared/domain";
import { isHidden } from "@shared/visibility";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSectionStack } from "./SectionStack";
import { Sidebar } from "./Sidebar";

const mocks = vi.hoisted(() => ({
  hidden: [] as string[],
  setHidden: [] as string[][],
  commands: [] as string[],
}));

vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  platform: "darwin",
  useEvent: () => {},
  api: async (method: string, _repo: string, arg?: string[]) => {
    switch (method) {
      case "repo.refs":
        return snapshot;
      case "repo.info":
        return { workTree: "/repo", head: { branch: "main", hash: "h", detached: false } };
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
  commands: new Proxy({}, { get: (_, command: string) => () => void mocks.commands.push(command) }),
}));

const ref = (name: string, extra: Partial<Ref> = {}): Ref => {
  const remote = name.startsWith("refs/remotes/") ? name.split("/")[2]! : null;
  return {
    name,
    short: name.replace(/^refs\/(heads|remotes|tags)\//, ""),
    kind: remote ? "remote" : name.startsWith("refs/tags/") ? "tag" : "branch",
    hash: name,
    upstream: null,
    ahead: 0,
    behind: 0,
    upstreamGone: false,
    isHead: false,
    remote,
    ...extra,
  };
};

const base: RefsSnapshot = {
  refs: [
    ref("refs/heads/main", { isHead: true }),
    ref("refs/heads/release/2023.0"),
    ref("refs/heads/release/2023.1"),
    ref("refs/heads/user/my-branch"),
    ref("refs/remotes/origin/main"),
    ref("refs/remotes/origin/release/2023.0"),
    ref("refs/remotes/origin/release/2023.1"),
  ],
  stashes: [],
  remotes: [{ name: "origin", fetchUrl: "git@example.com:repo", pushUrl: "" }],
  worktrees: [],
  submodules: [],
  owners: { byRef: {}, people: {}, me: { email: null, name: null } },
};
let snapshot = base;

let root: Root;
let repo = 0;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Sections render the rows on screen: make room for them all.
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(2000);
  mocks.hidden = [];
  mocks.setHidden = [];
  mocks.commands = [];
  snapshot = base;
  repo++;
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function render(hidden: string[] = [], snap = base) {
  mocks.hidden = hidden;
  snapshot = snap;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient();
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Sidebar repo={`local:/repo${repo}`} />
      </QueryClientProvider>,
    ),
  );
  // Wait for both the refs and the hidden-refs queries to land.
  const names = snapshot.refs.map((r) => r.name);
  const viewing = `Viewing ${names.filter((n) => !isHidden(hidden, n)).length}/${names.length}`;
  await act(() =>
    vi.waitFor(() => {
      if (!document.body.textContent?.includes(viewing)) throw new Error(`Not ${viewing}`);
    }),
  );
}

/** The sidebar row with the given tooltip. */
const row = (title: string) => {
  const el = document.querySelector<HTMLElement>(`[title="${title}"]`);
  if (!el) throw new Error(`No row "${title}"`);
  return el;
};
const has = (title: string) => document.querySelector(`[title="${title}"]`) !== null;
const click = (el: HTMLElement) => act(async () => el.click());
const eye = (title: string) => click(row(title).querySelector("button")!);
const fire = (el: HTMLElement, type: string) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 10, clientY: 10 }));
  });
/** Opens a row's context menu and clicks one of its items. */
const menu = async (title: string, label: string) => {
  await fire(row(title), "contextmenu");
  const el = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (e) => e.textContent?.trim() === label,
  );
  if (!el) throw new Error(`No "${label}" menu item`);
  await click(el);
};

it("groups shared prefixes into folders and keeps lone prefixes flat", async () => {
  await render();
  expect(row("release/").textContent).toContain("release");
  expect(row("release/2023.0").textContent).toBe("2023.0");
  expect(row("user/my-branch").textContent).toBe("user/my-branch");
  expect(row("origin/release/").textContent).toContain("release");
  expect(row("origin/release/2023.1").textContent).toBe("2023.1");
});

it("collapses folders, but not while filtering", async () => {
  await render();
  await click(row("release/"));
  expect(has("release/2023.0")).toBe(false);
  expect(row("release/").textContent).toContain("2");

  const filter = document.querySelector<HTMLInputElement>('input[placeholder="Filter"]')!;
  const type = (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        filter,
        value,
      );
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
  await type("2023.1");
  // Filtering expands matching folders and drops everything else.
  expect(has("release/2023.1")).toBe(true);
  expect(has("release/2023.0")).toBe(false);
  expect(has("user/my-branch")).toBe(false);
  await click(row("release/"));
  await type("");
  // The click while filtering did not change the saved state.
  expect(has("release/2023.0")).toBe(false);

  await click(row("release/"));
  expect(has("release/2023.0")).toBe(true);
});

it("marks a collapsed folder that contains the checked-out branch", async () => {
  const snap: RefsSnapshot = {
    ...base,
    refs: base.refs.map((r) =>
      r.kind === "branch" ? { ...r, isHead: r.short === "release/2023.1" } : r,
    ),
  };
  await render([], snap);
  const marker = () => row("release/").querySelector('[title="Contains the checked-out branch"]');
  // Open: the branch itself shows its check.
  expect(marker()).toBeNull();
  await click(row("release/"));
  expect(has("release/2023.1")).toBe(false);
  expect(marker()).not.toBeNull();
  expect(row("release/").className).toContain("font-semibold");
  // Screen readers get it as text, not just the icon's title.
  expect(marker()!.querySelector(".sr-only")?.textContent).toBe("Contains the checked-out branch");
  // Its visibility toggle stays available.
  expect(row("release/").querySelector('button[title="Hide from graph"]')).not.toBeNull();
  // Opening it again shows the branch with its check instead.
  await click(row("release/"));
  expect(marker()).toBeNull();
  expect(has("release/2023.1")).toBe(true);
});

it("hides local folders branch by branch and remote folders by prefix", async () => {
  await render();
  await eye("release/");
  expect(mocks.setHidden.at(-1)).toEqual([
    "refs/heads/release/2023.0",
    "refs/heads/release/2023.1",
  ]);
  await eye("origin/release/");
  expect(mocks.setHidden.at(-1)).toContain("refs/remotes/origin/release/");
});

it("shows a folder inside a hidden remote without showing the rest of it", async () => {
  await render(["refs/remotes/origin/"]);
  await eye("origin/release/");
  expect(mocks.setHidden.at(-1)).toEqual(["refs/remotes/origin/main"]);
});

it("shows one branch of a hidden folder", async () => {
  await render(["refs/remotes/origin/release/"]);
  await eye("origin/release/2023.0");
  expect(mocks.setHidden.at(-1)).toEqual(["refs/remotes/origin/release/2023.1"]);
});

it("offers folder visibility in the context menu", async () => {
  await render(["refs/heads/user/my-branch"]);
  await menu("release/", "Solo release (hide everything else)");
  expect(mocks.setHidden.at(-1)).toEqual([
    "refs/heads/main",
    "refs/heads/user/my-branch",
    "refs/remotes/origin/main",
    "refs/remotes/origin/release/2023.0",
    "refs/remotes/origin/release/2023.1",
  ]);
});

it("hides a folder from its context menu", async () => {
  await render();
  await menu("origin/release/", "Hide release from graph");
  expect(mocks.setHidden.at(-1)).toEqual(["refs/remotes/origin/release/"]);
});

it("reveals, checks out and toggles branches inside folders", async () => {
  await render();
  for (const title of ["release/2023.0", "origin/release/2023.1"]) {
    await fire(row(title), "click");
    await fire(row(title), "dblclick");
  }
  expect(mocks.commands).toEqual(["selectCommit", "checkoutRef", "selectCommit", "checkoutRef"]);
  await eye("release/2023.0");
  expect(mocks.setHidden.at(-1)).toEqual(["refs/heads/release/2023.0"]);
  await menu("origin/release/2023.1", "Solo (hide everything else)");
  expect(mocks.setHidden.at(-1)).not.toContain("refs/remotes/origin/release/2023.1");
});

it("shows a hidden branch from its context menu", async () => {
  await render(["refs/heads/release/"]);
  await menu("release/2023.1", "Show in graph");
  expect(mocks.setHidden.at(-1)).toEqual(["refs/heads/release/2023.0"]);
});

it("toggles whole remotes and tags", async () => {
  await render([], {
    ...base,
    refs: [...base.refs, ref("refs/remotes/upstream/main"), ref("refs/tags/v1.0")],
    remotes: [...base.remotes, { name: "upstream", fetchUrl: "upstream-url", pushUrl: "" }],
  });
  await eye("git@example.com:repo");
  expect(mocks.setHidden.at(-1)).toEqual(["refs/remotes/origin/"]);
  await menu("upstream-url", "Hide upstream branches");
  expect(mocks.setHidden.at(-1)).toEqual(["refs/remotes/origin/", "refs/remotes/upstream/"]);
  // Tags are collapsed by default.
  const tags = [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith("Tags"),
  );
  await click(tags!);
  await eye("v1.0");
  expect(mocks.setHidden.at(-1)).toContain("refs/tags/v1.0");
});

it("keeps the checked-out branch when soloing its folder", async () => {
  const refs = base.refs.map((r) =>
    r.name === "refs/heads/main" ? ref("refs/heads/release/main", { isHead: true }) : r,
  );
  await render([], { ...base, refs });
  await menu("release/", "Solo release (hide everything else)");
  expect(mocks.setHidden.at(-1)).not.toContain("refs/heads/release/main");
  // The eye toggle still leaves it alone.
  await eye("release/");
  expect(mocks.setHidden.at(-1)).not.toContain("refs/heads/release/main");
});

it("offers to show a remote whose branches are all hidden one by one", async () => {
  const origin = base.refs.filter((r) => r.remote === "origin").map((r) => r.name);
  await render(origin, {
    ...base,
    refs: [...base.refs, ref("refs/remotes/upstream/main")],
    remotes: [...base.remotes, { name: "upstream", fetchUrl: "upstream-url", pushUrl: "" }],
  });
  await menu("git@example.com:repo", "Show origin branches");
  expect(mocks.setHidden.at(-1)).toEqual([]);
});

/** The context menu's items. */
const menuItems = () =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((e) =>
    e.textContent?.trim(),
  );
const sectionHeader = (title: string) =>
  [...document.querySelectorAll<HTMLElement>("button")].find((b) =>
    b.textContent?.startsWith(title),
  )!;

it("opens no menu where there is none, rather than the last one", async () => {
  await render();
  // Stashes have no section menu.
  await fire(sectionHeader("Stashes"), "contextmenu");
  expect(menuItems()).toEqual([]);
  await fire(row("release/2023.0"), "contextmenu");
  expect(menuItems()).toContain("Delete release/2023.0");
  await click(
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (e) => e.textContent?.trim() === "Copy branch name",
    )!,
  );
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  await fire(sectionHeader("Stashes"), "contextmenu");
  expect(menuItems()).toEqual([]);
});

it("renders only the rows on screen, and lists every tag", async () => {
  const tags = Array.from({ length: 3000 }, (_, i) => ref(`refs/tags/t${i}`));
  await render([], { ...base, refs: [...base.refs, ...tags] });
  await act(async () => useSectionStack.getState().setOpen("tags", true));
  const shown = () =>
    document.querySelectorAll('[role="tree"][aria-label="Tags"] [role="treeitem"]');
  expect(shown().length).toBeGreaterThan(10);
  expect(shown().length).toBeLessThan(200);
  // All of them can be scrolled to, not just the first thousand.
  const body = document.querySelector<HTMLElement>('[role="tree"][aria-label="Tags"] > div')!;
  expect(Number.parseInt(body.style.height)).toBeGreaterThanOrEqual(3000 * 24);
  const filter = document.querySelector<HTMLInputElement>('input[placeholder="Filter"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      filter,
      "t1500",
    );
    filter.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(has("t1500")).toBe(true);
  expect(filter.getAttribute("aria-label")).toBe("Filter branches, tags and more");
});

it("works from the keyboard", async () => {
  await render();
  const tree = document.querySelector<HTMLElement>('[role="tree"][aria-label="Local branches"]')!;
  const press = (key: string) =>
    act(async () => {
      tree.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  await act(async () => tree.focus());
  const cursor = () => document.getElementById(tree.getAttribute("aria-activedescendant")!);
  expect(cursor()?.title).toBe("main");
  await press("ArrowDown");
  expect(cursor()?.title).toBe("release/");
  expect(cursor()?.getAttribute("aria-expanded")).toBe("true");
  // Left collapses a folder, Right expands it.
  await press("ArrowLeft");
  expect(has("release/2023.0")).toBe(false);
  expect(cursor()?.getAttribute("aria-expanded")).toBe("false");
  await press("ArrowRight");
  expect(has("release/2023.0")).toBe(true);
  // Enter reveals a branch, Space toggles its eye.
  await press("ArrowDown");
  expect(cursor()?.title).toBe("release/2023.0");
  await press("Enter");
  expect(mocks.commands).toEqual(["selectCommit"]);
  await press(" ");
  expect(mocks.setHidden.at(-1)).toEqual(["refs/heads/release/2023.0"]);
  await press("End");
  expect(cursor()?.title).toBe("user/my-branch");
  // The eyes are named, and out of the tab order.
  const eyeButton = row("user/my-branch").querySelector("button")!;
  expect(eyeButton.getAttribute("aria-label")).toBe("Hide from graph: user/my-branch");
  expect(eyeButton.tabIndex).toBe(-1);
  // The menu key opens the menu of the row under the cursor.
  await press("ContextMenu");
  expect(menuItems()).toContain("Delete user/my-branch");
});

it("forgets collapsed folders that are gone", async () => {
  await render();
  await click(row("release/"));
  expect(has("release/2023.0")).toBe(false);
  // One branch left: no folder.
  await act(async () => root.unmount());
  const one = base.refs.filter((r) => r.name !== "refs/heads/release/2023.1");
  await render([], { ...base, refs: one });
  expect(has("release/2023.0")).toBe(true);
  // Two again: the folder is new, so open.
  await act(async () => root.unmount());
  await render();
  expect(has("release/2023.0")).toBe(true);
});
