// @vitest-environment happy-dom
import type { Ref, RefsSnapshot, RepoInfo } from "@shared/domain";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  prompt: vi.fn(),
  confirm: vi.fn(),
  openLocation: vi.fn(),
  toast: { loading: vi.fn(() => "t"), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() },
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

const repo = "local:/work/repo";

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
    [() => commands.pop(repo), "repo.stashPop", [repo, 0]],
    [() => commands.pop(repo, 2), "repo.stashPop", [repo, 2]],
    [() => commands.applyStash(repo, 1), "repo.stashApply", [repo, 1]],
    [() => commands.checkout(repo, "topic"), "repo.checkout", [repo, "topic"]],
    [() => commands.cherryPick(repo, "0123456789"), "repo.cherryPick", [repo, "0123456789"]],
    [() => commands.revert(repo, "0123456789"), "repo.revert", [repo, "0123456789"]],
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

it("shows progress and success toasts", async () => {
  await commands.fetch(repo);
  expect(mocks.toast.loading).toHaveBeenCalledWith("Fetching…");
  expect(mocks.toast.dismiss).toHaveBeenCalledWith("t");
  await commands.cherryPick(repo, "0123456789");
  expect(mocks.toast.success).toHaveBeenCalledWith("Cherry-picked 0123456", { id: undefined });
  await commands.revert(repo, "abcdef0123");
  expect(mocks.toast.success).toHaveBeenCalledWith("Reverted abcdef0", { id: undefined });
  await commands.stash(repo);
  expect(mocks.toast.success).toHaveBeenCalledWith("Changes stashed", { id: undefined });
  await commands.updateSubmodule(repo, "lib/x");
  expect(mocks.toast.loading).toHaveBeenCalledWith("Updating lib/x…");
  expect(mocks.toast.success).toHaveBeenCalledWith("Updated lib/x", { id: "t" });
});

it("reports failures as error toasts", async () => {
  mocks.api.mockRejectedValue(new Error("could not resolve host"));
  await expect(commands.pull(repo)).resolves.toBeUndefined();
  expect(mocks.toast.error).toHaveBeenCalledWith("Pull failed", {
    id: "t",
    description: "could not resolve host",
    duration: 10000,
  });
  expect(mocks.toast.success).not.toHaveBeenCalled();
  mocks.prompt.mockResolvedValue({ value: "b", checked: true });
  await commands.createBranch(repo, "abc");
  expect(mocks.toast.error).toHaveBeenLastCalledWith(
    "Create branch failed",
    expect.objectContaining({ description: "could not resolve host" }),
  );
});

it("pushes the current branch", async () => {
  await commands.push(repo);
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(apiCalls("repo.push")).toEqual([[repo, { force: false, setUpstream: false }]]);
  expect(mocks.toast.success).toHaveBeenCalledWith("Pushed main", { id: "t" });
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
  expect(apiCalls("repo.push")).toEqual([[repo, { force: false, setUpstream: true }]]);
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
  expect(mocks.toast.success).toHaveBeenCalledWith("Pushed topic", { id: "t" });
  await commands.pullBranch(repo, topic);
  expect(apiCalls("repo.fastForwardBranch")).toEqual([[repo, "topic"]]);
  expect(mocks.toast.success).toHaveBeenCalledWith("Updated topic", { id: "t" });

  mocks.api.mockClear();
  await commands.pushBranch(repo, main);
  await commands.pullBranch(repo, main);
  expect(methods()).toEqual(["repo.push", "repo.pull"]);
});

it("confirms dropping a stash", async () => {
  mocks.confirm.mockResolvedValueOnce(false);
  await commands.dropStash(repo, 3);
  expect(mocks.confirm).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Delete stash@{3}?", destructive: true }),
  );
  expect(methods()).toEqual([]);
  await commands.dropStash(repo, 3);
  expect(apiCalls("repo.stashDrop")).toEqual([[repo, 3]]);
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
  expect(apiCalls("repo.deleteBranch")).toEqual([[repo, "topic", true]]);
  await commands.deleteBranch(repo, originFeature);
  expect(mocks.confirm).toHaveBeenLastCalledWith(
    expect.objectContaining({
      title: "Delete origin/feature/x?",
      description: "This deletes the branch “feature/x” on the remote “origin”.",
    }),
  );
  expect(apiCalls("repo.deleteRemoteBranch")).toEqual([[repo, "origin", "feature/x"]]);
  expect(mocks.toast.loading).toHaveBeenCalledWith("Deleting origin/feature/x…");
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
  expect(mocks.toast.success).toHaveBeenCalledWith("Worktree created", { id: undefined });
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
});

it("pushes and deletes tags on the default remote", async () => {
  await commands.pushTag(repo, "v1");
  expect(apiCalls("repo.pushTag")).toEqual([[repo, "origin", "v1"]]);
  expect(mocks.toast.success).toHaveBeenCalledWith("Pushed v1 to origin", { id: "t" });

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
  commands.copy("x");
  expect(writeText.mock.calls).toEqual([["abc123"], ["x"]]);
  await vi.waitFor(() => expect(mocks.toast.success).toHaveBeenCalledTimes(2));
  expect(mocks.toast.success).toHaveBeenCalledWith("Commit SHA copied", { duration: 1500 });
  expect(mocks.toast.success).toHaveBeenCalledWith("Copied", { duration: 1500 });
});

it("selects and reveals commits", () => {
  commands.selectCommit(repo, "c1");
  commands.selectCommit(repo, "c2");
  expect(useRepoUiStore.getState().byRepo[repo]).toMatchObject({
    selection: { kind: "commit", hash: "c2" },
    revealToken: 2,
  });
});
