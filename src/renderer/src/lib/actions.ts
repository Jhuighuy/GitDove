import type { Outcome, RepoId } from "@shared/domain";
import { toast } from "sonner";
import { busyOf, busyReason, useBusyStore } from "@/stores/busy";
import { notify } from "@/stores/status";
import { ApiError } from "./api";
import { keys, queryClient } from "./queries";

interface RunOptions {
  /** What is running, for the status bar (for slow, network-bound operations). */
  readonly progress?: string;
  /** Shown in the status bar once it succeeded. */
  readonly success?: string;
  /** What is running, for the busy indicator; defaults to `progress`, then `label`. */
  readonly status?: string;
  /** Lets the user cancel it from the busy indicator (network operations). */
  readonly cancellable?: boolean;
}

/**
 * Tells the user that `label` cannot start because another operation is
 * running in `repo`, and returns whether that is the case.
 */
export const refuseWhileBusy = (repo: RepoId, label: string): boolean => {
  const busy = busyOf(repo);
  if (busy) toast.warning(`Cannot ${label.toLowerCase()} now`, { description: busyReason(busy) });
  return busy !== null;
};

/**
 * Runs a repository-mutating action, reporting failures as toasts (progress and
 * results go to the status bar) and refreshing the repository's data afterwards. Actions run one at a time per
 * repository: while one runs, the repository is busy (see `stores/busy.ts`)
 * and starting another is refused.
 */
export const runAction = async <A>(
  repo: RepoId,
  label: string,
  fn: () => Promise<A>,
  options: RunOptions = {},
): Promise<A | undefined> => {
  if (refuseWhileBusy(repo, label)) return undefined;
  const busy = useBusyStore.getState();
  busy.start(repo, {
    label: options.status ?? options.progress ?? `${label}…`,
    cancellable: options.cancellable ?? false,
  });
  try {
    const result = await fn();
    if (options.success) notify(repo, options.success);
    return result;
  } catch (e) {
    if (e instanceof ApiError && e.tag === "CancelledError") {
      notify(repo, `${label} cancelled`, "info");
      return undefined;
    }
    const message = e instanceof Error ? e.message : String(e);
    const detail = e instanceof ApiError ? e.detail : undefined;
    toast.error(`${label} failed`, {
      description: detail && detail !== message ? `${message}\n\n${detail}` : message,
      duration: 10000,
    });
    return undefined;
  } finally {
    busy.finish(repo);
    // Watchers will pick up changes too, but refresh eagerly for snappiness.
    void queryClient.invalidateQueries({ queryKey: keys.info(repo) });
    void queryClient.invalidateQueries({ queryKey: keys.refs(repo) });
    void queryClient.invalidateQueries({ queryKey: keys.status(repo) });
    void queryClient.invalidateQueries({ queryKey: keys.editable(repo) });
    void queryClient.invalidateQueries({ queryKey: keys.undo(repo) });
  }
};

/**
 * Reports how an operation that can stop part way ended: `done` when it finished, or that it
 * stopped (the operation bar then shows what to do). Nothing when it failed (`undefined`).
 */
export const reportOutcome = (repo: RepoId, outcome: Outcome | undefined, done: string) => {
  if (outcome === "done") notify(repo, done);
  else if (outcome === "conflicts")
    notify(repo, "Stopped at conflicts: resolve them, then continue", "info");
  else if (outcome === "stopped")
    notify(repo, "Stopped to edit a commit: change it, then continue", "info");
};
