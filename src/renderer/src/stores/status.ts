import { create } from "zustand";

/**
 * What the status bar reports besides the running operation (`stores/busy.ts`): results that
 * fade after a while, and app-wide activity. Toasts are left for errors, which need attention.
 */

/** Notices that are not about one repository, e.g. copying to the clipboard. */
export const APP = "app";

/** Whose notice it is: a repository's id, or {@link APP}. */
export type Scope = string;

/** How long a notice stays in the status bar. */
export const NOTICE_MS = 5000;

export interface Notice {
  readonly text: string;
  readonly kind: "success" | "info";
}

interface StatusState {
  /** The latest notice per repository (or {@link APP}). */
  readonly notices: Readonly<Record<string, Notice & { readonly id: number }>>;
  /** App-wide work in progress, e.g. "Connecting to fedora…", oldest first. */
  readonly activities: readonly { readonly id: number; readonly text: string }[];
  notify(scope: Scope, text: string, kind?: Notice["kind"]): void;
  /** Shows `text` until the returned function is called. */
  startActivity(text: string): () => void;
}

let nextId = 0;

export const useStatusStore = create<StatusState>()((set, get) => ({
  notices: {},
  activities: [],
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
  startActivity: (text) => {
    const id = ++nextId;
    set((s) => ({ activities: [...s.activities, { id, text }] }));
    // Several can overlap (e.g. two repositories opening): each removes only its own.
    return () => set((s) => ({ activities: s.activities.filter((a) => a.id !== id) }));
  },
}));

/** Shows a short-lived result in the status bar. */
export const notify = (scope: Scope, text: string, kind?: Notice["kind"]) =>
  useStatusStore.getState().notify(scope, text, kind);

export const useNotice = (scope: Scope | null): Notice | null =>
  useStatusStore((s) => (scope ? (s.notices[scope] ?? null) : null));

/** The most recent app-wide activity still in progress, if any. */
export const useActivity = (): string | null =>
  useStatusStore((s) => s.activities.at(-1)?.text ?? null);
