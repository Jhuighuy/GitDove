import type { RepoId } from "@shared/domain";
import { create } from "zustand";

/** The repository-changing operation running in a repository (see `runAction`). */
export interface Busy {
  /** What is running, e.g. "Checking out feature…". */
  readonly label: string;
  /**
   * Whether it is a network operation (fetch, pull, push), which can be cancelled right away.
   * Others can be cancelled too once they take a while, e.g. a commit hook waiting for input.
   */
  readonly cancellable: boolean;
  /**
   * Whether the operation itself is done and what it changed is being refreshed: there is
   * nothing left to cancel.
   */
  readonly refreshing: boolean;
  /** When it started (`Date.now()`). */
  readonly since: number;
}

interface BusyState {
  readonly byRepo: Readonly<Record<RepoId, Busy>>;
  readonly start: (repo: RepoId, busy: Pick<Busy, "label" | "cancellable">) => void;
  /** Marks the operation in `repo` done, and the refresh after it running. */
  readonly refreshing: (repo: RepoId) => void;
  readonly finish: (repo: RepoId) => void;
}

export const useBusyStore = create<BusyState>()((set) => ({
  byRepo: {},
  start: (repo, busy) =>
    set((s) => ({
      byRepo: { ...s.byRepo, [repo]: { ...busy, refreshing: false, since: Date.now() } },
    })),
  refreshing: (repo) =>
    set((s) => {
      const busy = s.byRepo[repo];
      if (!busy || busy.refreshing) return s;
      return { byRepo: { ...s.byRepo, [repo]: { ...busy, refreshing: true } } };
    }),
  finish: (repo) =>
    set((s) => {
      const { [repo]: _, ...rest } = s.byRepo;
      return { byRepo: rest };
    }),
}));

/** The operation running in `repo`, if any; write actions are disabled meanwhile. */
export const useBusy = (repo: RepoId): Busy | null => useBusyStore((s) => s.byRepo[repo] ?? null);

export const busyOf = (repo: RepoId): Busy | null => useBusyStore.getState().byRepo[repo] ?? null;

/** What is happening, e.g. for the status bar. */
export const busyLabel = (busy: Busy) => (busy.refreshing ? "Refreshing…" : busy.label);

/** Explains why a write action is disabled. */
export const busyReason = (busy: Busy) => `${busyLabel(busy)} Wait for it to finish.`;

/** Props for a control that changes the repository: disabled, with a reason, while busy. */
export const writeProps = (busy: Busy | null, disabled = false) => ({
  disabled: disabled || busy !== null,
  title: busy ? busyReason(busy) : undefined,
});
