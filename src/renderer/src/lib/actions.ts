import type { RepoId } from "@shared/domain";
import { repoDisplayName, repoLocationOf } from "@shared/domain";
import { toast } from "sonner";
import { busyOf, busyReason, useBusyStore } from "@/stores/busy";
import { APP, notify } from "@/stores/status";
import { useTabs } from "@/stores/tabs";
import { ApiError } from "./api";
import { type DataScope, REPOSITORY, refreshRepo, takeHeldChanges } from "./queries";

export interface RunOptions {
  /** What is running, for the busy indicator in the status bar; defaults to "<label>…". */
  readonly status?: string;
  /** Shown in the status bar once it succeeded. */
  readonly success?: string;
  /**
   * A network operation: the user can cancel it from the busy indicator at once (other
   * operations once they take a while), and change events are applied while it runs.
   */
  readonly cancellable?: boolean;
  /**
   * What the action can change: refreshed before the repository stops being busy, so that write
   * controls come back with fresh data on screen. Defaults to {@link REPOSITORY}.
   */
  readonly invalidates?: readonly DataScope[];
  /** Runs once the action may start, before it does, e.g. to update the cache optimistically. */
  readonly optimistic?: () => void | Promise<void>;
}

/** How a {@link runAction} ended: failures and cancellations were already reported. */
export type ActionResult<A> = { readonly ok: true; readonly value: A } | { readonly ok: false };

const FAILED = { ok: false } as const;

/** How long an action waits for the refresh after it before it stops being busy anyway. */
const REFRESH_WAIT_MS = 15_000;

/**
 * Tells the user that `label` cannot start because another operation is
 * running in `repo`, and returns whether that is the case.
 */
export const refuseWhileBusy = (repo: RepoId, label: string): boolean => {
  const busy = busyOf(repo);
  if (busy) toast.warning(`Cannot ${label.toLowerCase()} now`, { description: busyReason(busy) });
  return busy !== null;
};

/** Names the repository in a message unless it is the one on screen. */
const where = (repo: RepoId): string => {
  const { tabs, active } = useTabs.getState();
  if (tabs.find((t) => t.key === active)?.repo === repo) return "";
  try {
    return ` in ${repoDisplayName(repoLocationOf(repo))}`;
  } catch {
    return "";
  }
};

/** Reports a failed action as a toast, with git's output as copyable details. */
const reportFailure = (repo: RepoId, label: string, e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  const detail = e instanceof ApiError ? e.detail : undefined;
  const description = detail && detail !== message ? `${message}\n\n${detail}` : message;
  toast.error(`${label} failed${where(repo)}`, {
    description,
    duration: 10000,
    action: {
      label: "Copy",
      onClick: () => {
        navigator.clipboard.writeText(description).then(
          () => notify(APP, "Error details copied"),
          () => {},
        );
      },
    },
  });
};

/**
 * Runs a repository-changing action. Failures are reported as toasts; progress and results go
 * to the status bar. Actions run one at a time per repository: while one runs, the repository
 * is busy (see `stores/busy.ts`) and starting another is refused. Once done, what it may have
 * changed is refreshed before the repository stops being busy.
 */
export const runAction = async <A>(
  repo: RepoId,
  label: string,
  fn: () => Promise<A>,
  options: RunOptions = {},
): Promise<ActionResult<A>> => {
  if (refuseWhileBusy(repo, label)) return FAILED;
  const busy = useBusyStore.getState();
  busy.start(repo, {
    label: options.status ?? `${label}…`,
    cancellable: options.cancellable ?? false,
  });
  try {
    if (options.optimistic) await options.optimistic();
    const value = await fn();
    if (options.success) notify(repo, options.success);
    return { ok: true, value };
  } catch (e) {
    if (e instanceof ApiError && e.tag === "CancelledError") {
      notify(repo, `${label} cancelled`, "info");
    } else {
      reportFailure(repo, label, e);
    }
    return FAILED;
  } finally {
    // Watchers pick up changes too, but later (seconds over SSH), and change events that
    // arrived meanwhile were held back (see `useRepoEvents`).
    // A refresh that hangs (a stalled connection) must not keep the repository busy for good.
    busy.refreshing(repo);
    const refreshed = refreshRepo(repo, [
      ...(options.invalidates ?? REPOSITORY),
      ...takeHeldChanges(repo),
    ]);
    await Promise.race([refreshed, new Promise((r) => setTimeout(r, REFRESH_WAIT_MS))]);
    busy.finish(repo);
    // Changes reported between the refresh and now.
    const late = takeHeldChanges(repo);
    if (late.size > 0) void refreshRepo(repo, late);
  }
};
