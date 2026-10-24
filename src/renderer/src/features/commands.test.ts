// @vitest-environment happy-dom
import type { DiffTarget, Ref, RefsSnapshot, RepoInfo } from "@shared/domain";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  prompt: vi.fn(),
  confirm: vi.fn(),
  openLocation: vi.fn(),
  toast: Object.assign(vi.fn(), {
    loading: vi.fn(() => "t"),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
    warning: vi.fn(),
  }),
}));
vi.mock("@/lib/api", () => ({
  api: mocks.api,
  ApiError: Error,
  useEvent: () => {},
  isMac: true,
  modKey: "⌘",
  platform: "darwin",
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("./dialogs/dialogs", () => ({
  prompt: mocks.prompt,
  confirm: mocks.confirm,
  validateRefName: () => null,
}));
vi.mock("./open/OpenRepo", () => ({ openLocation: mocks.openLocation }));

const { commands } = await import("./commands");
const { keys, queryClient } = await import("@/lib/queries");
const { useRepoUiStore } = await import("@/stores/repo-ui");
const { useBusyStore } = await import("@/stores/busy");
const { APP, useStatusStore } = await import("@/stores/status");
const { useTabs } = await import("@/stores/tabs");

const repo = "local:/work/repo";
/** The status bar's notice for the repository (or the app). */
const noticeText = (scope = repo) => useStatusStore.getState().notices[scope]?.text;

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

const main = ref("refs/heads/main", { isHead: true, upstream: "refs/remotes/origin/main" });
const topic = ref("refs/heads/topic");
const originMain = ref("refs/remotes/origin/main");
const originFeature = ref("refs/remotes/origin/feature/x");
const tag = ref("refs/tags/v1");

const remote = (name: string) => ({ name, fetchUrl: `git@x:${name}`, pushUrl: "" });
const setRefs = (refs: Ref[], remotes = [remote("upstream"), remote("origin")]) =>
  queryClient.setQueryData<RefsSnapshot>(keys.refs(repo), {
    refs,
    stashes: [],
    remotes,
    worktrees: [],
    submodules: [],
    owners: { byRef: {}, people: {}, me: { email: null, name: null } },
  });
const setInfo = (workTree: string) =>
  queryClient.setQueryData<Partial<RepoInfo>>(keys.info(repo), { workTree });

/** Calls of one api method, without the method name. */
const apiCalls = (method: string) =>
  mocks.api.mock.calls.filter(([m]) => m === method).map(([, ...args]) => args);
/** Which mutating api methods were called. */
const methods = () => mocks.api.mock.calls.map(([m]) => m as string);

beforeEach(() => {
  vi.clearAllMocks();
  useStatusStore.setState({ notices: {}, activities: [] });
  useTabs.setState({ tabs: [{ key: "t", repo }], active: "t" });
  queryClient.clear();
  mocks.api.mockResolvedValue(undefined);
  mocks.confirm.mockResolvedValue(true);
  setRefs([main, topic, originMain, originFeature, tag]);
  setInfo("/work/repo");
});

it("creates an annotated tag when a message is given", async () => {
  mocks.prompt.mockResolvedValue({ value: "v1.0.0", checked: false, details: "Release notes" });
  await commands.createTag("local:/repo", "abc123");
  expect(mocks.prompt).toHaveBeenCalledWith(
    expect.objectContaining({ details: expect.objectContaining({ label: "Message (optional)" }) }),
  );
  expect(mocks.api).toHaveBeenCalledWith(
    "repo.createTag",
    "local:/repo",
    "v1.0.0",
    "abc123",
    "Release notes",
  );
});

it("creates a lightweight tag without a message", async () => {
  mocks.prompt.mockResolvedValue({ value: "v1.0.0", checked: false, details: "" });
  await commands.createTag("local:/repo", "abc123");
  expect(mocks.api).toHaveBeenCalledWith("repo.createTag", "local:/repo", "v1.0.0", "abc123", null);
});

it("does nothing when the dialog is cancelled", async () => {
  mocks.prompt.mockResolvedValue(null);
  await commands.createTag("local:/repo", "abc123");
  expect(mocks.api.mock.calls.filter(([m]) => m === "repo.createTag")).toHaveLength(0);
});

it("runs simple commands with their api calls", async () => {
  const cases: [() => Promise<unknown>, string, unknown[]][] = [
    [() => commands.fetch(repo), "repo.fetch", [repo, null]],
    [() => commands.pull(repo), "repo.pull", [repo, "ff-only"]],
    [() => commands.pull(repo, "rebase"), "repo.pull", [repo, "rebase"]],
    [() => commands.stash(repo), "repo.stash", [repo, null, true]],
    // The latest stash, whichever it is, or a given one, checked by its hash.
    [() => commands.pop(repo), "repo.stashPop", [repo, 0, undefined]],
    [() => commands.pop(repo, { index: 2, hash: "s2" }), "repo.stashPop", [repo, 2, "s2"]],
    [() => commands.applyStash(repo, { index: 1, hash: "s1" }), "repo.stashApply", [repo, 1, "s1"]],
    [() => commands.checkout(repo, "topic"), "repo.checkout", [repo, "topic"]],
    [() => commands.cherryPick(repo, ["0123456789"]), "repo.cherryPick", [repo, ["0123456789"]]],
    [() => commands.revert(repo, ["0123456789"]), "repo.revert", [repo, ["0123456789"]]],
    [() => commands.cherryPick(repo, ["c2", "c1"]), "repo.cherryPick", [repo, ["c2", "c1"]]],
    [() => commands.revert(repo, ["c2", "c1"]), "repo.revert", [repo, ["c2", "c1"]]],
    [() => commands.stageAll(repo), "repo.stageAll", [repo]],
    [() => commands.abort(repo), "repo.abortOperation", [repo]],
    [() => commands.continue(repo), "repo.continueOperation", [repo]],
    [() => commands.pruneWorktrees(repo), "repo.pruneWorktrees", [repo]],
    [() => commands.updateSubmodule(repo, "lib/x"), "repo.updateSubmodule", [repo, "lib/x"]],
    [() => commands.fetchRemote(repo, "upstream"), "repo.fetch", [repo, "upstream"]],
  ];
  for (const [run, method, args] of cases) {
    mocks.api.mockClear();
    await run();
    expect(apiCalls(method)).toEqual([args]);
  }
});

it("reports results in the status bar, not in toasts", async () => {
  await commands.fetch(repo);
  expect(noticeText()).toBeUndefined();
  await commands.cherryPick(repo, ["0123456789"]);
  expect(noticeText()).toBe("Cherry-picked 0123456");
  await commands.revert(repo, ["abcdef0123"]);
  expect(noticeText()).toBe("Reverted abcdef0");
  await commands.cherryPick(repo, ["c3", "c2", "c1"]);
  expect(noticeText()).toBe("Cherry-picked 3 commits");
  await commands.revert(repo, ["c2", "c1"]);
  expect(noticeText()).toBe("Reverted 2 commits");
  await commands.stash(repo);
  expect(noticeText()).toBe("Changes stashed");
  await commands.updateSubmodule(repo, "lib/x");
  expect(noticeText()).toBe("Updated lib/x");
  for (const kind of ["loading", "success", "dismiss"] as const) {
    expect(mocks.toast[kind]).not.toHaveBeenCalled();
  }
});

it("reports failures as error toasts", async () => {
  mocks.api.mockRejectedValue(new Error("could not resolve host"));
  await expect(commands.pull(repo)).resolves.toEqual({ ok: false });
  expect(mocks.toast.error).toHaveBeenCalledWith("Pull failed", {
    description: "could not resolve host",
    duration: 10000,
    action: expect.objectContaining({ label: "Copy" }),
  });
  expect(noticeText()).toBeUndefined();
  mocks.prompt.mockResolvedValue({ value: "b", checked: true });
  await commands.createBranch(repo, "abc");
  expect(mocks.toast.error).toHaveBeenLastCalledWith(
    "Create branch failed",
    expect.objectContaining({ description: "could not resolve host" }),
  );
});

it("does not open dialogs or start commands while another operation runs", async () => {
  useBusyStore.getState().start(repo, { label: "Pulling…", cancellable: true });
  try {
    await commands.merge(repo, "topic");
    await commands.createBranch(repo, "HEAD");
    await commands.push(repo);
    await commands.checkout(repo, "topic");
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.api).not.toHaveBeenCalled();
    expect(mocks.toast.warning).toHaveBeenCalledWith("Cannot merge now", {
      description: "Pulling… Wait for it to finish.",
    });
    expect(mocks.toast.warning).toHaveBeenCalledTimes(4);
  } finally {
    useBusyStore.getState().finish(repo);
  }
});

it("cancels the running operation", async () => {
  commands.cancel(repo);
  expect(apiCalls("repo.cancel")).toEqual([[repo]]);
  mocks.api.mockRejectedValueOnce(new Error("gone"));
  commands.cancel(repo);
  await vi.waitFor(() =>
    expect(mocks.toast.error).toHaveBeenCalledWith("Cancel failed", { description: "gone" }),
  );
});

it("confirms aborting a merge or rebase", async () => {
  mocks.confirm.mockResolvedValueOnce(false);
  await commands.abort(repo);
  expect(mocks.confirm).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Abort?", destructive: true }),
  );
  expect(methods()).toEqual([]);
});

it("labels the busy state with the operation and its target", async () => {
  const labels: (string | undefined)[] = [];
  mocks.api.mockImplementation(async () => {
    labels.push(useBusyStore.getState().byRepo[repo]?.label);
  });
  await commands.checkout(repo, "topic");
  await commands.checkout(repo, "0123456789abcdef0123456789abcdef01234567");
  await commands.merge(repo, "topic");
  await commands.checkout(repo, "refs/tags/v1");
  await commands.merge(repo, "refs/remotes/origin/main");
  await commands.rebase(repo, "refs/heads/topic");
  expect(labels).toEqual([
    "Checking out topic…",
    "Checking out 0123456…",
    "Merging topic…",
    // Full ref names are shown short.
    "Checking out v1…",
    "Merging origin/main…",
    "Rebasing onto topic…",
  ]);
});

it("pushes the current branch", async () => {
  await commands.push(repo);
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(apiCalls("repo.push")).toEqual([[repo, { force: false, setUpstream: false }]]);
  expect(noticeText()).toBe("Pushed main");
});

it("refuses to push without a checked out branch", async () => {
  setRefs([{ ...main, isHead: false }]);
  await commands.push(repo);
  expect(mocks.toast.error).toHaveBeenCalledWith("Push failed", {
    description: "No branch is checked out",
  });
  expect(methods()).toEqual([]);
});

it("asks to set the upstream when pushing a branch without one", async () => {
  setRefs([{ ...main, upstream: null }]);
  mocks.confirm.mockResolvedValueOnce(false);
  await commands.push(repo);
  expect(mocks.confirm).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Push main?", confirmLabel: "Push" }),
  );
  expect(methods()).toEqual([]);

  await commands.push(repo);
  expect(apiCalls("repo.push")).toEqual([[repo, { force: false, setUpstream: true }]]);

  // A gone upstream is set again too.
  mocks.api.mockClear();
  setRefs([{ ...main, upstreamGone: true }]);
  await commands.push(repo);
  expect(mocks.confirm).toHaveBeenLastCalledWith(
    expect.objectContaining({
      description:
        "The upstream branch of “main” no longer exists. Push it and set the upstream to origin/main?",
    }),
  );
  expect(apiCalls("repo.push")).toEqual([[repo, { force: false, setUpstream: true }]]);
});

it("names the remote that a new upstream is set on, and needs one", async () => {
  setRefs([{ ...main, upstream: null }], [remote("fork")]);
  mocks.confirm.mockResolvedValueOnce(false);
  await commands.push(repo);
  expect(mocks.confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      description: "“main” has no upstream branch. Push it and set the upstream to fork/main?",
    }),
  );
  setRefs([{ ...main, upstream: null }], []);
  await commands.push(repo);
  expect(mocks.toast.error).toHaveBeenCalledWith("Push failed", {
    description: "No remotes configured",
  });
  expect(methods()).toEqual([]);
});

it("names the remote that main pushes to, e.g. remote.pushDefault", async () => {
  queryClient.setQueryData<RefsSnapshot>(keys.refs(repo), (old) => ({
    ...old!,
    refs: [{ ...main, upstream: null }],
    pushRemote: "upstream",
  }));
  mocks.confirm.mockResolvedValueOnce(false);
  await commands.push(repo);
  expect(mocks.confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      description: "“main” has no upstream branch. Push it and set the upstream to upstream/main?",
    }),
  );
});

it("confirms force pushes", async () => {
  mocks.confirm.mockResolvedValueOnce(false);
  await commands.push(repo, true);
  expect(mocks.confirm).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Force push main?", destructive: true }),
  );
  expect(methods()).toEqual([]);
  await commands.push(repo, true);
  expect(apiCalls("repo.push")).toEqual([[repo, { force: true, setUpstream: false }]]);
});

it("pushes and pulls other branches without checking them out", async () => {
  await commands.pushBranch(repo, topic);
  expect(apiCalls("repo.pushBranch")).toEqual([[repo, "topic", false]]);
  expect(noticeText()).toBe("Pushed topic");
  await commands.pullBranch(repo, topic);
  expect(apiCalls("repo.fastForwardBranch")).toEqual([[repo, "topic"]]);
  expect(noticeText()).toBe("Updated topic");

  mocks.api.mockClear();
  await commands.pushBranch(repo, main);
  await commands.pullBranch(repo, main);
  expect(methods()).toEqual(["repo.push", "repo.pull"]);
});

it("confirms dropping a stash", async () => {
  mocks.confirm.mockResolvedValueOnce(false);
  await commands.dropStash(repo, { index: 3, hash: "s3" });
  expect(mocks.confirm).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Delete stash@{3}?", destructive: true }),
  );
  expect(methods()).toEqual([]);
  await commands.dropStash(repo, { index: 3, hash: "s3" });
  expect(apiCalls("repo.stashDrop")).toEqual([[repo, 3, "s3"]]);
});

it("goes back to the graph from a stash that is gone", async () => {
  const stash = (index: number) => ({
    index,
    name: `stash@{${index}}`,
    hash: `s${index}`,
    message: "WIP",
    time: 0,
  });
  const setStashes = (stashes: ReturnType<typeof stash>[]) =>
    queryClient.setQueryData<RefsSnapshot>(keys.refs(repo), (r) => ({ ...r!, stashes }));
  setStashes([stash(0), stash(1)]);
  const ui = () => useRepoUiStore.getState().byRepo[repo]!;
  const diffOf = (hash: string) => ({ kind: "commit" as const, hash, path: "a.ts" });
  // The refs are refreshed before the action ends.
  mocks.api.mockImplementation(async (method: string) => {
    if (method === "repo.stashDrop") setStashes([stash(0)]);
    if (method === "repo.stashPop") setStashes([]);
  });

  useRepoUiStore.getState().select(repo, { kind: "commit", hash: "s1" });
  useRepoUiStore.getState().openDiff(repo, diffOf("s1"));
  await commands.dropStash(repo, { index: 1, hash: "s1" });
  expect(ui().selection).toBeNull();
  expect(ui().diff).toBeNull();

  // A pop that keeps the stash (e.g. on conflicts) stays on it.
  mocks.api.mockImplementationOnce(async () => {});
  useRepoUiStore.getState().select(repo, { kind: "commit", hash: "s0" });
  await commands.pop(repo);
  expect(ui().selection).toEqual({ kind: "commit", hash: "s0" });
  // Popping the latest stash, which is s0.
  useRepoUiStore.getState().openDiff(repo, diffOf("s0"));
  await commands.pop(repo);
  expect(ui().selection).toBeNull();
  expect(ui().diff).toBeNull();

  // A refresh that lands after the action ended (it waits for so long only).
  setStashes([stash(0)]);
  mocks.api.mockImplementationOnce(async () => {});
  useRepoUiStore.getState().select(repo, { kind: "commit", hash: "s0" });
  await commands.dropStash(repo, { index: 0, hash: "s0" });
  expect(ui().selection).toEqual({ kind: "commit", hash: "s0" });
  setStashes([]);
  expect(ui().selection).toBeNull();
  // Only that refresh counts.
  useRepoUiStore.getState().select(repo, { kind: "commit", hash: "s0" });
  setStashes([]);
  expect(ui().selection).toEqual({ kind: "commit", hash: "s0" });
});

it("goes back to the graph from working tree changes that are gone", async () => {
  const ui = () => useRepoUiStore.getState().byRepo[repo]!;
  const open = (diff: DiffTarget) => useRepoUiStore.getState().openDiff(repo, diff);
  useRepoUiStore.getState().select(repo, { kind: "wip" });

  open({ kind: "staged", path: "a.ts" });
  await commands.stash(repo);
  expect(ui().diff).toBeNull();

  // Discarding other files, or the unstaged changes of a staged one, keeps the diff.
  open({ kind: "unstaged", path: "a.ts" });
  await commands.discard(repo, ["b.ts"], []);
  expect(ui().diff).toEqual({ kind: "unstaged", path: "a.ts" });
  await commands.discard(repo, ["a.ts"], []);
  expect(ui().diff).toBeNull();
  open({ kind: "staged", path: "a.ts" });
  await commands.discard(repo, ["a.ts"], []);
  expect(ui().diff).toEqual({ kind: "staged", path: "a.ts" });

  await commands.discardAll(repo);
  expect(ui().diff).toBeNull();
  // A failed action leaves it.
  open({ kind: "unstaged", path: "a.ts" });
  mocks.api.mockRejectedValueOnce(new Error("no"));
  await commands.discardAll(repo);
  expect(ui().diff).toEqual({ kind: "unstaged", path: "a.ts" });
});

it("creates a branch from a stash", async () => {
  mocks.prompt.mockResolvedValueOnce(null);
  await commands.stashBranch(repo, { index: 1, hash: "s1" });
  expect(mocks.prompt).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Create branch from stash" }),
  );
  expect(methods()).toEqual([]);
  mocks.prompt.mockResolvedValueOnce({ value: "rescued" });
  await commands.stashBranch(repo, { index: 1, hash: "s1" });
  expect(apiCalls("repo.stashBranch")).toEqual([[repo, "rescued", 1, "s1"]]);
});

it("checks out refs of every kind", async () => {
  await commands.checkoutRef(repo, topic);
  expect(apiCalls("repo.checkout")).toEqual([[repo, "topic"]]);
  // A remote branch with a local counterpart checks out the local branch.
  mocks.api.mockClear();
  await commands.checkoutRef(repo, originMain);
  expect(apiCalls("repo.checkout")).toEqual([[repo, "main"]]);
  // Otherwise a tracking branch is created.
  mocks.api.mockClear();
  await commands.checkoutRef(repo, originFeature);
  expect(apiCalls("repo.checkoutRemote")).toEqual([[repo, "origin/feature/x", "feature/x"]]);
  // Tags check out detached.
  mocks.api.mockClear();
  await commands.checkoutRef(repo, tag);
  expect(apiCalls("repo.checkout")).toEqual([[repo, "hash-of-refs/tags/v1"]]);
});

it("creates branches", async () => {
  mocks.prompt.mockResolvedValueOnce(null);
  await commands.createBranch(repo, "abc");
  expect(methods()).toEqual([]);
  mocks.prompt.mockResolvedValueOnce({ value: "feature/y", checked: false });
  await commands.createBranch(repo, "abc", "main");
  expect(mocks.prompt).toHaveBeenLastCalledWith(
    expect.objectContaining({
      description: "Create a new branch at main.",
      checkbox: expect.objectContaining({ defaultChecked: true }),
    }),
  );
  expect(apiCalls("repo.createBranch")).toEqual([[repo, "feature/y", "abc", false]]);
  expect(mocks.prompt.mock.calls[0]![0].description).toBeUndefined();
});

it("renames branches unless the name is unchanged", async () => {
  mocks.prompt.mockResolvedValueOnce({ value: "topic" });
  await commands.renameBranch(repo, "topic");
  expect(mocks.prompt).toHaveBeenCalledWith(expect.objectContaining({ defaultValue: "topic" }));
  mocks.prompt.mockResolvedValueOnce(null);
  await commands.renameBranch(repo, "topic");
  expect(methods()).toEqual([]);
  mocks.prompt.mockResolvedValueOnce({ value: "topic2" });
  await commands.renameBranch(repo, "topic");
  expect(apiCalls("repo.renameBranch")).toEqual([[repo, "topic", "topic2"]]);
});

it("deletes local and remote branches after confirming", async () => {
  mocks.confirm.mockResolvedValue(false);
  await commands.deleteBranch(repo, topic);
  await commands.deleteBranch(repo, originFeature);
  expect(methods()).toEqual([]);

  mocks.confirm.mockResolvedValue(true);
  await commands.deleteBranch(repo, topic);
  expect(apiCalls("repo.deleteBranch")).toEqual([[repo, "topic", false]]);
  await commands.deleteBranch(repo, originFeature);
  expect(mocks.confirm).toHaveBeenLastCalledWith(
    expect.objectContaining({
      title: "Delete origin/feature/x?",
      description: "This deletes the branch “feature/x” on the remote “origin”.",
    }),
  );
  expect(apiCalls("repo.deleteRemoteBranch")).toEqual([[repo, "origin", "feature/x"]]);
  expect(mocks.toast.loading).not.toHaveBeenCalled();
});

it("forces deleting an unmerged branch only after asking again", async () => {
  mocks.api.mockRejectedValueOnce(new Error("error: the branch 'topic' is not fully merged"));
  mocks.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await commands.deleteBranch(repo, topic);
  expect(mocks.confirm).toHaveBeenLastCalledWith(
    expect.objectContaining({ title: "Delete unmerged topic?", destructive: true }),
  );
  expect(apiCalls("repo.deleteBranch")).toEqual([[repo, "topic", false]]);
  expect(mocks.toast.error).not.toHaveBeenCalled();

  mocks.api.mockClear();
  mocks.api.mockRejectedValueOnce(new Error("error: the branch 'topic' is not fully merged"));
  await commands.deleteBranch(repo, topic);
  expect(apiCalls("repo.deleteBranch")).toEqual([
    [repo, "topic", false],
    [repo, "topic", true],
  ]);
});

it("deletes tags after confirming", async () => {
  mocks.confirm.mockResolvedValueOnce(false);
  await commands.deleteTag(repo, "v1");
  expect(methods()).toEqual([]);
  await commands.deleteTag(repo, "v1");
  expect(apiCalls("repo.deleteTag")).toEqual([[repo, "v1"]]);
});

it("confirms merges and rebases, naming the current branch", async () => {
  await commands.merge(repo, "topic");
  expect(mocks.confirm).toHaveBeenLastCalledWith(
    expect.objectContaining({ description: "Merge “topic” into “main”." }),
  );
  expect(apiCalls("repo.merge")).toEqual([[repo, "topic", {}]]);
  await commands.rebase(repo, "origin/main");
  expect(mocks.confirm).toHaveBeenLastCalledWith(
    expect.objectContaining({ description: expect.stringContaining("Rebase “main” onto") }),
  );
  expect(apiCalls("repo.rebase")).toEqual([[repo, "origin/main"]]);

  // Full ref names are passed on as they are, and shown short.
  await commands.merge(repo, "refs/heads/topic");
  expect(mocks.confirm).toHaveBeenLastCalledWith(
    expect.objectContaining({ title: "Merge topic?", description: "Merge “topic” into “main”." }),
  );
  await commands.rebase(repo, "refs/remotes/origin/main");
  expect(mocks.confirm).toHaveBeenLastCalledWith(
    expect.objectContaining({
      title: "Rebase onto origin/main?",
      description: "Rebase “main” onto “origin/main”. This rewrites history.",
    }),
  );
  expect(apiCalls("repo.merge").at(-1)).toEqual([repo, "refs/heads/topic", {}]);
  expect(apiCalls("repo.rebase").at(-1)).toEqual([repo, "refs/remotes/origin/main"]);

  setRefs([]);
  mocks.confirm.mockResolvedValue(false);
  mocks.api.mockClear();
  await commands.merge(repo, "topic");
  await commands.rebase(repo, "topic");
  expect(mocks.confirm.mock.calls.map(([o]) => o.description)).toContain(
    "Merge “topic” into “HEAD”.",
  );
  expect(methods()).toEqual([]);
});

it("describes each reset mode", async () => {
  for (const mode of ["soft", "mixed", "hard"] as const) {
    await commands.reset(repo, "0123456789", mode);
  }
  const shown = mocks.confirm.mock.calls.map(([o]) => [o.title, o.description, o.destructive]);
  expect(shown).toEqual([
    ["Soft reset to 0123456?", "Moves “main” to 0123456, keeping all changes staged.", false],
    [
      "Mixed reset to 0123456?",
      "Moves “main” to 0123456 and unstages changes, keeping them in the working tree.",
      false,
    ],
    [
      "Hard reset to 0123456?",
      "Moves “main” to 0123456 and DISCARDS all uncommitted changes.",
      true,
    ],
  ]);
  expect(apiCalls("repo.reset").map((a) => a[2])).toEqual(["soft", "mixed", "hard"]);
  mocks.confirm.mockResolvedValue(false);
  mocks.api.mockClear();
  await commands.reset(repo, "0123456789", "hard");
  expect(methods()).toEqual([]);
});

it("confirms discarding changes", async () => {
  await commands.discard(repo, ["a.ts"], []);
  expect(mocks.confirm).toHaveBeenLastCalledWith(
    expect.objectContaining({
      title: "Discard changes to a.ts?",
      description: "This cannot be undone.",
    }),
  );
  await commands.discard(repo, [], ["new.ts"]);
  expect(mocks.confirm).toHaveBeenLastCalledWith(
    expect.objectContaining({
      title: "Discard changes to new.ts?",
      description: "Untracked files will be deleted. This cannot be undone.",
    }),
  );
  await commands.discard(repo, ["a.ts", "b.ts"], ["c.ts"]);
  expect(mocks.confirm).toHaveBeenLastCalledWith(
    expect.objectContaining({ title: "Discard 3 changes?" }),
  );
  expect(apiCalls("repo.discard")).toEqual([
    [repo, ["a.ts"], []],
    [repo, [], ["new.ts"]],
    [repo, ["a.ts", "b.ts"], ["c.ts"]],
  ]);
  mocks.confirm.mockResolvedValue(false);
  mocks.api.mockClear();
  await commands.discard(repo, ["a.ts"], []);
  expect(methods()).toEqual([]);
});

it("confirms discarding all changes", async () => {
  await commands.discardAll(repo);
  expect(mocks.confirm).toHaveBeenLastCalledWith(
    expect.objectContaining({ title: "Discard all changes?", destructive: true }),
  );
  expect(apiCalls("repo.discardAll")).toEqual([[repo]]);
  mocks.confirm.mockResolvedValue(false);
  mocks.api.mockClear();
  await commands.discardAll(repo);
  expect(methods()).toEqual([]);
});

it("applies patches, offering to undo a discard", async () => {
  await commands.applyPatch(repo, "Stage Hunk", "P", { cached: true, reverse: false });
  await commands.applyPatch(repo, "Unstage Hunk", "P", { cached: true, reverse: true });
  expect(mocks.toast).not.toHaveBeenCalled();
  await commands.applyPatch(repo, "Discard Lines", "P", { cached: false, reverse: true }, "a.ts");
  expect(apiCalls("repo.applyPatch")).toEqual([
    [repo, "P", { cached: true, reverse: false }],
    [repo, "P", { cached: true, reverse: true }],
    [repo, "P", { cached: false, reverse: true }],
  ]);
  expect(mocks.toast).toHaveBeenCalledWith(
    "Changes discarded",
    expect.objectContaining({ description: "a.ts", action: expect.anything() }),
  );
  // Undo applies the same patch forward to the working tree.
  mocks.api.mockClear();
  const undo = mocks.toast.mock.calls[0]![1].action.onClick as () => void;
  undo();
  await vi.waitFor(() => expect(noticeText()).toBe("Discarded changes restored"));
  expect(apiCalls("repo.applyPatch")).toEqual([[repo, "P", { cached: false, reverse: false }]]);

  // A failed discard has nothing to undo.
  mocks.toast.mockClear();
  mocks.api.mockRejectedValueOnce(new Error("patch does not apply"));
  const result = await commands.applyPatch(repo, "Discard Hunk", "P", {
    cached: false,
    reverse: true,
  });
  expect(result).toEqual({ ok: false });
  expect(mocks.toast).not.toHaveBeenCalled();
});

it("sets upstreams, defaulting to the branch on origin", async () => {
  mocks.prompt.mockResolvedValue({ value: "upstream/topic" });
  await commands.setUpstream(repo, topic);
  expect(mocks.prompt).toHaveBeenLastCalledWith(
    expect.objectContaining({ defaultValue: "origin/topic" }),
  );
  expect(apiCalls("repo.setUpstream")).toEqual([[repo, "topic", "upstream/topic"]]);
  // An existing upstream is shown without its refs/remotes/ prefix.
  await commands.setUpstream(repo, main);
  expect(mocks.prompt).toHaveBeenLastCalledWith(
    expect.objectContaining({ defaultValue: "origin/main" }),
  );
  // Without origin, the first remote is used, and without remotes nothing is suggested.
  setRefs([topic], [remote("upstream")]);
  await commands.setUpstream(repo, topic);
  expect(mocks.prompt).toHaveBeenLastCalledWith(
    expect.objectContaining({ defaultValue: "upstream/topic" }),
  );
  setRefs([topic], []);
  await commands.setUpstream(repo, topic);
  expect(mocks.prompt).toHaveBeenLastCalledWith(expect.objectContaining({ defaultValue: "" }));

  mocks.prompt.mockResolvedValue(null);
  mocks.api.mockClear();
  await commands.setUpstream(repo, topic);
  expect(methods()).toEqual([]);
});

it("creates worktrees next to the main checkout", async () => {
  mocks.prompt.mockResolvedValueOnce(null);
  await commands.createWorktree(repo, "abc", "feature/x y");
  expect(mocks.prompt).toHaveBeenCalledWith(
    expect.objectContaining({ defaultValue: "/work/repo-feature-x-y" }),
  );
  expect(methods()).toEqual([]);

  // Without repository info, the location's path is used.
  queryClient.removeQueries({ queryKey: keys.info(repo) });
  mocks.prompt.mockResolvedValueOnce({ value: "/elsewhere/wt" });
  await commands.createWorktree(repo, "abc", "v1");
  expect(mocks.prompt).toHaveBeenLastCalledWith(
    expect.objectContaining({ defaultValue: "/work/repo-v1" }),
  );
  expect(apiCalls("repo.addWorktree")).toEqual([[repo, "/elsewhere/wt", "abc", null]]);
  expect(noticeText()).toBe("Worktree created");
});

/** A failure the way the api reports a main-process error. */
const apiError = (errorTag: string, message: string) =>
  Object.assign(new Error(message), { tag: errorTag });

it("removes worktrees, offering to force only when the main process says it helps", async () => {
  mocks.confirm.mockResolvedValueOnce(false);
  await commands.removeWorktree(repo, "/work/wt");
  expect(methods()).toEqual([]);

  await commands.removeWorktree(repo, "/work/wt");
  expect(apiCalls("repo.removeWorktree")).toEqual([[repo, "/work/wt", false]]);
  expect(mocks.confirm).toHaveBeenCalledTimes(2);

  // Dirty or locked: one prompt to force, no error toast; declining stops there.
  mocks.api.mockClear();
  mocks.api.mockRejectedValueOnce(apiError("WorktreeNeedsForceError", "enthält Änderungen"));
  mocks.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await commands.removeWorktree(repo, "/work/wt");
  expect(mocks.toast.error).not.toHaveBeenCalled();
  expect(mocks.confirm).toHaveBeenLastCalledWith(
    expect.objectContaining({ title: "Force remove worktree?" }),
  );
  expect(apiCalls("repo.removeWorktree")).toEqual([[repo, "/work/wt", false]]);

  mocks.api.mockClear();
  mocks.api.mockRejectedValueOnce(apiError("WorktreeNeedsForceError", "locked"));
  await commands.removeWorktree(repo, "/work/wt");
  expect(apiCalls("repo.removeWorktree")).toEqual([
    [repo, "/work/wt", false],
    [repo, "/work/wt", true],
  ]);
  expect(mocks.toast.error).not.toHaveBeenCalled();
});

it("reports other worktree removal failures without offering to force", async () => {
  // Even when the message mentions --force: only the error's tag counts.
  mocks.api
    .mockRejectedValueOnce(apiError("SshError", "Lost connection to box"))
    .mockRejectedValueOnce(apiError("CommandError", "use --force to delete it"));
  await commands.removeWorktree(repo, "/work/wt");
  await commands.removeWorktree(repo, "/work/wt");
  expect(mocks.toast.error.mock.calls.map(([title, o]) => [title, o.description])).toEqual([
    ["Remove worktree failed", "Lost connection to box"],
    ["Remove worktree failed", "use --force to delete it"],
  ]);
  expect(mocks.confirm).toHaveBeenCalledTimes(2);
  expect(apiCalls("repo.removeWorktree")).toEqual([
    [repo, "/work/wt", false],
    [repo, "/work/wt", false],
  ]);
});

it("opens sibling repositories on the same host", () => {
  commands.openSibling(repo, "sub/module");
  commands.openSibling(repo, "/abs/wt");
  commands.openSibling(repo, "C:\\wt");
  expect(mocks.openLocation.mock.calls.map(([l]) => l)).toEqual([
    { kind: "local", path: "/work/repo/sub/module" },
    { kind: "local", path: "/abs/wt" },
    { kind: "local", path: "C:\\wt" },
  ]);
  const ssh = "ssh://box/home/me/repo";
  commands.openSibling(ssh, "lib");
  expect(mocks.openLocation).toHaveBeenLastCalledWith({
    kind: "ssh",
    host: "box",
    path: "/home/me/repo/lib",
  });
});

it("reveals files in the file manager", () => {
  commands.reveal(repo, "a.ts");
  commands.reveal(repo);
  expect(apiCalls("shell.revealInFinder")).toEqual([
    [repo, "a.ts"],
    [repo, undefined],
  ]);
  // Remote files are not on this machine.
  mocks.api.mockClear();
  commands.reveal("ssh://box/repo", "a.ts");
  expect(methods()).toEqual([]);
  expect(noticeText("ssh://box/repo")).toBe("Only local files can be revealed");
});

it("pushes and deletes tags on the default remote", async () => {
  await commands.pushTag(repo, "v1");
  expect(apiCalls("repo.pushTag")).toEqual([[repo, "origin", "v1"]]);
  expect(noticeText()).toBe("Pushed v1 to origin");

  mocks.confirm.mockResolvedValueOnce(false);
  await commands.deleteRemoteTag(repo, "v1");
  expect(apiCalls("repo.deleteRemoteTag")).toEqual([]);
  await commands.deleteRemoteTag(repo, "v1");
  expect(mocks.confirm).toHaveBeenLastCalledWith(
    expect.objectContaining({ title: "Delete v1 from origin?" }),
  );
  expect(apiCalls("repo.deleteRemoteTag")).toEqual([[repo, "origin", "v1"]]);
});

it("does not push or delete remote tags without remotes", async () => {
  setRefs([main], []);
  await commands.pushTag(repo, "v1");
  expect(mocks.toast.error).toHaveBeenCalledWith("No remotes configured");
  await commands.deleteRemoteTag(repo, "v1");
  expect(mocks.toast.error.mock.calls).toEqual([
    ["No remotes configured"],
    ["No remotes configured"],
  ]);
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(methods()).toEqual([]);
});

it("adds remotes and fetches them", async () => {
  mocks.prompt.mockResolvedValueOnce(null);
  await commands.addRemote(repo);
  expect(mocks.prompt).toHaveBeenLastCalledWith(expect.objectContaining({ defaultValue: "" }));
  mocks.prompt.mockResolvedValueOnce({ value: "fork" }).mockResolvedValueOnce(null);
  await commands.addRemote(repo);
  expect(mocks.prompt).toHaveBeenLastCalledWith(
    expect.objectContaining({ title: "Add remote fork" }),
  );
  expect(methods()).toEqual([]);

  // The first remote is suggested to be origin.
  setRefs([main], []);
  mocks.prompt
    .mockResolvedValueOnce({ value: "origin" })
    .mockResolvedValueOnce({ value: "git@x:me/repo.git" });
  await commands.addRemote(repo);
  expect(mocks.prompt.mock.calls.at(-2)![0]).toMatchObject({ defaultValue: "origin" });
  await vi.waitFor(() => expect(apiCalls("repo.fetch")).toEqual([[repo, "origin"]]));
  expect(apiCalls("repo.addRemote")).toEqual([[repo, "origin", "git@x:me/repo.git"]]);
});

it("does not fetch a remote that could not be added", async () => {
  mocks.prompt
    .mockResolvedValueOnce({ value: "origin" })
    .mockResolvedValueOnce({ value: "git@x:me/repo.git" });
  mocks.api.mockRejectedValueOnce(new Error("remote origin already exists"));
  await commands.addRemote(repo);
  expect(mocks.toast.error).toHaveBeenCalledWith("Add remote failed", expect.anything());
  expect(apiCalls("repo.fetch")).toEqual([]);
});

it("edits remote URLs unless unchanged", async () => {
  mocks.prompt.mockResolvedValueOnce({ value: "old" });
  await commands.editRemoteUrl(repo, "origin", "old");
  mocks.prompt.mockResolvedValueOnce(null);
  await commands.editRemoteUrl(repo, "origin", "old");
  expect(methods()).toEqual([]);
  mocks.prompt.mockResolvedValueOnce({ value: "new" });
  await commands.editRemoteUrl(repo, "origin", "old");
  expect(apiCalls("repo.setRemoteUrl")).toEqual([[repo, "origin", "new"]]);
});

it("removes remotes after confirming", async () => {
  mocks.confirm.mockResolvedValueOnce(false);
  await commands.removeRemote(repo, "upstream");
  expect(methods()).toEqual([]);
  await commands.removeRemote(repo, "upstream");
  expect(apiCalls("repo.removeRemote")).toEqual([[repo, "upstream"]]);
});

it("copies text to the clipboard", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  commands.copy("abc123", "Commit SHA copied");
  await vi.waitFor(() => expect(noticeText(APP)).toBe("Commit SHA copied"));
  commands.copy("x");
  await vi.waitFor(() => expect(noticeText(APP)).toBe("Copied"));
  expect(writeText.mock.calls).toEqual([["abc123"], ["x"]]);
  expect(mocks.toast.success).not.toHaveBeenCalled();
});

it("runs edit commands, and reports their failures", async () => {
  await commands.edit("paste");
  expect(apiCalls("app.edit")).toEqual([["paste"]]);
  expect(mocks.toast.error).not.toHaveBeenCalled();
  mocks.api.mockRejectedValueOnce(new Error("window is gone"));
  await commands.edit("cut");
  expect(mocks.toast.error).toHaveBeenCalledWith("Edit failed", { description: "window is gone" });
});

it("selects and reveals commits", () => {
  commands.selectCommit(repo, "c1");
  commands.selectCommit(repo, "c2");
  expect(useRepoUiStore.getState().byRepo[repo]).toMatchObject({
    selection: { kind: "commit", hash: "c2" },
    revealToken: 2,
  });
});
