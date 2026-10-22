/**
 * Commands that rewrite or move history: rewording, editing, squashing, dropping and moving
 * commits, interactive rebases, cherry-picks, patches, and undo/redo.
 */
import type { EditableHistory, RepoId, RewritePlan } from "@shared/domain";
import { toast } from "sonner";
import { refuseWhileBusy, reportOutcome, runAction } from "@/lib/actions";
import { ApiError, api } from "@/lib/api";
import { shortHash } from "@/lib/format";
import { keys, queryClient } from "@/lib/queries";
import { useRepoUiStore } from "@/stores/repo-ui";
import { APP, notify } from "@/stores/status";
import { confirm } from "../dialogs/dialogs";
import { chooseCherryPick } from "./CherryPickDialog";
import { editMessage } from "./MessageDialog";
import { choosePatch } from "./PatchDialog";
import { combinedMessage, dropPlan, editPlan, movePlan, rebaseBase, squashPlan } from "./plan";

/** A commit as the menus know it. */
export interface CommitRef {
  readonly hash: string;
  readonly subject: string;
}

const history = (repo: RepoId) =>
  queryClient.fetchQuery({
    queryKey: keys.editable(repo),
    queryFn: () => api("repo.editableHistory", repo),
    staleTime: 0,
  });

const details = (repo: RepoId, hash: string) =>
  queryClient.fetchQuery({
    queryKey: keys.commit(repo, hash),
    queryFn: () => api("repo.commitDetails", repo, hash),
  });

const fullMessage = (d: { subject: string; body: string }) =>
  d.body ? `${d.subject}\n\n${d.body}` : d.subject;

/** Whether rewriting `hashes` (and what is above them) rewrites commits that were pushed. */
const rewritesPushed = (h: EditableHistory, hashes: readonly string[]) =>
  Math.max(...hashes.map((x) => h.commits.indexOf(x))) >= h.unpushed;

const PUSHED_WARNING = "Pushed already: you will need to force push.";

/** Asks before rewriting history that was pushed. */
const confirmPushed = async (h: EditableHistory, hashes: readonly string[], action: string) =>
  !rewritesPushed(h, hashes) ||
  confirm({
    title: "Rewrite pushed commits?",
    description:
      "Some of the commits this rewrites are on a remote branch already. Afterwards, you will need to force push, and others who have them will need to rebase their work.",
    confirmLabel: action,
  });

const rewrite = async (repo: RepoId, plan: RewritePlan | null, done: string) => {
  if (!plan) return void toast.error("These commits cannot be rewritten in place");
  reportOutcome(
    repo,
    await runAction(repo, plan.label, () => api("repo.rewrite", repo, plan), {
      status: `${plan.label}…`,
    }),
    done,
  );
};

const slug = (s: string) =>
  s
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 52) || "patch";

const many = (n: number, one: string, other = `${one}s`) => `${n} ${n === 1 ? one : other}`;

export const historyCommands = {
  reword: async (repo: RepoId, hash: string) => {
    if (refuseWhileBusy(repo, "Edit message")) return;
    const [h, d] = await Promise.all([history(repo), details(repo, hash)]);
    const message = await editMessage({
      title: "Edit commit message",
      confirmLabel: "Save Message",
      message: fullMessage(d),
      commits: [{ hash, subject: d.subject }],
      ...(rewritesPushed(h, [hash]) ? { warning: PUSHED_WARNING } : {}),
    });
    if (message === null || message === fullMessage(d).trim()) return;
    await runAction(repo, "Edit message", () => api("repo.reword", repo, hash, message), {
      status: "Rewording…",
      success: "Commit message changed",
    });
  },

  edit: async (repo: RepoId, commit: CommitRef) => {
    if (refuseWhileBusy(repo, "Edit commit")) return;
    const h = await history(repo);
    if (!(await confirmPushed(h, [commit.hash], "Edit Commit"))) return;
    await rewrite(repo, editPlan(h, commit.hash, commit.subject), "Done");
  },

  drop: async (repo: RepoId, commits: readonly CommitRef[]) => {
    if (refuseWhileBusy(repo, "Drop")) return;
    const h = await history(repo);
    const hashes = commits.map((c) => c.hash);
    const ok = await confirm({
      title:
        commits.length === 1 ? `Drop “${commits[0]!.subject}”?` : `Drop ${commits.length} commits?`,
      description: `The changes ${commits.length === 1 ? "it makes are" : "they make are"} removed from the branch, and the commits above are rewritten. ${
        rewritesPushed(h, hashes) ? "Some were pushed already: you will need to force push. " : ""
      }You can undo this.`,
      confirmLabel: commits.length === 1 ? "Drop Commit" : `Drop ${commits.length} Commits`,
      destructive: true,
    });
    if (ok) await rewrite(repo, dropPlan(h, hashes), `Dropped ${many(commits.length, "commit")}`);
  },

  move: async (repo: RepoId, hashes: readonly string[], direction: "up" | "down") => {
    if (refuseWhileBusy(repo, "Move")) return;
    const h = await history(repo);
    const plan = movePlan(h, hashes, direction);
    // Moving down rewrites the commit below too.
    const below = h.commits[Math.max(...hashes.map((x) => h.commits.indexOf(x))) + 1];
    const touched = direction === "down" && below ? [...hashes, below] : hashes;
    if (!(await confirmPushed(h, touched, "Move"))) return;
    await rewrite(repo, plan, `Moved ${many(hashes.length, "commit")} ${direction}`);
  },

  squash: async (repo: RepoId, hashes: readonly string[]) => {
    if (refuseWhileBusy(repo, "Squash")) return;
    const h = await history(repo);
    // Oldest first, the order their messages are combined in.
    const ordered = hashes.toSorted((a, b) => h.commits.indexOf(b) - h.commits.indexOf(a));
    const all = await Promise.all(ordered.map((x) => details(repo, x)));
    const message = await editMessage({
      title: `Squash ${hashes.length} commits`,
      description: "The commits become one, with this message, in place of the oldest.",
      confirmLabel: "Squash",
      message: combinedMessage(all.map(fullMessage)),
      commits: all.map((d) => ({ hash: d.hash, subject: d.subject })),
      ...(rewritesPushed(h, hashes) ? { warning: PUSHED_WARNING } : {}),
    });
    if (message === null) return;
    await rewrite(repo, squashPlan(h, hashes, message), `Squashed ${hashes.length} commits`);
  },

  /** Squashes `hash` into the commit below it. */
  squashIntoParent: async (repo: RepoId, hash: string) => {
    const h = await history(repo);
    const parent = h.commits[h.commits.indexOf(hash) + 1];
    if (parent) await historyCommands.squash(repo, [hash, parent]);
  },

  /** Opens the interactive rebase editor for the commits since `base`. */
  rebaseInteractive: (repo: RepoId, base: string | null, selected: readonly string[] = []) => {
    if (refuseWhileBusy(repo, "Interactive rebase")) return;
    useRepoUiStore.getState().openRebase(repo, { base, selected });
  },

  /** Opens the rebase editor for `hashes` and the commits above them. */
  rebaseFrom: async (repo: RepoId, hashes: readonly string[]) => {
    const base = rebaseBase(await history(repo), hashes);
    if (base !== undefined) historyCommands.rebaseInteractive(repo, base, hashes);
  },

  /** Picks `commits` (newest first, as the graph lists them) onto a branch the user chooses. */
  cherryPick: async (repo: RepoId, commits: readonly CommitRef[]) => {
    if (refuseWhileBusy(repo, "Cherry-pick")) return;
    const ordered = commits.toReversed();
    const options = await chooseCherryPick(repo, ordered);
    if (!options) return;
    const hashes = ordered.map((c) => c.hash);
    const what = many(commits.length, "commit");
    const onto = options.branch ? ` onto ${options.branch}` : "";
    const outcome = await runAction(
      repo,
      "Cherry-pick",
      async () => {
        try {
          return await api("repo.cherryPick", repo, hashes, options);
        } catch (e) {
          if (e instanceof ApiError && e.tag === "ConflictError") return "conflict-elsewhere";
          throw e;
        }
      },
      { status: `Cherry-picking ${what}${onto}…` },
    );
    if (outcome !== "conflict-elsewhere") {
      reportOutcome(
        repo,
        outcome,
        options.noCommit ? `Applied ${what}` : `Cherry-picked ${what}${onto}`,
      );
      return;
    }
    const branch = options.branch!;
    const ok = await confirm({
      title: `Conflicts on ${branch}`,
      description: `The ${commits.length === 1 ? "commit does" : "commits do"} not apply cleanly onto ${branch}. Check out ${branch} and cherry-pick there, to resolve the conflicts?`,
      confirmLabel: `Check Out ${branch}`,
    });
    if (!ok) return;
    if (
      (await runAction(repo, "Checkout", () =>
        api("repo.checkout", repo, branch).then(() => true),
      )) !== true
    )
      return;
    reportOutcome(
      repo,
      await runAction(repo, "Cherry-pick", () =>
        api("repo.cherryPick", repo, hashes, { ...options, branch: null }),
      ),
      `Cherry-picked ${what}`,
    );
  },

  /** Saves `commits` (newest first) as a mailbox patch. */
  savePatch: async (repo: RepoId, commits: readonly CommitRef[]) => {
    try {
      const patch = await api("repo.formatPatch", repo, commits.map((c) => c.hash).toReversed());
      const name =
        commits.length === 1
          ? `${slug(commits[0]!.subject)}.patch`
          : `${commits.length}-commits-${shortHash(commits[0]!.hash)}.patch`;
      const path = await api("dialog.saveFile", name, patch);
      if (path) notify(repo, `Saved ${path.split(/[\\/]/).at(-1)}`);
    } catch (e) {
      toast.error("Create patch failed", { description: (e as Error).message });
    }
  },

  copyPatch: async (repo: RepoId, commits: readonly CommitRef[]) => {
    try {
      const patch = await api("repo.formatPatch", repo, commits.map((c) => c.hash).toReversed());
      await navigator.clipboard.writeText(patch);
      notify(APP, "Patch copied");
    } catch (e) {
      toast.error("Copy patch failed", { description: (e as Error).message });
    }
  },

  /** Saves or copies the uncommitted changes to tracked files as a patch. */
  workingPatch: async (repo: RepoId, to: "file" | "clipboard") => {
    try {
      const patch = await api("repo.workingPatch", repo);
      if (!patch) return void notify(APP, "No changes to tracked files", "info");
      if (to === "clipboard") {
        await navigator.clipboard.writeText(patch);
        notify(APP, "Patch copied");
      } else {
        const path = await api("dialog.saveFile", "changes.patch", patch);
        if (path) notify(repo, `Saved ${path.split(/[\\/]/).at(-1)}`);
      }
    } catch (e) {
      toast.error("Create patch failed", { description: (e as Error).message });
    }
  },

  applyPatch: async (repo: RepoId) => {
    if (refuseWhileBusy(repo, "Apply patch")) return;
    const choice = await choosePatch(repo);
    if (!choice) return;
    reportOutcome(
      repo,
      await runAction(repo, "Apply patch", () =>
        api("repo.applyPatchFile", repo, choice.patch, choice.mode),
      ),
      choice.mode === "commit" ? "Patch committed" : "Patch applied",
    );
  },

  undo: async (repo: RepoId) => {
    const label = await runAction(repo, "Undo", () => api("repo.undo", repo), {
      status: "Undoing…",
    });
    if (label) notify(repo, `Undid ${lowerFirst(label)}`);
  },

  redo: async (repo: RepoId) => {
    const label = await runAction(repo, "Redo", () => api("repo.redo", repo), {
      status: "Redoing…",
    });
    if (label) notify(repo, `Redid ${lowerFirst(label)}`);
  },
};

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
