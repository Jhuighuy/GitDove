import type { PickedCommit, Selection } from "@/stores/repo-ui";

/** The most commits a Shift-click selects. */
export const MAX_RANGE = 1000;

const byIndex = (a: PickedCommit, b: PickedCommit) => a.index - b.index;

/** The selection for `picked` commits (any order), clicked last at `anchor`. */
export const selectionOf = (picked: readonly PickedCommit[], anchor: string): Selection | null => {
  if (picked.length === 0) return null;
  if (picked.length === 1) return { kind: "commit", hash: picked[0]!.row.hash };
  const unique = new Map(picked.map((p) => [p.row.hash, p]));
  if (unique.size === 1) return { kind: "commit", hash: picked[0]!.row.hash };
  return { kind: "commits", commits: [...unique.values()].toSorted(byIndex), anchor };
};

/** Adds `commit` to the picked ones, or takes it out when it was picked. */
export const toggled = (
  picked: readonly PickedCommit[],
  commit: PickedCommit,
): readonly PickedCommit[] =>
  picked.some((p) => p.row.hash === commit.row.hash)
    ? picked.filter((p) => p.row.hash !== commit.row.hash)
    : [...picked, commit];

/** Graph indexes from `a` to `b`, either way round, at most {@link MAX_RANGE} from `b`. */
export const rangeIndexes = (a: number, b: number): readonly [number, number] => {
  const from = a < b ? Math.max(a, b - MAX_RANGE + 1) : Math.min(a, b + MAX_RANGE - 1);
  return [Math.min(from, b), Math.max(from, b)];
};
