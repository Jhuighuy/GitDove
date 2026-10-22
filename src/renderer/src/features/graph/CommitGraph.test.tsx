// @vitest-environment happy-dom
import type { GraphInfo, GraphRow, Ref, RefsSnapshot, WorkingStatus } from "@shared/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { keys } from "@/lib/queries";
import { useRepoUiStore } from "@/stores/repo-ui";
import { CommitGraph } from "./CommitGraph";

const mocks = vi.hoisted(() => ({
  api: [] as unknown[][],
  commands: [] as unknown[][],
  info: null as unknown,
  infoError: null as Error | null,
  rows: [] as unknown[],
  status: null as unknown,
  refs: null as unknown,
  /** The index `repo.findCommit` answers, or `null` to look the commit up in `rows`. */
  found: 0 as number | null,
  /** Holds `repo.findCommit` answers back until it settles. */
  gate: null as Promise<void> | null,
  infoGate: null as Promise<void> | null,
  /** Holds `repo.graphRows` answers back until it settles. */
  rowsGate: null as Promise<void> | null,
}));

vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  isMac: true,
  api: async (method: string, ...args: unknown[]) => {
    mocks.api.push([method, ...args.slice(1)]);
    switch (method) {
      case "repo.graphInfo":
        await mocks.infoGate;
        if (mocks.infoError) throw mocks.infoError;
        return mocks.info;
      case "repo.graphRows": {
        const [, , start, end] = args as [string, number, number, number];
        await mocks.rowsGate;
        return mocks.rows.slice(start, end);
      }
      case "repo.status":
        return mocks.status;
      case "repo.info":
        return { workTree: "/repo", head: { branch: "main", hash: "c0", detached: false } };
      case "repo.refs":
        return mocks.refs;
      case "repo.hiddenRefs":
        return [];
      case "repo.findCommit":
        await mocks.gate;
        return mocks.found ?? mocks.rows.findIndex((r) => (r as GraphRow).hash === args[2]);
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
          void mocks.commands.push([command, ...args.slice(1)]),
    },
  ),
}));

const commit = (i: number, extra: Partial<GraphRow> = {}): GraphRow => ({
  hash: `c${i}`,
  parents: [`c${i + 1}`],
  subject: `Commit ${i}`,
  authorName: `Author ${i}`,
  authorEmail: `a${i}@example.com`,
  authorTime: 1_700_000_000 - i * 3600,
  committerTime: 0,
  lane: 0,
  color: 0,
  edges: [0, 1, 0, 2, 0],
  width: 1,
  ...extra,
});

const ref = (name: string, hash: string, extra: Partial<Ref> = {}): Ref => ({
  name,
  short: name.replace(/^refs\/(heads|remotes|tags)\//, ""),
  kind: "branch",
  hash,
  upstream: null,
  ahead: 0,
  behind: 0,
  upstreamGone: false,
  isHead: false,
  remote: null,
  ...extra,
});

const clean: WorkingStatus = { staged: [], unstaged: [], conflicted: [], truncated: false };
const change = { path: "a.txt", kind: "modified" };
const snapshot: RefsSnapshot = {
  refs: [ref("refs/heads/main", "c0", { isHead: true }), ref("refs/heads/feature", "c2")],
  stashes: [{ index: 0, name: "stash@{0}", hash: "c3", message: "WIP", time: 0 }],
  remotes: [],
  worktrees: [],
  submodules: [],
  owners: { byRef: {}, people: {}, me: { email: null, name: null } },
};

let root: Root;
let client: QueryClient;
let container: HTMLElement;
let n = 0;
let repo = "";

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.api = [];
  mocks.commands = [];
  mocks.infoError = null;
  mocks.rows = Array.from({ length: 5 }, (_, i) => commit(i));
  mocks.info = { version: 1, count: 5, complete: true, maxLanes: 1 } satisfies GraphInfo;
  mocks.status = clean;
  mocks.refs = snapshot;
  mocks.found = 0;
  mocks.gate = null;
  mocks.infoGate = null;
  mocks.rowsGate = null;
  repo = `local:/graph${++n}`;
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  // happy-dom lays nothing out: the scroll container is as tall as the rows it holds.
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return (
      Number.parseFloat((this.firstElementChild as HTMLElement | null)?.style.height ?? "0") || 0
    );
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

async function render(wait: string | null = "Commit 0") {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CommitGraph repo={repo} />
      </QueryClientProvider>,
    ),
  );
  if (wait) {
    await act(() =>
      vi.waitFor(() => {
        if (!container.textContent?.includes(wait)) throw new Error(`No "${wait}"`);
      }),
    );
  }
  await settle();
}

/** The row showing the given text. */
const rowOf = (text: string) => {
  const el = [...container.querySelectorAll<HTMLElement>(".absolute.top-0.left-0.flex")].find((e) =>
    e.textContent?.includes(text),
  );
  if (!el) throw new Error(`No row with "${text}"`);
  return el;
};
const selection = () => useRepoUiStore.getState().byRepo[repo]?.selection ?? null;
const scroller = () => container.querySelector<HTMLElement>("[tabindex='0']")!;
const key = (k: string) =>
  act(async () => {
    scroller().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
const mouse = (el: HTMLElement, type: string, button = 0) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, button, clientX: 5, clientY: 5 }));
  });
const menuItems = () =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((e) =>
    e.textContent?.trim(),
  );

it("lists commits with their refs, author, date and short hash", async () => {
  await render();
  const head = rowOf("Commit 0");
  expect(head.textContent).toContain("main");
  expect(head.textContent).toContain("Author 0");
  expect(head.textContent).toContain("c0");
  // The subject of HEAD is emphasized, a stash is shown in italics.
  expect(head.querySelector(".font-medium")?.textContent).toBe("Commit 0");
  expect(rowOf("Commit 3").querySelector(".italic")?.textContent).toBe("Commit 3");
  expect(rowOf("Commit 2").textContent).toContain("feature");
  expect(container.textContent).not.toContain("WIP");
  expect(mocks.api).toContainEqual(["repo.graphRows", 1, 0, 5]);
});

it("shows a WIP row above HEAD when there are changes", async () => {
  mocks.status = { ...clean, unstaged: [change], staged: [change] };
  await render();
  const wip = rowOf("// WIP");
  expect(wip.textContent).toContain("2 changes");
  await mouse(wip, "mousedown");
  expect(selection()).toEqual({ kind: "wip" });
  await mouse(rowOf("Commit 1"), "mousedown");
  expect(selection()).toEqual({ kind: "commit", hash: "c1" });
  // Only the left button selects.
  await mouse(rowOf("Commit 2"), "mousedown", 2);
  await mouse(wip, "mousedown", 2);
  expect(selection()).toEqual({ kind: "commit", hash: "c1" });
});

it("moves the selection with the arrow keys", async () => {
  mocks.status = { ...clean, conflicted: [change] };
  await render();
  expect(rowOf("// WIP").textContent).toContain("1 change");
  await key("ArrowDown");
  expect(selection()).toEqual({ kind: "wip" });
  await key("ArrowDown");
  await key("ArrowDown");
  expect(selection()).toEqual({ kind: "commit", hash: "c1" });
  await key("ArrowUp");
  expect(selection()).toEqual({ kind: "commit", hash: "c0" });
  await key("ArrowUp");
  await key("ArrowUp");
  expect(selection()).toEqual({ kind: "wip" });
  // Other keys are left alone.
  await key("Enter");
  expect(selection()).toEqual({ kind: "wip" });
  for (let i = 0; i < 10; i++) await key("ArrowDown");
  expect(selection()).toEqual({ kind: "commit", hash: "c4" });
});

it("starts keyboard navigation at the first commit without changes", async () => {
  await render();
  await key("ArrowDown");
  expect(selection()).toEqual({ kind: "commit", hash: "c0" });
  await key("ArrowUp");
  expect(selection()).toEqual({ kind: "commit", hash: "c0" });
});

it("checks out a branch by double-clicking its pill", async () => {
  await render();
  const pill = rowOf("Commit 2").querySelector<HTMLElement>("[title='feature']")!;
  await mouse(pill, "dblclick");
  expect(mocks.commands).toEqual([["checkoutRef", snapshot.refs[1]]]);
});

it("opens a commit menu that selects the commit", async () => {
  mocks.status = { ...clean, unstaged: [change] };
  await render();
  await mouse(rowOf("Commit 2"), "contextmenu");
  expect(selection()).toEqual({ kind: "commit", hash: "c2" });
  expect(menuItems()).toContain("feature");
  expect(menuItems()).toContain("Cherry-pick commit");
  const copy = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (e) => e.textContent?.trim() === "Copy commit SHA",
  )!;
  await act(async () => copy.click());
  expect(mocks.commands).toEqual([["copy", "Commit SHA copied"]]);

  await mouse(rowOf("// WIP"), "contextmenu");
  expect(selection()).toEqual({ kind: "wip" });
  expect(menuItems()).toEqual(["Stage all changes", "Stash all changes"]);
});

it("opens stash actions on a stash commit", async () => {
  await render();
  await mouse(rowOf("Commit 3"), "contextmenu");
  expect(menuItems()).toEqual(["Apply stash", "Pop stash", "Delete stash"]);
});

it("scrolls to a commit revealed elsewhere", async () => {
  mocks.found = 3;
  await render();
  await act(async () =>
    useRepoUiStore.getState().select(repo, { kind: "commit", hash: "c3" }, true),
  );
  await settle();
  expect(mocks.api).toContainEqual(["repo.findCommit", 1, "c3"]);
  // Plain selection changes do not look the commit up.
  mocks.api = [];
  await act(async () => useRepoUiStore.getState().select(repo, { kind: "commit", hash: "c4" }));
  await settle();
  expect(mocks.api.filter(([m]) => m === "repo.findCommit")).toEqual([]);
});

it("comes back where it was after being replaced (e.g. by a diff)", async () => {
  mocks.rows = Array.from({ length: 200 }, (_, i) => commit(i));
  mocks.info = { version: 1, count: 200, complete: true, maxLanes: 1 };
  mocks.found = 150;
  await render();
  // A commit revealed from the sidebar is scrolled to once.
  await act(async () =>
    useRepoUiStore.getState().select(repo, { kind: "commit", hash: "c150" }, true),
  );
  await settle();
  expect(mocks.api.filter(([m]) => m === "repo.findCommit")).toHaveLength(1);
  // Then the user scrolls elsewhere.
  await act(async () => {
    scroller().scrollTop = 1234;
    scroller().dispatchEvent(new Event("scroll"));
  });
  await act(async () => root.unmount());
  root = createRoot(container);
  await render(null);
  expect(scroller().scrollTop).toBe(1234);
  expect(mocks.api.filter(([m]) => m === "repo.findCommit")).toHaveLength(1);
});

it("comes back where it was once a history that was not loaded yet arrives", async () => {
  mocks.rows = Array.from({ length: 200 }, (_, i) => commit(i));
  mocks.info = { version: 1, count: 200, complete: true, maxLanes: 1 };
  await render();
  await act(async () => {
    scroller().scrollTop = 1234;
    scroller().dispatchEvent(new Event("scroll"));
  });
  await act(async () => root.unmount());
  let release = () => {};
  mocks.infoGate = new Promise((r) => (release = r));
  root = createRoot(container);
  await render(null);
  // Nothing to scroll yet: the browser keeps it at the top.
  await act(async () => {
    scroller().scrollTop = 0;
  });
  release();
  await act(() =>
    vi.waitFor(() => {
      if (!container.textContent?.includes("Commit")) throw new Error("no rows");
    }),
  );
  await settle();
  expect(scroller().scrollTop).toBe(1234);
});

it("waits for the history to reach where it was, while it streams in", async () => {
  mocks.rows = Array.from({ length: 200 }, (_, i) => commit(i));
  mocks.info = { version: 1, count: 200, complete: true, maxLanes: 1 };
  await render();
  await act(async () => {
    scroller().scrollTop = 4000;
    scroller().dispatchEvent(new Event("scroll"));
  });
  await act(async () => root.unmount());
  // Back with only the first rows loaded: too few to reach the place.
  mocks.info = { version: 2, count: 20, complete: false, maxLanes: 1 };
  root = createRoot(container);
  await render(null);
  await act(async () => {
    scroller().scrollTop = 0;
  });
  const stream = (count: number, complete: boolean) =>
    act(async () => {
      client.setQueryData(keys.graphInfo(repo), { version: 2, count, complete, maxLanes: 1 });
      await new Promise((r) => setTimeout(r, 0));
    });
  await stream(60, false);
  expect(scroller().scrollTop).toBe(0);
  await stream(200, true);
  expect(scroller().scrollTop).toBe(4000);
});

it("does not take the user back after revealing a commit meanwhile", async () => {
  mocks.rows = Array.from({ length: 200 }, (_, i) => commit(i));
  mocks.info = { version: 1, count: 200, complete: true, maxLanes: 1 };
  await render();
  await act(async () => {
    scroller().scrollTop = 4000;
    scroller().dispatchEvent(new Event("scroll"));
  });
  await act(async () => root.unmount());
  mocks.info = { version: 2, count: 20, complete: false, maxLanes: 1 };
  root = createRoot(container);
  await render(null);
  // A branch picked in the sidebar.
  mocks.found = 5;
  await act(async () =>
    useRepoUiStore.getState().select(repo, { kind: "commit", hash: "c5" }, true),
  );
  await settle();
  const revealed = scroller().scrollTop;
  await act(async () => {
    client.setQueryData(keys.graphInfo(repo), {
      version: 2,
      count: 200,
      complete: true,
      maxLanes: 1,
    });
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(scroller().scrollTop).toBe(revealed);
  expect(revealed).toBeLessThan(4000);
});

it("keeps the place to go back to while the history is too short to reach it", async () => {
  mocks.rows = Array.from({ length: 200 }, (_, i) => commit(i));
  mocks.info = { version: 1, count: 200, complete: true, maxLanes: 1 };
  await render();
  await act(async () => {
    scroller().scrollTop = 4000;
    scroller().dispatchEvent(new Event("scroll"));
  });
  // Twice back with too short a history: the browser clamps, and a diff replaces it again.
  for (let i = 0; i < 2; i++) {
    await act(async () => root.unmount());
    mocks.info = { version: 2, count: 20, complete: false, maxLanes: 1 };
    root = createRoot(container);
    await render(null);
    await act(async () => {
      scroller().scrollTop = 200;
      scroller().dispatchEvent(new Event("scroll"));
    });
  }
  // A commit that is not in the history yet does not cancel going back either.
  mocks.found = -1;
  await act(async () =>
    useRepoUiStore.getState().select(repo, { kind: "commit", hash: "c199" }, true),
  );
  await settle();
  await act(async () => {
    client.setQueryData(keys.graphInfo(repo), {
      version: 2,
      count: 200,
      complete: true,
      maxLanes: 1,
    });
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(scroller().scrollTop).toBe(4000);
});

it("does not take the user back once they scrolled themselves", async () => {
  mocks.rows = Array.from({ length: 200 }, (_, i) => commit(i));
  mocks.info = { version: 1, count: 200, complete: true, maxLanes: 1 };
  await render();
  await act(async () => {
    scroller().scrollTop = 4000;
    scroller().dispatchEvent(new Event("scroll"));
  });
  await act(async () => root.unmount());
  mocks.info = { version: 2, count: 20, complete: false, maxLanes: 1 };
  root = createRoot(container);
  await render(null);
  await act(async () => {
    scroller().dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 10 }));
    scroller().scrollTop = 10;
  });
  await act(async () => {
    client.setQueryData(keys.graphInfo(repo), {
      version: 2,
      count: 200,
      complete: true,
      maxLanes: 1,
    });
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(scroller().scrollTop).toBe(10);
});

it("reveals a commit again when the graph went away before finding it", async () => {
  mocks.found = 3;
  let release = () => {};
  mocks.gate = new Promise((r) => (release = r));
  await render();
  await act(async () =>
    useRepoUiStore.getState().select(repo, { kind: "commit", hash: "c3" }, true),
  );
  // Replaced (e.g. by a diff) while the commit is looked up.
  await act(async () => root.unmount());
  release();
  await settle();
  mocks.gate = null;
  mocks.api = [];
  root = createRoot(container);
  await render();
  expect(mocks.api).toContainEqual(["repo.findCommit", 1, "c3"]);
});

it("shows loading, empty and error states", async () => {
  mocks.info = { version: 1, count: 0, complete: false, maxLanes: 0 };
  await render("Loading history…");
  mocks.info = { version: 2, count: 0, complete: true, maxLanes: 0 };
  await act(async () => root.unmount());
  root = createRoot(container);
  await render("No commits yet");
  expect(container.textContent).not.toContain("Loading");

  await act(async () => root.unmount());
  root = createRoot(container);
  mocks.infoError = new Error("bad repository");
  await render("bad repository");
  expect(container.querySelector(".text-destructive")?.textContent).toBe("bad repository");
});

it("shows progress while history is still streaming in", async () => {
  mocks.rows = Array.from({ length: 3 }, (_, i) => commit(i));
  mocks.info = { version: 1, count: 1234, complete: false, maxLanes: 2 };
  await render();
  // Rows that have not arrived yet are drawn as placeholders (the status bar shows progress).
  expect(container.querySelectorAll(".bg-muted\\/50").length).toBeGreaterThan(0);
});

it("resizes columns by dragging the header borders", async () => {
  await render();
  const header = container.querySelector<HTMLElement>(".h-7")!;
  const [refs, , , author] = [...header.children] as HTMLElement[];
  const before = Number.parseInt(refs!.style.width);
  const drag = async (cell: HTMLElement, dx: number) => {
    const handle = cell.querySelector<HTMLElement>(".cursor-col-resize")!;
    handle.setPointerCapture = () => {};
    const fire = (type: string, x: number) =>
      handle.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, pointerId: 1 }));
    await act(async () => {
      fire("pointerdown", 100);
      fire("pointermove", 100 + dx);
      fire("pointerup", 100 + dx);
      // Moves after release are ignored.
      fire("pointermove", 300);
    });
  };
  await drag(refs!, 30);
  expect(Number.parseInt(refs!.style.width)).toBe(before + 30);
  // Columns on the right grow when dragged to the left, down to a minimum.
  const authorBefore = Number.parseInt(author!.style.width);
  await drag(author!, -20);
  expect(Number.parseInt(author!.style.width)).toBe(authorBefore + 20);
  await drag(author!, 1000);
  expect(author!.style.width).toBe("40px");
  // Restore the defaults for other tests.
  await drag(refs!, -30);
  await drag(author!, 40 - authorBefore);
});

/** Drags a header cell's resize handle through `xs`, re-rendering between moves. */
const dragSteps = async (cell: HTMLElement, xs: number[]) => {
  const handle = cell.querySelector<HTMLElement>(".cursor-col-resize")!;
  handle.setPointerCapture = () => {};
  const fire = (type: string, x: number) =>
    handle.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, pointerId: 1 }));
  await act(async () => fire("pointerdown", 100));
  for (const x of xs) await act(async () => fire("pointermove", x));
  await act(async () => fire("pointerup", xs.at(-1)!));
};
const headerCells = () =>
  [...container.querySelector<HTMLElement>(".h-7")!.children] as HTMLElement[];
const width = (el: HTMLElement) => Number.parseInt(el.style.width);

it("follows the pointer through a drag instead of snapping back", async () => {
  await render();
  const refs = headerCells()[0]!;
  const before = width(refs);
  await dragSteps(refs, [110, 120, 130]);
  expect(width(headerCells()[0]!)).toBe(before + 30);
  await dragSteps(headerCells()[0]!, [90, 80, 70]);
  expect(width(headerCells()[0]!)).toBe(before);
});

it("fits the graph column to the rows on screen, not the widest point in history", async () => {
  // The history is 20 lanes wide somewhere, but the rows on screen use one lane.
  mocks.info = { version: 1, count: 5, complete: true, maxLanes: 20 };
  await render();
  expect(width(headerCells()[1]!)).toBe(6 * 2 + 3 * 16);
  // Nothing is cut: no shadow.
  expect(container.querySelectorAll('[class*="after:bg-linear-to-l"]')).toHaveLength(0);
});

it("fits the graph column to the lanes, up to a limit, and shades its edge when cut", async () => {
  // 20 lanes are more than the column grows to; one row uses lane 15.
  mocks.info = { version: 1, count: 5, complete: true, maxLanes: 20 };
  mocks.rows = Array.from({ length: 5 }, (_, i) =>
    commit(i, i === 2 ? { lane: 15, edges: [15, 1, 15, 2, 3] } : {}),
  );
  await render();
  const graph = () => headerCells()[1]!;
  const fitted = width(graph());
  expect(fitted).toBe(6 * 2 + 12 * 16);
  const shaded = [...container.querySelectorAll(`svg[height="28"]`)].map((svg) =>
    svg.parentElement!.className.includes("after:bg-linear-to-l"),
  );
  // One cut row shades the whole column's edge, but not the header.
  expect(shaded).toEqual([true, true, true, true, true]);
  expect(graph().className).not.toContain("after:bg-linear-to-l");

  // A resized column keeps its width; double-clicking the handle fits the lanes again.
  await dragSteps(graph(), [120, 140]);
  expect(width(graph())).toBe(fitted + 40);
  await act(async () => {
    graph()
      .querySelector(".cursor-col-resize")!
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  expect(width(graph())).toBe(fitted);
});

it("ignores wide rows rendered below the viewport", async () => {
  // 400px of viewport shows rows 0-14; row 20 is only rendered as overscan.
  mocks.info = { version: 1, count: 40, complete: true, maxLanes: 20 };
  mocks.rows = Array.from({ length: 40 }, (_, i) =>
    commit(i, i === 20 ? { lane: 15, edges: [15, 1, 15, 2, 3] } : {}),
  );
  await render();
  expect(container.textContent).toContain("Commit 20");
  expect(width(headerCells()[1]!)).toBe(6 * 2 + 3 * 16);
  expect(container.querySelectorAll('[class*="after:bg-linear-to-l"]')).toHaveLength(0);
});

it("selects several commits with the platform key and Shift", async () => {
  await render();
  const click = (text: string, init: MouseEventInit = {}) =>
    act(async () => {
      rowOf(text).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, ...init }));
    });
  const picked = () => {
    const s = selection();
    return s?.kind === "commits" ? s.commits.map((c) => [c.index, c.row.hash]) : s;
  };
  const highlighted = () =>
    ["Commit 0", "Commit 1", "Commit 2", "Commit 3", "Commit 4"].filter((t) =>
      rowOf(t).className.includes("bg-primary/25"),
    );

  await click("Commit 3");
  await click("Commit 1", { metaKey: true });
  // Newest first, whatever the order of the clicks.
  expect(picked()).toEqual([
    [1, "c1"],
    [3, "c3"],
  ]);
  expect(highlighted()).toEqual(["Commit 1", "Commit 3"]);
  await click("Commit 3", { metaKey: true });
  expect(selection()).toEqual({ kind: "commit", hash: "c1" });
  // Removing the last one keeps it.
  await click("Commit 1", { metaKey: true });
  expect(selection()).toEqual({ kind: "commit", hash: "c1" });

  // Shift selects from the commit last clicked.
  await click("Commit 4", { shiftKey: true });
  expect(picked()).toEqual([1, 2, 3, 4].map((i) => [i, `c${i}`]));
  await click("Commit 0", { shiftKey: true });
  expect(picked()).toEqual([
    [0, "c0"],
    [1, "c1"],
  ]);
  // Arrows go on from there with one commit; a plain click selects one too.
  await key("ArrowDown");
  expect(selection()).toEqual({ kind: "commit", hash: "c2" });
  await click("Commit 4", { metaKey: true });
  await click("Commit 0");
  expect(selection()).toEqual({ kind: "commit", hash: "c0" });
});

it("drops a multi-selection that comes back after the selection moved on", async () => {
  await render();
  const click = (text: string, init: MouseEventInit = {}) =>
    act(async () => {
      rowOf(text).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, ...init }));
    });
  // A commit that is not loaded has to be looked up first.
  let release = () => {};
  mocks.gate = new Promise((r) => (release = r));
  act(() => useRepoUiStore.getState().select(repo, { kind: "commit", hash: "far" }));
  await click("Commit 1", { metaKey: true });
  await click("Commit 3");
  await act(async () => release());
  await settle();
  expect(selection()).toEqual({ kind: "commit", hash: "c3" });
});

it("adds up platform-key clicks made while the selected commit is looked up", async () => {
  mocks.rows = Array.from({ length: 1000 }, (_, i) => commit(i));
  mocks.info = { version: 1, count: 1000, complete: true, maxLanes: 1 };
  mocks.found = 800;
  await render();
  const click = (text: string, init: MouseEventInit = {}) =>
    act(async () => {
      rowOf(text).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, ...init }));
    });
  const picked = () => {
    const s = selection();
    return s?.kind === "commits" ? s.commits.map((c) => c.row.hash) : s;
  };
  // The selected commit is off screen, not loaded: it has to be looked up first.
  const far = async () => {
    let release = () => {};
    mocks.gate = new Promise((r) => (release = r));
    act(() => useRepoUiStore.getState().select(repo, { kind: "commit", hash: "c800" }));
    return async () => {
      await act(async () => release());
      await settle();
    };
  };
  let release = await far();
  await click("Commit 1", { metaKey: true });
  await click("Commit 3", { metaKey: true });
  await release();
  expect(picked()).toEqual(["c1", "c3", "c800"]);

  // A plain click drops the clicks still pending, a later one starts from it.
  release = await far();
  await click("Commit 1", { metaKey: true });
  await click("Commit 3", { metaKey: true });
  await click("Commit 2");
  await click("Commit 4", { metaKey: true });
  await release();
  expect(picked()).toEqual(["c2", "c4"]);
});

it("finds commits picked before the graph reloaded where they are now", async () => {
  await render();
  // Picked when the graph had one commit less on top.
  const stale = (i: number) => ({ index: i - 1, row: commit(i) });
  act(() =>
    useRepoUiStore.getState().select(repo, {
      kind: "commits",
      commits: [stale(1), stale(2)],
      anchor: "c1",
      version: 0,
    }),
  );
  await act(async () => {
    rowOf("Commit 0").dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, metaKey: true }),
    );
  });
  await settle();
  expect(selection()).toEqual({
    kind: "commits",
    commits: [0, 1, 2].map((i) => ({ index: i, row: commit(i) })),
    anchor: "c0",
    version: 1,
  });
});

it("does not take indexes from rows of the graph before it reloaded", async () => {
  await render();
  const at = (...hashes: string[]) =>
    hashes.map((h) => ({
      index: mocks.rows.findIndex((r) => (r as GraphRow).hash === h),
      row: commit(Number(h.slice(1))),
    }));
  act(() =>
    useRepoUiStore.getState().select(repo, {
      kind: "commits",
      commits: at("c1", "c2"),
      anchor: "c1",
      version: 1,
    }),
  );
  // A new commit on top: until its rows arrive, the graph shows the previous ones.
  let release = () => {};
  mocks.rowsGate = new Promise((r) => (release = r));
  mocks.rows = [{ ...commit(9), hash: "x", subject: "New commit" }, ...mocks.rows];
  mocks.info = { version: 2, count: 6, complete: true, maxLanes: 1 };
  mocks.found = null;
  await act(() => client.invalidateQueries({ queryKey: keys.graphInfo(repo) }));
  await act(() => vi.waitFor(() => expect(mocks.api).toContainEqual(["repo.graphRows", 2, 0, 6])));
  expect(container.textContent).not.toContain("New commit");
  await act(async () => {
    rowOf("Commit 3").dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, metaKey: true }),
    );
  });
  await settle();
  expect(selection()).toEqual({
    kind: "commits",
    commits: at("c1", "c2", "c3"),
    anchor: "c3",
    version: 2,
  });
  await act(async () => release());
});
