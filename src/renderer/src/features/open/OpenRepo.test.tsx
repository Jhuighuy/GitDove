// @vitest-environment happy-dom
import type { DirListing } from "@shared/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useStatusStore } from "@/stores/status";
import { useTabs } from "@/stores/tabs";
import {
  OpenRepoPage,
  RemoteRepoDialog,
  openLocation,
  pickLocalRepository,
  useOpenCommands,
  useRemoteDialog,
} from "./OpenRepo";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  listeners: new Map<string, (payload: unknown) => void>(),
  toast: { loading: vi.fn(() => "toast-id"), error: vi.fn(), dismiss: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {},
  modKey: "⌘",
  useEvent: (event: string, listener: (payload: unknown) => void) => {
    mocks.listeners.set(event, listener);
  },
  api: mocks.api,
}));

const { ApiError } = (await import("@/lib/api")) as unknown as {
  ApiError: new (message: string) => Error;
};

/** Directory listings by `host:path`. */
let listings: Record<string, DirListing | Error | "pending">;
let opened: unknown[];

let root: Root;
let container: HTMLElement;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  localStorage.clear();
  opened = [];
  listings = {
    "box:null": {
      path: "/home/me",
      entries: [
        { name: "proj", isDir: true, isRepo: true },
        { name: "docs", isDir: true, isRepo: false },
        { name: ".cache", isDir: true, isRepo: false },
      ],
    },
    "box:/home/me/docs": { path: "/home/me/docs", entries: [] },
    "box:/home": { path: "/home", entries: [{ name: "me", isDir: true, isRepo: false }] },
    "box:/": { path: "/", entries: [{ name: "home", isDir: true, isRepo: false }] },
  };
  listings["box:/home/me"] = listings["box:null"]!;
  mocks.api.mockImplementation(async (method: string, ...args: unknown[]) => {
    switch (method) {
      case "repo.open": {
        opened.push(args[0]);
        const loc = args[0] as { kind: string; host?: string; path: string };
        if (loc.path.includes("broken")) throw new ApiError("not a git repository");
        if (loc.path.includes("weird")) throw "weird failure";
        return { id: loc.kind === "ssh" ? `ssh://${loc.host}${loc.path}` : `local:${loc.path}` };
      }
      case "ssh.hosts":
        return ["box", "other"];
      case "ssh.listDir": {
        const l = listings[`${String(args[0])}:${String(args[1])}`];
        if (l === "pending") return new Promise(() => {});
        if (!l) throw new Error(`No such directory ${String(args[1])}`);
        if (l instanceof Error) throw l;
        return l;
      }
    }
    return undefined;
  });
  useTabs.setState({ tabs: [{ key: "blank", repo: null }], active: "blank", recent: [] });
  useRemoteDialog.setState({ open: false, tabKey: undefined });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const render = async (node: React.ReactNode) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>),
  );
  await flush();
};
const text = () => document.body.textContent ?? "";
const button = (label: string) => {
  const el = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.includes(label) || b.title === label,
  );
  if (!el) throw new Error(`No "${label}" button`);
  return el;
};
const item = (name: string) => {
  const el = [...document.querySelectorAll("li")].find((l) => l.textContent?.startsWith(name));
  if (!el) throw new Error(`No "${name}" item`);
  return el;
};
const click = async (el: HTMLElement) => {
  await act(async () => el.click());
  await flush();
};
const type = (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const submit = async (el: HTMLElement) => {
  await act(async () => {
    el.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await flush();
};
const listDirCalls = () =>
  mocks.api.mock.calls.filter(([m]) => m === "ssh.listDir").map(([, ...a]) => a);
const tabRepos = () => useTabs.getState().tabs.map((t) => t.repo);

it("opens locations in a tab, showing progress in the status bar", async () => {
  // The status bar shows what is happening while the repository opens.
  const seen: (string | null)[] = [];
  const unsubscribe = useStatusStore.subscribe((s) => seen.push(s.activities.at(-1)?.text ?? null));
  await expect(openLocation({ kind: "local", path: "/r" })).resolves.toBe(true);
  expect(tabRepos()).toEqual(["local:/r"]);

  await openLocation({ kind: "ssh", host: "box", path: "/s" }, "blank");
  unsubscribe();
  expect(seen).toEqual(["Opening repository…", null, "Connecting to box…", null]);
  expect(mocks.toast.loading).not.toHaveBeenCalled();
  // The given tab got a repository meanwhile: it is kept, and a new tab opens.
  expect(tabRepos()).toEqual(["local:/r", "ssh://box/s"]);
});

it("keeps showing a slower open when another one finishes first", async () => {
  const pending: Record<string, () => void> = {};
  mocks.api.mockImplementation(async (method: string, loc: { kind: string; path: string }) => {
    if (method !== "repo.open") return undefined;
    await new Promise<void>((r) => (pending[loc.path] = r));
    return { id: `local:${loc.path}` };
  });
  const activity = () => useStatusStore.getState().activities.at(-1)?.text ?? null;
  const slow = openLocation({ kind: "ssh", host: "far", path: "/slow" } as never);
  const fast = openLocation({ kind: "local", path: "/fast" });
  await vi.waitFor(() => expect(Object.keys(pending)).toHaveLength(2));
  pending["/fast"]!();
  await fast;
  expect(activity()).toBe("Connecting to far…");
  pending["/slow"]!();
  await slow;
  expect(activity()).toBeNull();
});

it("reports locations that fail to open", async () => {
  await expect(openLocation({ kind: "local", path: "/broken" })).resolves.toBe(false);
  expect(mocks.toast.error).toHaveBeenCalledWith("Could not open repository", {
    description: "not a git repository",
  });
  expect(useStatusStore.getState().activities).toEqual([]);
  await openLocation({ kind: "local", path: "/weird" });
  expect(mocks.toast.error).toHaveBeenLastCalledWith(
    "Could not open repository",
    expect.objectContaining({ description: "weird failure" }),
  );
  expect(tabRepos()).toEqual([null]);
});

it("opens a local repository picked in a dialog", async () => {
  await pickLocalRepository();
  expect(opened).toEqual([]);
  mocks.api.mockImplementationOnce(async () => "/picked");
  await pickLocalRepository("blank");
  expect(mocks.api).toHaveBeenCalledWith("dialog.pickDirectory");
  expect(opened).toEqual([{ kind: "local", path: "/picked" }]);
  expect(tabRepos()).toEqual(["local:/picked"]);
});

it("offers to open local and remote repositories", async () => {
  await render(<OpenRepoPage tabKey="blank" />);
  expect(text()).toContain("Open a repository to get started.");
  expect(text()).not.toContain("Recent");
  expect(button("Open local repository").textContent).toContain("⌘O");
  mocks.api.mockImplementationOnce(async () => "/picked");
  await click(button("Open local repository"));
  expect(opened).toEqual([{ kind: "local", path: "/picked" }]);

  await click(button("Open remote repository (SSH)"));
  expect(useRemoteDialog.getState()).toMatchObject({ open: true, tabKey: "blank" });
});

it("lists, opens and forgets recent repositories", async () => {
  useTabs.setState({ recent: ["local:/home/me/alpha", "ssh://box/srv/beta"] });
  await render(<OpenRepoPage tabKey="blank" />);
  expect(text()).toContain("Recent");
  expect(item("alpha").textContent).toBe("alpha/home/me/alpha");
  expect(item("beta").textContent).toBe("betabox:/srv/beta");

  await click(item("alpha").querySelector<HTMLElement>('[aria-label="Remove from recent"]')!);
  expect(useTabs.getState().recent).toEqual(["ssh://box/srv/beta"]);
  expect(opened).toEqual([]);

  await click(item("beta"));
  expect(opened).toEqual([{ kind: "ssh", host: "box", path: "/srv/beta" }]);
  expect(tabRepos()).toEqual(["ssh://box/srv/beta"]);
});

const showDialog = async (tabKey?: string) => {
  await render(<RemoteRepoDialog />);
  expect(text()).not.toContain("Open remote repository");
  await act(async () => useRemoteDialog.getState().show(tabKey));
  await flush();
  await flush();
};
const hostInput = () => document.querySelector<HTMLInputElement>("#ssh-host")!;
const pathInput = () => document.querySelector<HTMLInputElement>("input.font-mono")!;

it("browses the first configured host", async () => {
  await showDialog("blank");
  expect(text()).toContain("Open remote repository");
  expect(hostInput().value).toBe("box");
  expect(
    [...document.querySelectorAll("#ssh-hosts option")].map((o) => o.getAttribute("value")),
  ).toEqual(["box", "other"]);
  expect(listDirCalls()).toEqual([["box", null]]);
  expect(pathInput().value).toBe("/home/me");
  expect([...document.querySelectorAll("li")].map((l) => l.textContent)).toEqual([
    "projbrowse",
    "docs",
    ".cache",
  ]);
  expect(item(".cache").className).toContain("text-muted-foreground");
});

it("navigates folders and opens repositories", async () => {
  await showDialog("blank");
  await click(item("docs"));
  expect(listDirCalls().at(-1)).toEqual(["box", "/home/me/docs"]);
  expect(text()).toContain("Empty directory");
  await click(button("Parent directory"));
  expect(listDirCalls().at(-1)).toEqual(["box", "/home/me"]);
  expect(pathInput().value).toBe("/home/me");

  // "browse" enters a repository instead of opening it.
  await click(item("proj").querySelector("button")!);
  expect(listDirCalls().at(-1)).toEqual(["box", "/home/me/proj"]);
  expect(text()).toContain("No such directory /home/me/proj");
  expect(button("Open This Folder").disabled).toBe(true);

  // Typing a path and pressing Enter goes there.
  await type(pathInput(), " /home ");
  await submit(pathInput());
  expect(listDirCalls().at(-1)).toEqual(["box", "/home"]);
  await click(button("Parent directory"));
  expect(listDirCalls().at(-1)).toEqual(["box", "/"]);
  expect(button("Parent directory").disabled).toBe(true);
  // Listings are cached for a while.
  const count = listDirCalls().length;
  await click(item("home"));
  expect(pathInput().value).toBe("/home");
  expect(listDirCalls()).toHaveLength(count);
  await click(item("me"));
  await click(item("proj"));
  expect(opened).toEqual([{ kind: "ssh", host: "box", path: "/home/me/proj" }]);
  expect(tabRepos()).toEqual(["ssh://box/home/me/proj"]);
  expect(useRemoteDialog.getState().open).toBe(false);
  expect(localStorage.getItem("gitdove.lastSshHost")).toBe("box");
});

it("connects to another host", async () => {
  listings["other:null"] = new Error("Permission denied (publickey)");
  await showDialog();
  await type(hostInput(), "other");
  await submit(hostInput());
  expect(listDirCalls().at(-1)).toEqual(["other", null]);
  expect(text()).toContain("Permission denied (publickey)");
  // An empty host keeps browsing the default host.
  await type(hostInput(), "  ");
  await submit(hostInput());
  expect(hostInput().value).toBe("  ");
  expect(pathInput().value).toBe("/home/me");
});

it("remembers the last host", async () => {
  localStorage.setItem("gitdove.lastSshHost", "other");
  listings["other:null"] = "pending";
  await showDialog();
  expect(hostInput().value).toBe("other");
  expect(text()).toContain("Connecting to other…");
});

it("opens the current folder and keeps the dialog open on failure", async () => {
  listings["box:null"] = { path: "/srv/broken", entries: [] };
  await showDialog("blank");
  await click(button("Open This Folder"));
  expect(opened).toEqual([{ kind: "ssh", host: "box", path: "/srv/broken" }]);
  expect(useRemoteDialog.getState().open).toBe(true);
  expect(button("Open This Folder").disabled).toBe(false);
  await click(button("Cancel"));
  expect(useRemoteDialog.getState().open).toBe(false);
  expect(text()).not.toContain("Open remote repository");
});

it("handles the global open and tab commands", async () => {
  const Probe = () => {
    useOpenCommands();
    return null;
  };
  await render(<Probe />);
  const command = async (c: string) => {
    await act(async () => mocks.listeners.get("menu.command")!({ command: c }));
    await flush();
  };
  mocks.api.mockImplementationOnce(async () => "/picked");
  await command("open-repo");
  expect(tabRepos()).toEqual(["local:/picked"]);

  await command("open-remote-repo");
  // There is no blank tab to reuse now.
  expect(useRemoteDialog.getState()).toMatchObject({ open: true, tabKey: undefined });

  useTabs.setState({
    tabs: [
      { key: "a", repo: "local:/a" },
      { key: "b", repo: "local:/b" },
      { key: "c", repo: null },
    ],
    active: "a",
  });
  await command("next-tab");
  expect(useTabs.getState().active).toBe("b");
  await command("prev-tab");
  await command("prev-tab");
  expect(useTabs.getState().active).toBe("c");
  await command("open-remote-repo");
  expect(useRemoteDialog.getState().tabKey).toBe("c");
  await command("close-tab");
  expect(tabRepos()).toEqual(["local:/a", "local:/b"]);
  await command("refresh");
  expect(tabRepos()).toEqual(["local:/a", "local:/b"]);
  useTabs.setState({ active: null });
  await command("close-tab");
  expect(tabRepos()).toEqual(["local:/a", "local:/b"]);
});
