import type { RepoId } from "@shared/domain";
import { create } from "zustand";
import { api } from "@/lib/api";

/** A tab either shows a repository or the "open a repository" page. */
export type Tab = { readonly key: string; readonly repo: RepoId | null };

interface TabsState {
  readonly tabs: readonly Tab[];
  readonly active: string | null;
  readonly recent: readonly RepoId[];
  readonly loaded: boolean;
  load(): Promise<void>;
  /** Opens a repository in a tab (focusing an existing one if already open). */
  openRepo(repo: RepoId, inTab?: string): void;
  newTab(): void;
  closeTab(key: string): void;
  activate(key: string): void;
  cycle(delta: number): void;
  removeRecent(repo: RepoId): void;
}

let counter = 0;
const makeKey = () => `tab-${Date.now().toString(36)}-${counter++}`;

const persist = (s: TabsState) => {
  const tabs = s.tabs.flatMap((t) => (t.repo ? [t.repo] : []));
  const activeTab = s.tabs.find((t) => t.key === s.active)?.repo ?? null;
  void api("app.setState", { tabs, activeTab, recent: [...s.recent] }).catch(() => {});
};

export const useTabs = create<TabsState>()((set, get) => {
  const update = (partial: Partial<TabsState>) => {
    set(partial);
    persist(get());
  };

  return {
    tabs: [],
    active: null,
    recent: [],
    loaded: false,

    async load() {
      const state = await api("app.getState");
      const tabs: Tab[] = state.tabs.map((repo) => ({ key: makeKey(), repo }));
      if (tabs.length === 0) tabs.push({ key: makeKey(), repo: null });
      const active = tabs.find((t) => t.repo === state.activeTab)?.key ?? tabs[0]!.key;
      set({ tabs, active, recent: state.recent, loaded: true });
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
      const target = inTab ?? tabs.find((t) => t.key === get().active && t.repo === null)?.key;
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
      if (closing.repo && !tabs.some((t) => t.key !== key && t.repo === closing.repo)) {
        void api("repo.close", closing.repo).catch(() => {});
      }
      let next = tabs.filter((t) => t.key !== key);
      if (next.length === 0) next = [{ key: makeKey(), repo: null }];
      const nextActive =
        active === key ? (next[Math.min(index, next.length - 1)]?.key ?? null) : active;
      update({ tabs: next, active: nextActive });
    },

    activate(key) {
      if (get().active !== key) update({ active: key });
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
