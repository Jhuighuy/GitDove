/**
 * User-facing repository commands, shared by the toolbar, menus and context menus.
 */
import type { Ref, RefsSnapshot, RepoId, RepoInfo, RepoLocation } from "@shared/domain";
import { repoLocationOf } from "@shared/domain";
import type { ResetMode } from "@shared/ipc";
import { toast } from "sonner";
import { runAction } from "@/lib/actions";
import { ApiError, api } from "@/lib/api";
import { shortHash } from "@/lib/format";
import { keys, queryClient } from "@/lib/queries";
import { useRepoUiStore } from "@/stores/repo-ui";
import { confirm, prompt, validateRefName } from "./dialogs/dialogs";
import { openLocation } from "./open/OpenRepo";

const refs = (repo: RepoId) => queryClient.getQueryData<RefsSnapshot>(keys.refs(repo));
const headBranch = (repo: RepoId) => refs(repo)?.refs.find((r) => r.kind === "branch" && r.isHead);
const info = (repo: RepoId) => queryClient.getQueryData<RepoInfo>(keys.info(repo));
const defaultRemote = (repo: RepoId) => {
  const remotes = refs(repo)?.remotes ?? [];
  return remotes.find((r) => r.name === "origin")?.name ?? remotes[0]?.name ?? null;
};

/** A location on the same host as `repo` (worktrees, submodules). */
const sibling = (repo: RepoId, path: string): RepoLocation => {
  const loc = repoLocationOf(repo);
  const abs =
    path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)
      ? path
      : `${info(repo)?.workTree ?? loc.path}/${path}`;
  return loc.kind === "ssh"
    ? { kind: "ssh", host: loc.host, path: abs }
    : { kind: "local", path: abs };
};

export const commands = {
  fetch: (repo: RepoId) =>
    runAction(repo, "Fetch", () => api("repo.fetch", repo, null), { progress: "Fetching…" }),

  pull: (repo: RepoId, mode: "ff-only" | "merge" | "rebase" = "ff-only") =>
    runAction(repo, "Pull", () => api("repo.pull", repo, mode), {
      progress: "Pulling…",
      success: "Pulled",
    }),

  push: async (repo: RepoId, force = false) => {
    const head = headBranch(repo);
    if (!head) {
      toast.error("Push failed", { description: "No branch is checked out" });
      return;
    }
    let setUpstream = false;
    if (!head.upstream || head.upstreamGone) {
      const ok = await confirm({
        title: `Push ${head.short}?`,
        description: `“${head.short}” has no upstream branch. Push it and set the upstream to origin/${head.short}?`,
        confirmLabel: "Push",
      });
      if (!ok) return;
      setUpstream = true;
    }
    if (force) {
      const ok = await confirm({
        title: `Force push ${head.short}?`,
        description:
          "This overwrites the remote branch (with lease). Commits on the remote that you have not fetched will be kept safe, but others may lose work.",
        confirmLabel: "Force Push",
        destructive: true,
      });
      if (!ok) return;
    }
    await runAction(repo, "Push", () => api("repo.push", repo, { force, setUpstream }), {
      progress: "Pushing…",
      success: `Pushed ${head.short}`,
    });
  },

  stash: async (repo: RepoId) => {
    await runAction(repo, "Stash", () => api("repo.stash", repo, null, true), {
      success: "Changes stashed",
    });
  },

  pop: (repo: RepoId, index = 0) =>
    runAction(repo, "Pop stash", () => api("repo.stashPop", repo, index)),

  applyStash: (repo: RepoId, index: number) =>
    runAction(repo, "Apply stash", () => api("repo.stashApply", repo, index)),

  dropStash: async (repo: RepoId, index: number) => {
    const ok = await confirm({
      title: `Delete stash@{${index}}?`,
      description: "Stashed changes will be lost.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (ok) await runAction(repo, "Delete stash", () => api("repo.stashDrop", repo, index));
  },

  checkout: (repo: RepoId, ref: string) =>
    runAction(repo, "Checkout", () => api("repo.checkout", repo, ref)),

  checkoutRef: async (repo: RepoId, ref: Ref) => {
    if (ref.kind === "branch") return commands.checkout(repo, ref.short);
    if (ref.kind === "remote") {
      const local = ref.short.slice((ref.remote?.length ?? 0) + 1);
      const existing = refs(repo)?.refs.find((r) => r.kind === "branch" && r.short === local);
      if (existing) return commands.checkout(repo, existing.short);
      return runAction(repo, "Checkout", () => api("repo.checkoutRemote", repo, ref.short, local));
    }
    return commands.checkout(repo, ref.hash);
  },

  createBranch: async (repo: RepoId, at: string, label?: string) => {
    const r = await prompt({
      title: "Create branch",
      description: label ? `Create a new branch at ${label}.` : undefined,
      label: "Branch name",
      placeholder: "feature/my-branch",
      confirmLabel: "Create Branch",
      validate: validateRefName,
      checkbox: { label: "Check out after creating", defaultChecked: true },
    });
    if (!r) return;
    await runAction(repo, "Create branch", () =>
      api("repo.createBranch", repo, r.value, at, r.checked),
    );
  },

  renameBranch: async (repo: RepoId, name: string) => {
    const r = await prompt({
      title: "Rename branch",
      label: "New name",
      defaultValue: name,
      confirmLabel: "Rename",
      validate: validateRefName,
    });
    if (!r || r.value === name) return;
    await runAction(repo, "Rename branch", () => api("repo.renameBranch", repo, name, r.value));
  },

  deleteBranch: async (repo: RepoId, ref: Ref) => {
    if (ref.kind === "remote") {
      const name = ref.short.slice((ref.remote?.length ?? 0) + 1);
      const ok = await confirm({
        title: `Delete ${ref.short}?`,
        description: `This deletes the branch “${name}” on the remote “${ref.remote}”.`,
        confirmLabel: "Delete",
        destructive: true,
      });
      if (ok) {
        await runAction(
          repo,
          "Delete remote branch",
          () => api("repo.deleteRemoteBranch", repo, ref.remote!, name),
          { progress: `Deleting ${ref.short}…` },
        );
      }
      return;
    }
    const ok = await confirm({
      title: `Delete ${ref.short}?`,
      description: "The branch will be deleted even if it is not fully merged.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (ok)
      await runAction(repo, "Delete branch", () => api("repo.deleteBranch", repo, ref.short, true));
  },

  createTag: async (repo: RepoId, at: string) => {
    const r = await prompt({
      title: "Create tag",
      description: `Tag commit ${shortHash(at)}.`,
      label: "Tag name",
      placeholder: "v1.0.0",
      confirmLabel: "Create Tag",
      validate: validateRefName,
      details: {
        label: "Message (optional)",
        placeholder: "With a message, an annotated tag is created.",
      },
    });
    if (!r) return;
    await runAction(repo, "Create tag", () =>
      api("repo.createTag", repo, r.value, at, r.details || null),
    );
  },

  deleteTag: async (repo: RepoId, name: string) => {
    const ok = await confirm({
      title: `Delete tag ${name}?`,
      description: "The tag is deleted locally only.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (ok) await runAction(repo, "Delete tag", () => api("repo.deleteTag", repo, name));
  },

  merge: async (repo: RepoId, ref: string) => {
    const head = headBranch(repo);
    const ok = await confirm({
      title: `Merge ${ref}?`,
      description: `Merge “${ref}” into “${head?.short ?? "HEAD"}”.`,
      confirmLabel: "Merge",
    });
    if (ok) await runAction(repo, "Merge", () => api("repo.merge", repo, ref, {}));
  },

  rebase: async (repo: RepoId, onto: string) => {
    const head = headBranch(repo);
    const ok = await confirm({
      title: `Rebase onto ${onto}?`,
      description: `Rebase “${head?.short ?? "HEAD"}” onto “${onto}”. This rewrites history.`,
      confirmLabel: "Rebase",
    });
    if (ok) await runAction(repo, "Rebase", () => api("repo.rebase", repo, onto));
  },

  cherryPick: (repo: RepoId, hash: string) =>
    runAction(repo, "Cherry-pick", () => api("repo.cherryPick", repo, hash), {
      success: `Cherry-picked ${shortHash(hash)}`,
    }),

  revert: (repo: RepoId, hash: string) =>
    runAction(repo, "Revert", () => api("repo.revert", repo, hash), {
      success: `Reverted ${shortHash(hash)}`,
    }),

  reset: async (repo: RepoId, hash: string, mode: ResetMode) => {
    const head = headBranch(repo);
    const ok = await confirm({
      title: `${mode[0]!.toUpperCase()}${mode.slice(1)} reset to ${shortHash(hash)}?`,
      description:
        mode === "hard"
          ? `Moves “${head?.short ?? "HEAD"}” to ${shortHash(hash)} and DISCARDS all uncommitted changes.`
          : mode === "mixed"
            ? `Moves “${head?.short ?? "HEAD"}” to ${shortHash(hash)} and unstages changes, keeping them in the working tree.`
            : `Moves “${head?.short ?? "HEAD"}” to ${shortHash(hash)}, keeping all changes staged.`,
      confirmLabel: "Reset",
      destructive: mode === "hard",
    });
    if (ok) await runAction(repo, "Reset", () => api("repo.reset", repo, hash, mode));
  },

  abort: (repo: RepoId) => runAction(repo, "Abort", () => api("repo.abortOperation", repo)),
  continue: (repo: RepoId) =>
    runAction(repo, "Continue", () => api("repo.continueOperation", repo)),

  discard: async (repo: RepoId, paths: string[], untracked: string[]) => {
    const count = paths.length + untracked.length;
    const ok = await confirm({
      title:
        count === 1
          ? `Discard changes to ${(paths[0] ?? untracked[0])!}?`
          : `Discard ${count} changes?`,
      description:
        untracked.length > 0
          ? "Untracked files will be deleted. This cannot be undone."
          : "This cannot be undone.",
      confirmLabel: "Discard",
      destructive: true,
    });
    if (ok) await runAction(repo, "Discard", () => api("repo.discard", repo, paths, untracked));
  },

  pushBranch: (repo: RepoId, ref: Ref) =>
    ref.isHead
      ? commands.push(repo)
      : runAction(repo, "Push", () => api("repo.pushBranch", repo, ref.short, false), {
          progress: `Pushing ${ref.short}…`,
          success: `Pushed ${ref.short}`,
        }),

  /** Pull for the current branch; fast-forward from upstream for any other branch. */
  pullBranch: (repo: RepoId, ref: Ref) =>
    ref.isHead
      ? commands.pull(repo)
      : runAction(repo, "Fast-forward", () => api("repo.fastForwardBranch", repo, ref.short), {
          progress: `Updating ${ref.short}…`,
          success: `Updated ${ref.short}`,
        }),

  setUpstream: async (repo: RepoId, ref: Ref) => {
    const remote = defaultRemote(repo);
    const r = await prompt({
      title: `Set upstream for ${ref.short}`,
      description: "Remote branch to track. Leave the remote's name in front, e.g. origin/main.",
      label: "Upstream branch",
      defaultValue:
        ref.upstream?.replace(/^refs\/remotes\//, "") ?? (remote ? `${remote}/${ref.short}` : ""),
      confirmLabel: "Set Upstream",
    });
    if (!r) return;
    await runAction(repo, "Set upstream", () => api("repo.setUpstream", repo, ref.short, r.value));
  },

  createWorktree: async (repo: RepoId, ref: string, label: string) => {
    const workTree = info(repo)?.workTree ?? repoLocationOf(repo).path;
    const parent = workTree.replace(/[\\/][^\\/]+[\\/]?$/, "");
    const base = workTree.slice(parent.length + 1);
    const r = await prompt({
      title: `Create worktree from ${label}`,
      description: "A worktree is a second checkout of this repository in another folder.",
      label: "Folder",
      defaultValue: `${parent}/${base}-${label.replace(/[^\w.-]+/g, "-")}`,
      confirmLabel: "Create Worktree",
    });
    if (!r) return;
    await runAction(
      repo,
      "Create worktree",
      () => api("repo.addWorktree", repo, r.value, ref, null),
      {
        success: "Worktree created",
      },
    );
  },

  removeWorktree: async (repo: RepoId, path: string) => {
    const ok = await confirm({
      title: "Remove worktree?",
      description: `Deletes the folder ${path}.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    const result = await runAction(repo, "Remove worktree", async () => {
      try {
        await api("repo.removeWorktree", repo, path, false);
        return "removed";
      } catch (e) {
        // Git suggests forcing for a dirty or locked worktree; other failures are reported.
        if (e instanceof ApiError && /--force|-f -f/.test(`${e.message}\n${e.detail ?? ""}`)) {
          return "needs-force";
        }
        throw e;
      }
    });
    if (result !== "needs-force") return;
    const force = await confirm({
      title: "Force remove worktree?",
      description:
        "The worktree has uncommitted changes or is locked. Removing it anyway discards them.",
      confirmLabel: "Force Remove",
      destructive: true,
    });
    if (force)
      await runAction(repo, "Remove worktree", () => api("repo.removeWorktree", repo, path, true));
  },

  pruneWorktrees: (repo: RepoId) =>
    runAction(repo, "Prune worktrees", () => api("repo.pruneWorktrees", repo), {
      success: "Stale worktrees pruned",
    }),

  openSibling: (repo: RepoId, path: string) => void openLocation(sibling(repo, path)),

  reveal: (repo: RepoId, path?: string) => void api("shell.revealInFinder", repo, path),

  updateSubmodule: (repo: RepoId, path: string) =>
    runAction(repo, "Update submodule", () => api("repo.updateSubmodule", repo, path), {
      progress: `Updating ${path}…`,
      success: `Updated ${path}`,
    }),

  pushTag: (repo: RepoId, tag: string) => {
    const remote = defaultRemote(repo);
    if (!remote) return void toast.error("No remotes configured");
    return runAction(repo, "Push tag", () => api("repo.pushTag", repo, remote, tag), {
      progress: `Pushing ${tag}…`,
      success: `Pushed ${tag} to ${remote}`,
    });
  },

  deleteRemoteTag: async (repo: RepoId, tag: string) => {
    const remote = defaultRemote(repo);
    if (!remote) return void toast.error("No remotes configured");
    const ok = await confirm({
      title: `Delete ${tag} from ${remote}?`,
      description: "The tag is deleted on the remote; your local tag is kept.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (ok)
      await runAction(repo, "Delete remote tag", () =>
        api("repo.deleteRemoteTag", repo, remote, tag),
      );
  },

  fetchRemote: (repo: RepoId, remote: string) =>
    runAction(repo, "Fetch", () => api("repo.fetch", repo, remote), {
      progress: `Fetching ${remote}…`,
    }),

  addRemote: async (repo: RepoId) => {
    const name = await prompt({
      title: "Add remote",
      label: "Name",
      defaultValue: (refs(repo)?.remotes.length ?? 0) === 0 ? "origin" : "",
      placeholder: "upstream",
      confirmLabel: "Next",
      validate: validateRefName,
    });
    if (!name) return;
    const url = await prompt({
      title: `Add remote ${name.value}`,
      label: "URL",
      placeholder: "git@github.com:owner/repo.git",
      confirmLabel: "Add Remote",
    });
    if (!url) return;
    await runAction(repo, "Add remote", () => api("repo.addRemote", repo, name.value, url.value));
    void commands.fetchRemote(repo, name.value);
  },

  editRemoteUrl: async (repo: RepoId, name: string, current: string) => {
    const r = await prompt({
      title: `Edit ${name} URL`,
      label: "URL",
      defaultValue: current,
      confirmLabel: "Save",
    });
    if (!r || r.value === current) return;
    await runAction(repo, "Edit remote", () => api("repo.setRemoteUrl", repo, name, r.value));
  },

  removeRemote: async (repo: RepoId, name: string) => {
    const ok = await confirm({
      title: `Remove remote ${name}?`,
      description: "Its remote-tracking branches are removed too. Nothing changes on the server.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (ok) await runAction(repo, "Remove remote", () => api("repo.removeRemote", repo, name));
  },

  copy: (text: string, what = "Copied") => {
    void navigator.clipboard.writeText(text).then(() => toast.success(what, { duration: 1500 }));
  },

  selectCommit: (repo: RepoId, hash: string) =>
    useRepoUiStore.getState().select(repo, { kind: "commit", hash }, true),
};
