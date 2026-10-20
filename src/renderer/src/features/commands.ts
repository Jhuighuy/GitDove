/**
 * User-facing repository commands, shared by the toolbar, menus and context menus.
 */
import type { Ref, RefsSnapshot, RepoId } from "@shared/domain";
import type { ResetMode } from "@shared/ipc";
import { toast } from "sonner";
import { runAction } from "@/lib/actions";
import { api } from "@/lib/api";
import { shortHash } from "@/lib/format";
import { keys, queryClient } from "@/lib/queries";
import { useRepoUiStore } from "@/stores/repo-ui";
import { confirm, prompt, validateRefName } from "./dialogs/dialogs";

const refs = (repo: RepoId) => queryClient.getQueryData<RefsSnapshot>(keys.refs(repo));
const headBranch = (repo: RepoId) => refs(repo)?.refs.find((r) => r.kind === "branch" && r.isHead);

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
    });
    if (!r) return;
    await runAction(repo, "Create tag", () => api("repo.createTag", repo, r.value, at, null));
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

  copy: (text: string, what = "Copied") => {
    void navigator.clipboard.writeText(text).then(() => toast.success(what, { duration: 1500 }));
  },

  selectCommit: (repo: RepoId, hash: string) =>
    useRepoUiStore.getState().select(repo, { kind: "commit", hash }, true),
};
