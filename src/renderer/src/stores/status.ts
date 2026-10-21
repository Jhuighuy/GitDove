import type { RepoId } from "@shared/domain";
import { create } from "zustand";

/**
 * What the status bar reports besides the running operation (`stores/busy.ts`): results that
 * fade after a while, and app-wide activity. Toasts are left for errors, which need attention.
 */

/** Notices that are not about one repository, e.g. copying to the clipboard. */
export const APP = "app";

/** How long a notice stays in the status bar. */
export const NOTICE_MS = 5000;

export interface Notice {
  readonly text: string;
  readonly kind: "success" | "info";
}

interface StatusState {
  /** The latest notice per repository (or {@link APP}). */
  readonly notices: Readonly<Record<string, Notice & { readonly id: number }>>;
  /** Something app-wide in progress, e.g. "Connecting to fedora…". */
  readonly activity: string | null;
  notify(scope: RepoId | typeof APP, text: string, kind?: Notice["kind"]): void;
  setActivity(activity: string | null): void;
}

let nextId = 0;

export const useStatusStore = create<StatusState>()((set, get) => ({
  notices: {},
  activity: null,
  notify: (scope, text, kind = "success") => {
    const id = ++nextId;
    set((s) => ({ notices: { ...s.notices, [scope]: { text, kind, id } } }));
    setTimeout(() => {
      // A newer notice replaced it meanwhile: leave that one.
      if (get().notices[scope]?.id !== id) return;
      const { [scope]: _, ...rest } = get().notices;
      set({ notices: rest });
    }, NOTICE_MS);
  },
  setActivity: (activity) => set({ activity }),
}));

/** Shows a short-lived result in the status bar. */
export const notify = (scope: RepoId | typeof APP, text: string, kind?: Notice["kind"]) =>
  useStatusStore.getState().notify(scope, text, kind);

export const useNotice = (scope: RepoId | typeof APP | null): Notice | null =>
  useStatusStore((s) => (scope ? (s.notices[scope] ?? null) : null));
