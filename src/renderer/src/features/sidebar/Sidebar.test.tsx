// @vitest-environment happy-dom
import type { Ref, RefsSnapshot } from "@shared/domain";
import { isHidden } from "@shared/visibility";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

const mocks = vi.hoisted(() => ({
  hidden: [] as string[],
  setHidden: [] as string[][],
  commands: [] as string[],
}));

vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
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
};
let snapshot = base;

let root: Root;
let repo = 0;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.hidden = [];
  mocks.setHidden = [];
  mocks.commands = [];
  snapshot = base;
  repo++;
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
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
  const total = snapshot.refs.length;
  const viewing = `Viewing ${total - snapshot.refs.filter((r) => isHidden(hidden, r.name)).length}/${total}`;
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
