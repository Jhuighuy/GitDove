// @vitest-environment happy-dom
import type { FileChange, RepoInfo, WorkingStatus } from "@shared/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useBusyStore } from "@/stores/busy";
import { useRepoUiStore } from "@/stores/repo-ui";
import { WipPanel } from "./WipPanel";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  status: null as unknown,
  info: null as unknown,
  listeners: new Map<string, (payload: unknown) => void>(),
  commands: { abort: vi.fn(), continue: vi.fn(), discard: vi.fn() },
  toast: {
    loading: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  modKey: "⌘",
  useEvent: (event: string, listener: (payload: unknown) => void) => {
    mocks.listeners.set(event, listener);
  },
  api: mocks.api,
}));
vi.mock("../commands", () => ({ commands: mocks.commands }));

const file = (path: string, kind: FileChange["kind"] = "modified", oldPath?: string) =>
  ({ path, oldPath: oldPath ?? null, kind, additions: 1, deletions: 0, binary: false }) as const;

const status = (extra: Partial<WorkingStatus> = {}): WorkingStatus => ({
  staged: [file("staged.ts"), file("moved.ts", "renamed", "orig.ts")],
  unstaged: [file("src/edit.ts"), file("new.ts", "untracked")],
  conflicted: [],
  truncated: false,
  ...extra,
});

const info = (extra: Partial<RepoInfo> = {}): Partial<RepoInfo> => ({
  workTree: "/repo",
  head: { branch: "main", hash: "h", detached: false },
  state: "clean",
  ...extra,
});

let root: Root;
let container: HTMLElement;
let n = 0;
let repo: string;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  // Commit drafts are kept per repository: use a fresh one per test.
  repo = `local:/repo${++n}`;
  mocks.status = status();
  mocks.info = info();
  mocks.api.mockImplementation(async (method: string) => {
    if (method === "repo.status") return mocks.status;
    if (method === "repo.info") return mocks.info;
    if (method === "repo.lastCommitMessage") return "Previous summary\n\nPrevious body\nline 2";
    return undefined;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render() {
  // A fresh root per render, so queries start over.
  await act(async () => root.unmount());
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <WipPanel repo={repo} />
      </QueryClientProvider>,
    ),
  );
  await act(async () => new Promise((r) => setTimeout(r, 0)));
}

const text = () => container.textContent ?? "";
const button = (label: string) => {
  const el = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith(label),
  );
  if (!el) throw new Error(`No "${label}" button`);
  return el;
};
const row = (path: string) => {
  const el = container.querySelector<HTMLElement>(`li[title="${path}"]`);
  if (!el) throw new Error(`No row ${path}`);
  return el;
};
/** The n-th hover action of a file row. */
const rowAction = (path: string, i: number) => row(path).querySelectorAll("button")[i]!;
const click = (el: HTMLElement) => act(async () => el.click());
const apiCalls = (method: string) =>
  mocks.api.mock.calls.filter(([m]) => m === method).map(([, ...args]) => args);
const ui = () => useRepoUiStore.getState().byRepo[repo];

/** Sets a controlled input's value the way typing does. */
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const summary = () => container.querySelector<HTMLInputElement>("input[placeholder]")!;
const description = () => container.querySelector("textarea")!;
const amend = () => container.querySelector<HTMLElement>('[role="checkbox"]')!;
// Clicks the label: in happy-dom, clicking the checkbox itself toggles it twice.
const toggleAmend = () => click(container.querySelector("label")!);

it("summarizes the changes and the branch", async () => {
  await render();
  expect(text()).toContain("4 file changes");
  expect(text()).toContain("main");
  expect(text()).toContain("Unstaged Files(2)");
  expect(text()).toContain("Staged Files(2)");
  expect(text()).not.toContain("Conflicts");
  expect(text()).not.toContain("in progress");

  mocks.status = status({ staged: [file("a")], unstaged: [] });
  mocks.info = info({ head: { branch: null, hash: "h", detached: true } });
  await render();
  expect(text()).toContain("1 file change");
  expect(text()).toContain("detached HEAD");
  expect(() => button("Stage All")).toThrow();
});

it("shows a dash before the repository info is known", async () => {
  mocks.info = info({ head: { branch: null, hash: null, detached: false } });
  await render();
  expect(text()).toContain("on—");
});

it("opens diffs of unstaged, untracked and staged files", async () => {
  await render();
  await click(row("src/edit.ts"));
  expect(ui()?.diff).toEqual({ kind: "unstaged", path: "src/edit.ts", untracked: false });
  expect(row("src/edit.ts").className).toContain("bg-primary/25");
  await click(row("new.ts"));
  expect(ui()?.diff).toEqual({ kind: "unstaged", path: "new.ts", untracked: true });
  await click(row("orig.ts → moved.ts"));
  expect(ui()?.diff).toEqual({ kind: "staged", path: "moved.ts", oldPath: "orig.ts" });
  await click(row("staged.ts"));
  expect(ui()?.diff).toEqual({ kind: "staged", path: "staged.ts" });
  expect(row("staged.ts").className).toContain("bg-primary/25");
  expect(row("src/edit.ts").className).not.toContain("bg-primary/25");
});

it("stages, unstages and discards files", async () => {
  await render();
  await click(rowAction("src/edit.ts", 1));
  expect(apiCalls("repo.stage")).toEqual([[repo, ["src/edit.ts"]]]);
  // Row actions do not open the file.
  expect(ui()?.diff ?? null).toBeNull();
  await click(rowAction("staged.ts", 0));
  expect(apiCalls("repo.unstage")).toEqual([[repo, ["staged.ts"]]]);
  await click(rowAction("src/edit.ts", 0));
  await click(rowAction("new.ts", 0));
  expect(mocks.commands.discard.mock.calls).toEqual([
    [repo, ["src/edit.ts"], []],
    [repo, [], ["new.ts"]],
  ]);
  await click(button("Stage All"));
  await click(button("Unstage All"));
  expect(apiCalls("repo.stageAll")).toEqual([[repo]]);
  expect(apiCalls("repo.unstageAll")).toEqual([[repo]]);
});

it("disables staging, discarding and committing while another operation runs", async () => {
  mocks.info = info({ state: "merging" });
  await render();
  await type(summary(), "Summary");
  await act(async () =>
    useBusyStore.getState().start(repo, { label: "Pulling…", cancellable: true }),
  );
  const reason = "Pulling… Wait for it to finish.";
  for (const el of [
    rowAction("src/edit.ts", 0),
    rowAction("src/edit.ts", 1),
    rowAction("staged.ts", 0),
  ]) {
    expect(el.disabled).toBe(true);
  }
  for (const label of ["Stage All", "Unstage All", "Abort", "Continue", "Commit Changes"]) {
    expect(button(label).disabled).toBe(true);
    // Disabled buttons get no pointer events: a wrapper explains why.
    expect(button(label).parentElement!.title).toBe(reason);
  }
  // Clicking a disabled action (its tooltip wrapper gets the click) doesn't open the file.
  await click(rowAction("staged.ts", 0).parentElement!);
  expect(ui()?.diff ?? null).toBeNull();
  // Browsing still works.
  await click(row("src/edit.ts"));
  expect(ui()?.diff).toEqual({ kind: "unstaged", path: "src/edit.ts", untracked: false });
  // The keyboard shortcut does not commit either.
  await act(async () =>
    summary().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
    ),
  );
  expect(apiCalls("repo.commit")).toEqual([]);

  await act(async () => useBusyStore.getState().finish(repo));
  expect(rowAction("src/edit.ts", 1).disabled).toBe(false);
  expect(button("Commit Changes").disabled).toBe(false);
});

it("collapses sections", async () => {
  await render();
  const trigger = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith("Unstaged Files"),
  )!;
  await click(trigger);
  expect(container.querySelector('li[title="src/edit.ts"]')).toBeNull();
  expect(container.querySelector('li[title="staged.ts"]')).not.toBeNull();
});

it("shows conflicts and the operation in progress", async () => {
  mocks.status = status({ conflicted: [file("both.ts", "conflicted")] });
  mocks.info = info({ state: "cherry-picking" });
  await render();
  expect(text()).toContain("Conflicts(1)");
  expect(text()).toContain("cherry picking in progress");
  expect(button("Continue").disabled).toBe(true);
  await click(rowAction("both.ts", 0));
  expect(apiCalls("repo.stage")).toEqual([[repo, ["both.ts"]]]);
  await click(row("both.ts"));
  expect(ui()?.diff).toEqual({ kind: "unstaged", path: "both.ts", untracked: false });
  await click(button("Abort"));
  expect(mocks.commands.abort).toHaveBeenCalledWith(repo);

  mocks.status = status();
  await render();
  expect(button("Continue").disabled).toBe(false);
  await click(button("Continue"));
  expect(mocks.commands.continue).toHaveBeenCalledWith(repo);
});

it("limits long file lists", async () => {
  mocks.status = status({ unstaged: [], truncated: true });
  await render();
  expect(text()).toContain("Too many changes to list them all.");

  mocks.status = status({
    staged: Array.from({ length: 3002 }, (_, i) => file(`f${i}`)),
    unstaged: [],
  });
  await render();
  expect(text()).toContain("…and 2 more");
  expect(container.querySelectorAll("li")).toHaveLength(3000);
});

it("commits staged changes with a summary and description", async () => {
  await render();
  const commit = () => button("Commit Changes");
  expect(button("Commit Changes to 2 Files").disabled).toBe(true);
  await type(summary(), "  Fix the bug ");
  expect(commit().disabled).toBe(false);
  expect(text()).toContain(String(72 - "  Fix the bug ".length));
  await type(description(), " Details here. ");
  await click(commit());
  expect(apiCalls("repo.commit")).toEqual([
    [repo, "Fix the bug\n\nDetails here.", { amend: false }],
  ]);
  // The draft is cleared after committing.
  expect(summary().value).toBe("");
  expect(description().value).toBe("");
});

it("commits with the keyboard and keeps the draft when committing fails", async () => {
  mocks.status = status({ staged: [file("a")] });
  await render();
  expect(button("Commit Changes to 1 File")).toBeDefined();
  await type(summary(), "Summary only");
  // Plain Enter does not commit.
  await act(async () => {
    summary().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(apiCalls("repo.commit")).toEqual([]);
  mocks.api.mockImplementationOnce(async () => {
    throw new Error("hook failed");
  });
  await act(async () => {
    description().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
    );
  });
  expect(mocks.api).toHaveBeenCalledWith("repo.commit", repo, "Summary only", { amend: false });
  expect(mocks.toast.error).toHaveBeenCalledWith(
    "Commit failed",
    expect.objectContaining({ description: "hook failed" }),
  );
  expect(summary().value).toBe("Summary only");
  await act(async () => {
    summary().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
    );
  });
  expect(apiCalls("repo.commit")).toHaveLength(2);
  expect(summary().value).toBe("");
});

it("does not commit without staged changes or a summary", async () => {
  mocks.status = status({ staged: [] });
  await render();
  expect(button("Stage Changes to Commit").disabled).toBe(true);
  await type(summary(), "x".repeat(80));
  // Over-long summaries count below zero.
  expect(text()).toContain("-8");
  expect(container.querySelector(".text-destructive")?.textContent).toBe("-8");
  await act(async () => {
    summary().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
    );
  });
  expect(apiCalls("repo.commit")).toEqual([]);
});

it("amends with the previous message prefilled", async () => {
  mocks.status = status({ staged: [] });
  await render();
  await toggleAmend();
  expect(amend().getAttribute("aria-checked")).toBe("true");
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  expect(apiCalls("repo.lastCommitMessage")).toEqual([[repo]]);
  expect(summary().value).toBe("Previous summary");
  expect(description().value).toBe("Previous body\nline 2");
  await click(button("Amend Previous Commit"));
  expect(apiCalls("repo.commit")).toEqual([
    [repo, "Previous summary\n\nPrevious body\nline 2", { amend: true }],
  ]);
  expect(amend().getAttribute("aria-checked")).toBe("false");
});

it("needs a summary to amend, also when the previous message is unavailable", async () => {
  mocks.status = status({ staged: [] });
  mocks.api.mockImplementation(async (method: string) => {
    if (method === "repo.status") return mocks.status;
    if (method === "repo.info") return mocks.info;
    if (method === "repo.lastCommitMessage") throw new Error("no commits");
    return undefined;
  });
  await render();
  await toggleAmend();
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  expect(apiCalls("repo.lastCommitMessage")).toEqual([[repo]]);
  expect(summary().value).toBe("");
  expect(button("Amend Previous Commit").disabled).toBe(true);
  await type(summary(), "Reworded");
  expect(button("Amend Previous Commit").disabled).toBe(false);
  await click(button("Amend Previous Commit"));
  expect(apiCalls("repo.commit")).toEqual([[repo, "Reworded", { amend: true }]]);
});

it("keeps what was typed while the previous message was loading", async () => {
  let resolve!: (msg: string) => void;
  mocks.api.mockImplementation(async (method: string) => {
    if (method === "repo.status") return mocks.status;
    if (method === "repo.info") return mocks.info;
    if (method === "repo.lastCommitMessage") return new Promise<string>((r) => (resolve = r));
    return undefined;
  });
  await render();
  await toggleAmend();
  await type(summary(), "Typed meanwhile");
  await act(async () => resolve("Previous summary\n\nPrevious body"));
  expect(summary().value).toBe("Typed meanwhile");
  expect(description().value).toBe("");
});

it("keeps a typed message when switching to amend", async () => {
  await render();
  await type(summary(), "Mine");
  await toggleAmend();
  expect(amend().getAttribute("aria-checked")).toBe("true");
  expect(apiCalls("repo.lastCommitMessage")).toEqual([]);
  expect(summary().value).toBe("Mine");
});

it("focuses the summary from the menu", async () => {
  await render();
  mocks.listeners.get("menu.command")!({ command: "fetch" });
  expect(document.activeElement).not.toBe(summary());
  mocks.listeners.get("menu.command")!({ command: "commit-focus" });
  expect(document.activeElement).toBe(summary());
});
