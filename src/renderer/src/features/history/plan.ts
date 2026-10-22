/**
 * Plans for editing the current branch's history: the quick actions of the commit menu (move,
 * drop, squash, edit) and the interactive rebase editor's rows, turned into `RewritePlan`s.
 */
import type { EditableHistory, RebaseCommit, RebaseStep, RewritePlan } from "@shared/domain";

/** Where `hashes` sit in the editable history (newest first), or null if one is not in it. */
const indexesOf = (history: EditableHistory, hashes: readonly string[]): number[] | null => {
  const at = new Map(history.commits.map((h, i) => [h, i]));
  const indexes = hashes.map((h) => at.get(h) ?? -1);
  return indexes.includes(-1) ? null : indexes.toSorted((a, b) => a - b);
};

/** Whether all of `hashes` are in the editable history. */
export const editable = (history: EditableHistory | undefined, hashes: readonly string[]) =>
  !!history && hashes.length > 0 && indexesOf(history, hashes) !== null;

/** Whether `hashes` are next to each other in the history. */
export const contiguous = (history: EditableHistory | undefined, hashes: readonly string[]) => {
  const indexes = history ? indexesOf(history, hashes) : null;
  return !!indexes && indexes.every((i, k) => k === 0 || i === indexes[k - 1]! + 1);
};

/** The commits from the one at `index` up to HEAD, oldest first, and the commit below them. */
const rangeTo = (history: EditableHistory, index: number) => ({
  base: history.commits[index + 1] ?? history.bottom,
  commits: history.commits.slice(0, index + 1).toReversed(),
});

const plan = (base: string | null, steps: readonly RebaseStep[], label: string): RewritePlan => ({
  base,
  steps,
  label,
});

const pick = (hash: string): RebaseStep => ({ hash, action: "pick" });

const many = (verb: string, count: number, one: string) =>
  count === 1 ? `${verb} ${one}` : `${verb} ${count} commits`;

/** Drops `hashes` from the history. */
export const dropPlan = (history: EditableHistory, hashes: readonly string[]) => {
  const indexes = indexesOf(history, hashes);
  if (!indexes) return null;
  const dropped = new Set(hashes);
  const { base, commits } = rangeTo(history, indexes.at(-1)!);
  return plan(
    base,
    commits.map((h) => (dropped.has(h) ? { hash: h, action: "drop" } : pick(h))),
    many("Drop", hashes.length, "commit"),
  );
};

/**
 * Moves a block of adjacent commits one place up (newer, towards HEAD) or down (older), past
 * the commit next to it. Null if the commits are not adjacent or are at that end already.
 */
export const movePlan = (
  history: EditableHistory,
  hashes: readonly string[],
  direction: "up" | "down",
) => {
  const indexes = indexesOf(history, hashes);
  if (!indexes || !contiguous(history, hashes)) return null;
  const top = indexes[0]!;
  const bottom = indexes.at(-1)!;
  if (direction === "up" ? top === 0 : bottom + 1 >= history.commits.length) return null;
  const { base, commits } = rangeTo(history, direction === "up" ? bottom : bottom + 1);
  // Oldest first, the block is at p..q; it swaps with the commit after (up) or before (down) it.
  const p = commits.indexOf(history.commits[bottom]!);
  const q = p + hashes.length - 1;
  const block = commits.slice(p, q + 1);
  const order =
    direction === "up"
      ? [...commits.slice(0, p), commits[q + 1]!, ...block, ...commits.slice(q + 2)]
      : [...commits.slice(0, p - 1), ...block, commits[p - 1]!, ...commits.slice(q + 1)];
  return plan(base, order.map(pick), `${many("Move", hashes.length, "commit")} ${direction}`);
};

/**
 * Squashes `hashes` into the oldest of them, with `message`: the others move up to it (if they
 * are not next to it already) and are folded into it.
 */
export const squashPlan = (
  history: EditableHistory,
  hashes: readonly string[],
  message: string,
) => {
  const indexes = indexesOf(history, hashes);
  if (!indexes || indexes.length < 2) return null;
  const { base, commits } = rangeTo(history, indexes.at(-1)!);
  const squashed = new Set(hashes);
  const [target, ...folded] = commits.filter((h) => squashed.has(h));
  const steps: RebaseStep[] = [];
  for (const h of commits) {
    if (h === target) {
      steps.push({ hash: h, action: "pick", message });
      for (const f of folded) steps.push({ hash: f, action: "fixup" });
    } else if (!squashed.has(h)) steps.push(pick(h));
  }
  return plan(base, steps, `Squash ${hashes.length} commits`);
};

/**
 * The plan that turns the history (newest first) into `order` (all of it, newest first):
 * everything above the deepest commit that changes place is rewritten. Null if nothing moves.
 */
const planFor = (history: EditableHistory, order: readonly RebaseStep[], label: string) => {
  let deepest = -1;
  order.forEach((step, i) => {
    if (step.hash !== history.commits[i] || step.action !== "pick" || step.message) deepest = i;
  });
  if (deepest < 0) return null;
  const { base } = rangeTo(history, deepest);
  return plan(base, order.slice(0, deepest + 1).toReversed(), label);
};

/**
 * Moves `hashes` (keeping their order) next to `target`, above (newer) or below (older) it, as
 * dragging them there in the graph does.
 */
export const reorderPlan = (
  history: EditableHistory,
  hashes: readonly string[],
  target: string,
  side: "above" | "below",
) => {
  if (!indexesOf(history, [...hashes, target]) || hashes.includes(target)) return null;
  const moved = new Set(hashes);
  const block = history.commits.filter((h) => moved.has(h));
  const rest = history.commits.filter((h) => !moved.has(h));
  const at = rest.indexOf(target) + (side === "below" ? 1 : 0);
  const order = [...rest.slice(0, at), ...block, ...rest.slice(at)].map(pick);
  return planFor(history, order, many("Move", hashes.length, "commit"));
};

/** Squashes `hashes` into `target`, where `target` is, with `message`. */
export const squashOntoPlan = (
  history: EditableHistory,
  hashes: readonly string[],
  target: string,
  message: string,
) => {
  if (!indexesOf(history, [...hashes, target]) || hashes.includes(target)) return null;
  const folded = new Set(hashes);
  const order: RebaseStep[] = [];
  for (const h of history.commits) {
    if (folded.has(h)) continue;
    // Newest first, what is folded sits right above the commit it is folded into.
    if (h === target) {
      for (const f of history.commits.filter((x) => folded.has(x)))
        order.push({ hash: f, action: "fixup" });
      order.push({ hash: h, action: "pick", message });
    } else order.push(pick(h));
  }
  return planFor(history, order, `Squash ${hashes.length + 1} commits`);
};

/** Stops at `hash` so that the user can change it. */
export const editPlan = (history: EditableHistory, hash: string, subject: string) => {
  const indexes = indexesOf(history, [hash]);
  if (!indexes) return null;
  const { base, commits } = rangeTo(history, indexes[0]!);
  return plan(
    base,
    commits.map((h) => (h === hash ? { hash: h, action: "edit" } : pick(h))),
    `Edit “${subject}”`,
  );
};

/** The base of an interactive rebase of `hashes` and everything above them. */
export const rebaseBase = (history: EditableHistory, hashes: readonly string[]) => {
  const indexes = indexesOf(history, hashes);
  return indexes ? rangeTo(history, indexes.at(-1)!).base : undefined;
};

/** Messages of commits squashed together, in order, as git suggests them. */
export const combinedMessage = (messages: readonly string[]) =>
  messages
    .map((m) => m.trim())
    .filter(Boolean)
    .join("\n\n");

// ---------------------------------------------------------------------------
// Interactive rebase editor
// ---------------------------------------------------------------------------

/** What the editor offers per commit; `reword` and `squash` turn into steps with messages. */
export type EditorAction = "pick" | "reword" | "edit" | "squash" | "fixup" | "drop";

export interface EditorRow {
  readonly commit: RebaseCommit;
  readonly action: EditorAction;
  /** A message the user wrote for the commit (and what is squashed into it), if any. */
  readonly message: string | null;
}

export const folds = (action: EditorAction) => action === "squash" || action === "fixup";

/**
 * For each row (oldest first), the row it is folded into: the closest older row that is not
 * dropped and not folded itself. Null for rows that are not folded, or have nothing to fold into.
 */
export const foldTargets = (rows: readonly EditorRow[]): (number | null)[] => {
  let head: number | null = null;
  return rows.map((row, i) => {
    if (row.action === "drop") return null;
    if (folds(row.action)) return head;
    head = i;
    return null;
  });
};

/** The message the commit at `index` (not folded) ends up with: its own, or with squashes. */
export const resultMessage = (rows: readonly EditorRow[], index: number): string => {
  const row = rows[index]!;
  if (row.message !== null) return row.message;
  const targets = foldTargets(rows);
  const squashed = rows.filter((r, i) => targets[i] === index && r.action === "squash");
  return squashed.length === 0
    ? row.commit.message
    : combinedMessage([row.commit.message, ...squashed.map((r) => r.commit.message)]);
};

/** The message the commit at `index` gets without a message of its own. */
export const defaultMessage = (rows: readonly EditorRow[], index: number): string =>
  resultMessage(
    rows.map((r, i) => (i === index ? { ...r, message: null } : r)),
    index,
  );

/** Problems that keep the rebase from starting, by row index. */
export const rowProblems = (rows: readonly EditorRow[]): Map<number, string> => {
  const problems = new Map<number, string>();
  const targets = foldTargets(rows);
  rows.forEach((row, i) => {
    if (folds(row.action) && targets[i] === null)
      problems.set(i, "There is no older commit to fold this one into");
    else if (!folds(row.action) && row.action !== "drop" && !resultMessage(rows, i).trim())
      problems.set(i, "The message is empty");
  });
  return problems;
};

/** The steps the rows stand for, see `RebaseStep`. */
export const editorSteps = (rows: readonly EditorRow[]): RebaseStep[] => {
  const targets = foldTargets(rows);
  return rows.map((row, i): RebaseStep => {
    const hash = row.commit.hash;
    if (row.action === "drop") return { hash, action: "drop" };
    if (folds(row.action)) return { hash, action: "fixup" };
    const squashes = rows.some((r, j) => targets[j] === i && r.action === "squash");
    const message = resultMessage(rows, i);
    const changed = squashes || (row.message !== null && row.message !== row.commit.message);
    return {
      hash,
      action: row.action === "edit" ? "edit" : "pick",
      ...(changed ? { message } : {}),
    };
  });
};

/** What the rows change, for the editor's summary. */
export const editorSummary = (original: readonly RebaseCommit[], rows: readonly EditorRow[]) => {
  const moved = rows.filter((r, i) => original[i]?.hash !== r.commit.hash).length;
  const count = (a: EditorAction) => rows.filter((r) => r.action === a).length;
  const reworded = rows.filter(
    (r) =>
      !folds(r.action) &&
      r.action !== "drop" &&
      r.message !== null &&
      r.message !== r.commit.message,
  ).length;
  return {
    moved,
    squashed: count("squash") + count("fixup"),
    dropped: count("drop"),
    edited: count("edit"),
    reworded,
    changed:
      moved > 0 || rows.some((r) => r.action !== "pick" && r.action !== "reword") || reworded > 0,
  };
};
