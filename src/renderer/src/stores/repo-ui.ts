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
   * Shift-click range starts.
   */
  | {
      readonly kind: "commits";
      readonly commits: readonly PickedCommit[];
      readonly anchor: string;
    };

interface RepoUi {
  readonly selection: Selection | null;
  readonly diff: DiffTarget | null;
  /** Bumped to ask the graph to scroll to the selected commit. */
  readonly revealToken: number;
}

const EMPTY: RepoUi = { selection: null, diff: null, revealToken: 0 };

interface RepoUiState {
  readonly byRepo: Readonly<Record<RepoId, RepoUi>>;
  select(repo: RepoId, selection: Selection | null, reveal?: boolean): void;
  openDiff(repo: RepoId, diff: DiffTarget | null): void;
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

interface LayoutState {
  readonly sidebar: boolean;
  readonly details: boolean;
  readonly diffMode: DiffMode;
  /** Preferred view per kind of file (see `fileKind`). */
  readonly diffViews: Readonly<Record<string, DiffViewId>>;
  toggleSidebar(): void;
  toggleDetails(): void;
  setDiffMode(mode: DiffMode): void;
  setDiffView(kind: string, view: DiffViewId): void;
}

export const useLayout = create<LayoutState>()(
  persist(
    (set) => ({
      sidebar: true,
      details: true,
      diffMode: "unified",
      diffViews: {},
      toggleSidebar: () => set((s) => ({ sidebar: !s.sidebar })),
      toggleDetails: () => set((s) => ({ details: !s.details })),
      setDiffMode: (diffMode) => set({ diffMode }),
      setDiffView: (kind, view) => set((s) => ({ diffViews: { ...s.diffViews, [kind]: view } })),
    }),
    { name: "gitdove.layout" },
  ),
);
