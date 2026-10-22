import type { RepoId } from "@shared/domain";
import { create } from "zustand";
import { api } from "@/lib/api";
import { forgetRepoQueries, setBackgroundRepos } from "@/lib/queries";
import { useDrafts } from "./drafts";
import { useRepoUiStore } from "./repo-ui";
import { useStatusStore } from "./status";

/** A tab either shows a repository or the "open a repository" page. */
export type Tab = { readonly key: string; readonly repo: RepoId | null };

interface TabsState {
  readonly tabs: readonly Tab[];
  readonly active: string | null;
  readonly recent: readonly RepoId[];
  readonly loaded: boolean;
  readonly load: () => Promise<void>;
  /** Opens a repository in a tab (focusing an existing one if already open). */
  readonly openRepo: (repo: RepoId, inTab?: string) => void;
  readonly newTab: () => void;
  readonly closeTab: (key: string) => void;
  readonly activate: (key: string) => void;
  /** Moves a tab to `index` in the tab order. */
  readonly moveTab: (key: string, index: number) => void;
  readonly cycle: (delta: number) => void;
  readonly removeRecent: (repo: RepoId) => void;
}

let counter = 0;
const makeKey = () => `tab-${Date.now().toString(36)}-${counter++}`;

const saveState = (s: TabsState) => {
  const tabs = s.tabs.flatMap((t) => (t.repo ? [t.repo] : []));
  const activeTab = s.tabs.find((t) => t.key === s.active)?.repo ?? null;
  void api("app.setState", { tabs, activeTab, recent: [...s.recent] }).catch(() => {});
};

/**
 * Forgets a closed repository: its cached data (reopening it starts afresh, and the main
 * process starts a new graph), its selection and its notices. A commit message the user wrote
 * stays; amending, with the previous commit's message prefilled for it, does not.
 */
const forgetRepo = (repo: RepoId) => {
  forgetRepoQueries(repo);
  useRepoUiStore.getState().forget(repo);
  useDrafts.getState().stopAmending(repo);
  useStatusStore.setState((s) => {
    const { [repo]: _, ...notices } = s.notices;
    return { notices };
  });
};

export const useTabs = create<TabsState>()((set, get) => {
  const update = (partial: Partial<TabsState>) => {
    set(partial);
    saveState(get());
  };

  return {
    tabs: [],
    active: null,
    recent: [],
    loaded: false,

    async load() {
      let state: { tabs: readonly RepoId[]; activeTab: RepoId | null; recent: readonly RepoId[] };
      try {
        state = await api("app.getState");
      } catch (e) {
        // Start with a blank tab rather than a spinner forever.
        console.error("Could not load the saved tabs", e);
        state = { tabs: [], activeTab: null, recent: [] };
      }
      const tabs: Tab[] = state.tabs.map((repo) => ({ key: makeKey(), repo }));
      if (tabs.length === 0) tabs.push({ key: makeKey(), repo: null });
      const active = tabs.find((t) => t.repo === state.activeTab)?.key ?? tabs[0]!.key;
      set({ tabs, active, recent: [...state.recent], loaded: true });
    },

    openRepo(repo, inTab) {
      const { tabs, recent } = get();
      const nextRecent = [repo, ...recent.filter((r) => r !== repo)].slice(0, 30);
      const existing = tabs.find((t) => t.repo === repo);
      if (existing) {
        // Opening an already-open repo from a blank tab: drop the blank tab.
        const rest = inTab ? tabs.filter((t) => t.key !== inTab || t.repo !== null) : tabs;
        update({ tabs: rest, active: existing.key, recent: nextRecent });
        return;
      }
      // Fill a blank tab: the requested one if it is still blank (it may have been closed or
      // filled while the repository was opening), else the active one if blank (e.g. the tab
      // that replaced the closed one).
      const blank = (key: string | null | undefined) =>
        tabs.find((t) => t.key === key && t.repo === null)?.key;
      const target = blank(inTab) ?? blank(get().active);
      if (target) {
        update({
          tabs: tabs.map((t) => (t.key === target ? { key: t.key, repo } : t)),
          active: target,
          recent: nextRecent,
        });
      } else {
        const tab = { key: makeKey(), repo };
        update({ tabs: [...tabs, tab], active: tab.key, recent: nextRecent });
      }
    },

    newTab() {
      const blank = get().tabs.find((t) => t.repo === null);
      if (blank) {
        update({ active: blank.key });
        return;
      }
      const tab = { key: makeKey(), repo: null };
      update({ tabs: [...get().tabs, tab], active: tab.key });
    },

    closeTab(key) {
      const { tabs, active } = get();
      const index = tabs.findIndex((t) => t.key === key);
      if (index < 0) return;
      const closing = tabs[index]!;
      let next = tabs.filter((t) => t.key !== key);
      if (next.length === 0) next = [{ key: makeKey(), repo: null }];
      const nextActive =
        active === key ? (next[Math.min(index, next.length - 1)]?.key ?? null) : active;
      update({ tabs: next, active: nextActive });
      if (closing.repo && !next.some((t) => t.repo === closing.repo)) {
        // Forget before closing, so that nothing asks the main process (which would reopen
        // the repository) once it is closed.
        forgetRepo(closing.repo);
        void api("repo.close", closing.repo).catch(() => {});
      }
    },

    activate(key) {
      if (get().active !== key) update({ active: key });
    },

    moveTab(key, index) {
      const { tabs } = get();
      const tab = tabs.find((t) => t.key === key);
      if (!tab || tabs[index]?.key === key) return;
      const rest = tabs.filter((t) => t.key !== key);
      const at = Math.max(0, Math.min(index, rest.length));
      update({ tabs: [...rest.slice(0, at), tab, ...rest.slice(at)] });
    },

    cycle(delta) {
      const { tabs, active } = get();
      if (tabs.length < 2) return;
      const i = tabs.findIndex((t) => t.key === active);
      update({ active: tabs[(i + delta + tabs.length) % tabs.length]!.key });
    },

    removeRecent(repo) {
      update({ recent: get().recent.filter((r) => r !== repo) });
    },
  };
});

// Repositories in background tabs refresh when shown, not on every change. A repository that
// the active tab shows is not in the background, whatever other tabs show it too.
useTabs.subscribe((s, prev) => {
  if (s.tabs === prev.tabs && s.active === prev.active) return;
  const shown = s.tabs.find((t) => t.key === s.active)?.repo;
  setBackgroundRepos(s.tabs.flatMap((t) => (t.repo && t.repo !== shown ? [t.repo] : [])));
});
