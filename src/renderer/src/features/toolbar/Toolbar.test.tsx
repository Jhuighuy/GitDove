// @vitest-environment happy-dom
import type { RefsSnapshot, RepoInfo, WorkingStatus } from "@shared/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useBusyStore } from "@/stores/busy";
import { useLayout } from "@/stores/repo-ui";
import { Toolbar } from "./Toolbar";

const mocks = vi.hoisted(() => ({
  api: [] as unknown[][],
  commands: [] as unknown[][],
  info: null as unknown,
  refs: null as unknown,
  status: null as unknown,
}));

vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  api: async (method: string, ...args: unknown[]) => {
    mocks.api.push([method, ...args]);
    switch (method) {
      case "repo.info":
        return mocks.info;
      case "repo.refs":
        return mocks.refs;
      case "repo.status":
        return mocks.status;
      case "shell.openTerminal":
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
          void mocks.commands.push([command, ...args.slice(1)]),
    },
  ),
}));

const REPO = "local:/work/project";

const info = (extra: Partial<RepoInfo> = {}): RepoInfo =>
  ({
    id: REPO,
    location: { kind: "local", path: "/work/project" },
    name: "project",
    workTree: "/work/project",
    gitDir: "/work/project/.git",
    bare: false,
    head: { branch: "main", hash: "0123456789abcdef", detached: false },
    state: "clean",
    ...extra,
  }) as RepoInfo;

const refs = (extra: Partial<RefsSnapshot> = {}): RefsSnapshot => ({
  refs: [
    {
      name: "refs/heads/main",
      short: "main",
      kind: "branch",
      hash: "0123456789abcdef",
      upstream: "origin/main",
      ahead: 2,
      behind: 3,
      upstreamGone: false,
      isHead: true,
      remote: null,
    },
  ],
  stashes: [],
  remotes: [],
  worktrees: [],
  submodules: [],
  ...extra,
});

const clean: WorkingStatus = { staged: [], unstaged: [], conflicted: [], truncated: false };

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.api = [];
  mocks.commands = [];
  mocks.info = info();
  mocks.refs = refs();
  mocks.status = clean;
  useLayout.setState({ sidebar: true, details: true });
  useBusyStore.setState({ byRepo: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Toolbar repo={REPO} />
      </QueryClientProvider>,
    ),
  );
  await act(() =>
    vi.waitFor(() => {
      if (!container.textContent?.includes("project")) throw new Error("not loaded");
    }),
  );
  await act(async () => new Promise((r) => setTimeout(r, 0)));
}

const tool = (label: string) => {
  const el = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.querySelector("span")?.textContent === label,
  );
  if (!el) throw new Error(`No "${label}" button`);
  return el;
};
const click = (el: HTMLElement) => act(async () => el.click());
const chevrons = () =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].filter((b) =>
    b.className.includes("w-4"),
  );
const openMenu = async (index: number) => {
  const trigger = chevrons()[index]!;
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    trigger.click();
  });
};
const menuItem = (label: string) => {
  const el = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (e) => e.textContent?.trim() === label,
  );
  if (!el) throw new Error(`No "${label}" menu item`);
  return el;
};

it("shows the repository, its branch and ahead/behind counts", async () => {
  await render();
  expect(container.textContent).toContain("project");
  expect(container.querySelector("[title='/work/project']")?.textContent).toBe("project");
  expect(container.textContent).toContain("main");
  expect(tool("Pull").textContent).toBe("Pull3");
  expect(tool("Push").textContent).toBe("Push2");
  // Nothing to stash or pop.
  expect(tool("Stash").disabled).toBe(true);
  expect(tool("Pop").disabled).toBe(true);
  expect(tool("Branch").disabled).toBe(false);
});

it("shows the SSH host and a detached HEAD", async () => {
  mocks.info = info({
    location: { kind: "ssh", host: "fedora", path: "/home/me/project" },
    head: { branch: null, hash: "abcdef0123456789", detached: true },
  } as Partial<RepoInfo>);
  mocks.refs = refs({ refs: [] });
  await render();
  expect(container.textContent).toContain("fedora");
  expect(container.textContent).toContain("detached @ abcdef0");
  expect(tool("Pull").textContent).toBe("Pull");
});

it("shows a dash for an unborn branch and disables branching", async () => {
  mocks.info = info({ head: { branch: null, hash: null, detached: false } } as Partial<RepoInfo>);
  await render();
  expect(container.textContent).toContain("—");
  expect(tool("Branch").disabled).toBe(true);
});

it("runs repository commands", async () => {
  mocks.status = { ...clean, unstaged: [{ path: "a", kind: "modified" }] };
  mocks.refs = refs({
    stashes: [{ index: 0, name: "stash@{0}", hash: "s", message: "m", time: 0 }],
  });
  await render();
  for (const label of ["Pull", "Push", "Fetch", "Branch", "Stash", "Pop"]) await click(tool(label));
  expect(mocks.commands).toEqual([
    ["pull"],
    ["push"],
    ["fetch"],
    ["createBranch", "HEAD", "main"],
    ["stash"],
    ["pop"],
  ]);
  await click(tool("Terminal"));
  expect(mocks.api.at(-1)).toEqual(["shell.openTerminal", REPO]);
});

it("offers pull and push variants", async () => {
  await render();
  for (const label of ["Fetch all", "Pull (fast-forward only)", "Pull (merge)", "Pull (rebase)"]) {
    await openMenu(0);
    await click(menuItem(label));
  }
  for (const label of ["Push", "Force push (with lease)"]) {
    await openMenu(1);
    await click(menuItem(label));
  }
  expect(mocks.commands).toEqual([
    ["fetch"],
    ["pull", "ff-only"],
    ["pull", "merge"],
    ["pull", "rebase"],
    ["push"],
    ["push", true],
  ]);
});

it("toggles the sidebar and details panels", async () => {
  await render();
  const sidebar = container.querySelector<HTMLElement>("[title='Toggle sidebar']")!;
  const details = container.querySelector<HTMLElement>("[title='Toggle details panel']")!;
  await click(sidebar);
  expect(useLayout.getState().sidebar).toBe(false);
  expect(sidebar.className).toContain("text-muted-foreground");
  await click(details);
  expect(useLayout.getState().details).toBe(false);
  await click(sidebar);
  await click(details);
  expect(useLayout.getState()).toMatchObject({ sidebar: true, details: true });
});

it("shows the running operation and disables write actions meanwhile", async () => {
  mocks.status = { ...clean, unstaged: [{ path: "a", kind: "modified" }] };
  mocks.refs = refs({
    stashes: [{ index: 0, name: "stash@{0}", hash: "s", message: "m", time: 0 }],
  });
  await render();
  expect(container.querySelector("output")).toBeNull();

  await act(async () =>
    useBusyStore.getState().start(REPO, { label: "Checking out feature…", cancellable: false }),
  );
  expect(container.querySelector("output")?.textContent).toBe("Checking out feature…");
  expect(container.querySelector("[aria-label='Cancel']")).toBeNull();
  for (const label of ["Pull", "Push", "Fetch", "Branch", "Stash", "Pop"]) {
    expect(tool(label).disabled).toBe(true);
  }
  for (const chevron of chevrons()) {
    expect(chevron.disabled).toBe(true);
    expect(chevron.title).toBe("Checking out feature… Wait for it to finish.");
  }
  // Opening a terminal does not change the repository.
  expect(tool("Terminal").disabled).toBe(false);

  await act(async () => useBusyStore.getState().finish(REPO));
  expect(container.querySelector("output")).toBeNull();
  expect(tool("Pull").disabled).toBe(false);
});

it("cancels a running network operation", async () => {
  await render();
  await act(async () =>
    useBusyStore.getState().start(REPO, { label: "Pulling…", cancellable: true }),
  );
  await click(container.querySelector<HTMLElement>("[aria-label='Cancel']")!);
  expect(mocks.commands).toEqual([["cancel"]]);
});
