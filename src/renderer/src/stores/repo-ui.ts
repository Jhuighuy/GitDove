import type { DiffTarget, GraphRow, RepoId } from "@shared/domain";
import type { DiffViewId } from "@/features/diff/views";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/** A selected commit and where it sits in the graph. */
export interface PickedCommit {
  readonly index: number;
  readonly row: GraphRow;
}

export type Selection =
  | { readonly kind: "wip" }
  | { readonly kind: "commit"; readonly hash: string }
  /**
   * Two or more commits, newest (topmost) first. `anchor` is the commit last clicked, where a
   * Shift-click range starts; the indexes are those of graph `version`.
   */
  | {
      readonly kind: "commits";
      readonly commits: readonly PickedCommit[];
      readonly anchor: string;
      readonly version: number;
    };

interface RepoUi {
  readonly selection: Selection | null;
  readonly diff: DiffTarget | null;
  /** Bumped to ask the graph to scroll to the selected commit. */
  readonly revealToken: number;
  /**
   * Set to a new value to ask the commit box to take the focus. Values never repeat (also for
   * a reopened repository), so the box can remember which requests it handled.
   */
  readonly commitFocusToken: number;
}

const EMPTY: RepoUi = { selection: null, diff: null, revealToken: 0, commitFocusToken: 0 };

let focusRequests = 0;

interface RepoUiState {
  readonly byRepo: Readonly<Record<RepoId, RepoUi>>;
  select(repo: RepoId, selection: Selection | null, reveal?: boolean): void;
  openDiff(repo: RepoId, diff: DiffTarget | null): void;
  /** Shows the working tree changes and focuses the commit message. */
  focusCommit(repo: RepoId): void;
  /** Drops the state of a closed repository. */
  forget(repo: RepoId): void;
}

export const useRepoUiStore = create<RepoUiState>()((set) => ({
  byRepo: {},
  select: (repo, selection, reveal = false) =>
    set((s) => {
      const cur = s.byRepo[repo] ?? EMPTY;
      return {
        byRepo: {
          ...s.byRepo,
          [repo]: {
            ...cur,
            selection,
            // Changing selection closes a diff that belongs to the old selection.
            diff: sameSelection(cur.selection, selection) ? cur.diff : null,
            revealToken: reveal ? cur.revealToken + 1 : cur.revealToken,
          },
        },
      };
    }),
  openDiff: (repo, diff) =>
    set((s) => ({ byRepo: { ...s.byRepo, [repo]: { ...(s.byRepo[repo] ?? EMPTY), diff } } })),
  focusCommit: (repo) =>
    set((s) => {
      const cur = s.byRepo[repo] ?? EMPTY;
      const wip = cur.selection === null || cur.selection.kind === "wip";
      return {
        byRepo: {
          ...s.byRepo,
          [repo]: {
            ...cur,
            selection: { kind: "wip" },
            diff: wip ? cur.diff : null,
            commitFocusToken: ++focusRequests,
          },
        },
      };
    }),
  forget: (repo) =>
    set((s) => {
      const { [repo]: _, ...rest } = s.byRepo;
      return { byRepo: rest };
    }),
}));

const sameSelection = (a: Selection | null, b: Selection | null): boolean => {
  if (!a || !b) return a === b;
  if (a.kind === "commit") return b.kind === "commit" && a.hash === b.hash;
  if (a.kind === "commits")
    return (
      b.kind === "commits" &&
      a.commits.length === b.commits.length &&
      a.commits.every((c, i) => c.row.hash === b.commits[i]!.row.hash)
    );
  return a.kind === b.kind;
};

/** Hashes of the selected commits. */
export const selectedHashes = (selection: Selection | null): ReadonlySet<string> =>
  new Set(
    selection?.kind === "commit"
      ? [selection.hash]
      : selection?.kind === "commits"
        ? selection.commits.map((c) => c.row.hash)
        : [],
  );

export const useRepoUi = (repo: RepoId): RepoUi => useRepoUiStore((s) => s.byRepo[repo] ?? EMPTY);

export type DiffMode = "unified" | "split";

/** Sizes of the side panels, in percent of the window width. */
export interface PanelSizes {
  readonly sidebar?: number;
  readonly details?: number;
}

interface LayoutState {
  readonly sidebar: boolean;
  readonly details: boolean;
  readonly panels: PanelSizes;
  /** Collapsed sections of the details panel, by title. */
  readonly collapsed: Readonly<Record<string, boolean>>;
  readonly diffMode: DiffMode;
  /** Preferred view per kind of file (see `fileKind`). */
  readonly diffViews: Readonly<Record<string, DiffViewId>>;
  toggleSidebar(): void;
  toggleDetails(): void;
  showDetails(): void;
  setPanels(sizes: PanelSizes): void;
  setCollapsed(section: string, collapsed: boolean): void;
  setDiffMode(mode: DiffMode): void;
  setDiffView(kind: string, view: DiffViewId): void;
}

export const useLayout = create<LayoutState>()(
  persist(
    (set) => ({
      sidebar: true,
      details: true,
      panels: {},
      collapsed: {},
      diffMode: "unified",
      diffViews: {},
      toggleSidebar: () => set((s) => ({ sidebar: !s.sidebar })),
      toggleDetails: () => set((s) => ({ details: !s.details })),
      showDetails: () => set({ details: true }),
      setPanels: (sizes) => set((s) => ({ panels: { ...s.panels, ...sizes } })),
      setCollapsed: (section, collapsed) =>
        set((s) => ({ collapsed: { ...s.collapsed, [section]: collapsed } })),
      setDiffMode: (diffMode) => set({ diffMode }),
      setDiffView: (kind, view) => set((s) => ({ diffViews: { ...s.diffViews, [kind]: view } })),
    }),
    { name: "gitdove.layout" },
  ),
);
