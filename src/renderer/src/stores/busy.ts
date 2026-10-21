import type { RepoId } from "@shared/domain";
import { create } from "zustand";

/** The repository-changing operation running in a repository (see `runAction`). */
export interface Busy {
  /** What is running, e.g. "Checking out feature…". */
  readonly label: string;
  /** Whether it can be cancelled (fetch, pull and push). */
  readonly cancellable: boolean;
}

interface BusyState {
  readonly byRepo: Readonly<Record<RepoId, Busy>>;
  start(repo: RepoId, busy: Busy): void;
  finish(repo: RepoId): void;
}

export const useBusyStore = create<BusyState>()((set) => ({
  byRepo: {},
  start: (repo, busy) => set((s) => ({ byRepo: { ...s.byRepo, [repo]: busy } })),
  finish: (repo) =>
    set((s) => {
      const { [repo]: _, ...rest } = s.byRepo;
      return { byRepo: rest };
    }),
}));

/** The operation running in `repo`, if any; write actions are disabled meanwhile. */
export const useBusy = (repo: RepoId): Busy | null => useBusyStore((s) => s.byRepo[repo] ?? null);

export const busyOf = (repo: RepoId): Busy | null => useBusyStore.getState().byRepo[repo] ?? null;

/** Explains why a write action is disabled. */
export const busyReason = (busy: Busy) => `${busy.label} Wait for it to finish.`;

/** Props for a control that changes the repository: disabled, with a reason, while busy. */
export const writeProps = (busy: Busy | null, disabled = false) => ({
  disabled: disabled || busy !== null,
  title: busy ? busyReason(busy) : undefined,
});
