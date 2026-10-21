/**
 * Undo and redo of repository operations. Before and after an operation the journal takes a
 * snapshot of HEAD, the branches and the tags; undoing restores the refs the operation changed,
 * and redoing restores them again. Commits are never lost on the way: they stay reachable from
 * the reflogs.
 */
import type { UndoState } from "@shared/domain";

/** HEAD, the local branches and the tags at one point in time. */
export interface Snapshot {
  /** The branch HEAD points at (full ref name), or "" when it is detached. */
  readonly head: string;
  /** The commit HEAD resolves to, or "" on an unborn branch. */
  readonly hash: string;
  readonly refs: ReadonlyMap<string, string>;
}

/** Prints a {@link Snapshot}, see {@link parseSnapshot}. */
export const SNAPSHOT_SCRIPT = String.raw`
printf '%s\n' "$(git symbolic-ref -q HEAD)" "$(git rev-parse -q --verify HEAD)"
git for-each-ref --format='%(refname) %(objectname)' refs/heads refs/tags
`;

export const parseSnapshot = (text: string): Snapshot => {
  const [head = "", hash = "", ...lines] = text.split("\n");
  const refs = new Map<string, string>();
  for (const line of lines) {
    const space = line.lastIndexOf(" ");
    if (space > 0) refs.set(line.slice(0, space), line.slice(space + 1));
  }
  return { head, hash, refs };
};

/** One side of an operation: where HEAD was, and the refs it changed (null: absent). */
export interface Side {
  readonly head: string;
  readonly hash: string;
  readonly refs: Readonly<Record<string, string | null>>;
}

/**
 * How HEAD's branch goes back when only its commit changes: `soft` keeps the changes of the
 * commits undone staged (for commits and amends), `keep` updates the working tree and the index
 * like switching branches does, keeping uncommitted changes.
 */
export type UndoMode = "soft" | "keep";

export interface Entry {
  readonly label: string;
  readonly mode: UndoMode;
  readonly before: Side;
  readonly after: Side;
}

/** The entry for an operation that went from `before` to `after`; null if it changed nothing. */
export const entryOf = (
  label: string,
  mode: UndoMode,
  before: Snapshot,
  after: Snapshot,
): Entry | null => {
  const b: Record<string, string | null> = {};
  const a: Record<string, string | null> = {};
  for (const name of new Set([...before.refs.keys(), ...after.refs.keys()])) {
    const was = before.refs.get(name) ?? null;
    const is = after.refs.get(name) ?? null;
    if (was === is) continue;
    b[name] = was;
    a[name] = is;
  }
  if (Object.keys(b).length === 0 && before.head === after.head && before.hash === after.hash)
    return null;
  return {
    label,
    mode,
    before: { head: before.head, hash: before.hash, refs: b },
    after: { head: after.head, hash: after.hash, refs: a },
  };
};

const short = (ref: string) => ref.replace(/^refs\/(heads|tags)\//, "");

/**
 * Why the repository is not as `expected` says, which means an entry cannot be applied: someone
 * changed it meanwhile. Null when it is.
 */
export const mismatch = (current: Snapshot, expected: Side): string | null => {
  if (current.head !== expected.head)
    return current.head ? `${short(current.head)} is checked out now` : "HEAD is detached now";
  if (current.hash !== expected.hash) return "HEAD has moved since";
  for (const [ref, hash] of Object.entries(expected.refs)) {
    if ((current.refs.get(ref) ?? null) !== hash) return `${short(ref)} has changed since`;
  }
  return null;
};

/**
 * The git commands (argument lists) that take the repository from `from` (as it is now) to
 * `to`. The branch to check out is set first, then HEAD moves, then the other refs: if moving
 * HEAD fails (say, uncommitted changes are in the way), little else has changed. Ref updates
 * check the old value, so they fail rather than overwrite a ref that moved meanwhile.
 */
export const restoreCommands = (
  from: Side,
  to: Side,
  mode: UndoMode,
  reflog: string,
): string[][] => {
  const zero = "0".repeat(Math.max(40, from.hash.length, to.hash.length));
  const update = (ref: string): string[] | null => {
    const was = from.refs[ref] ?? null;
    const want = to.refs[ref] ?? null;
    if (was === want) return null;
    return want === null
      ? ["update-ref", "-m", reflog, "-d", ref, was!]
      : ["update-ref", "-m", reflog, ref, want, was ?? zero];
  };
  const commands: string[][] = [];
  const refs = Object.keys(to.refs);
  if (from.head === to.head) {
    if (from.hash !== to.hash) {
      if (to.hash === "") {
        commands.push(["update-ref", "-m", reflog, "-d", from.head || "HEAD"]);
      } else {
        // Like switching branches: the working tree and the index follow, keeping what was
        // changed in them (staged or not), unless that is in the way.
        if (mode === "keep") commands.push(["read-tree", "-m", "-u", "HEAD", to.hash]);
        commands.push(["reset", "--soft", "-q", to.hash]);
      }
    }
    for (const ref of refs) {
      if (ref === from.head) continue;
      const c = update(ref);
      if (c) commands.push(c);
    }
    return commands;
  }
  // Switching branches: give the branch to check out its commit first.
  const target = to.head && update(to.head);
  if (target) commands.push(target);
  commands.push(
    to.head
      ? ["switch", "-q", "--no-guess", to.head.replace(/^refs\/heads\//, "")]
      : ["switch", "-q", "--detach", to.hash],
  );
  for (const ref of refs) {
    if (ref === to.head) continue;
    const c = update(ref);
    if (c) commands.push(c);
  }
  return commands;
};

/** How many operations can be undone. */
const MAX_ENTRIES = 100;

/** The undo and redo stacks of a repository, and an operation that has not finished yet. */
export class Journal {
  private undos: Entry[] = [];
  private redos: Entry[] = [];
  /** An operation that stopped part way (e.g. a rebase at conflicts): recorded once it is done. */
  pending: { readonly label: string; readonly mode: UndoMode; readonly before: Snapshot } | null =
    null;

  state(): UndoState {
    return { undo: this.undos.at(-1)?.label ?? null, redo: this.redos.at(-1)?.label ?? null };
  }

  record(entry: Entry | null): void {
    if (!entry) return;
    this.undos.push(entry);
    if (this.undos.length > MAX_ENTRIES) this.undos.shift();
    this.redos = [];
  }

  peekUndo(): Entry | undefined {
    return this.undos.at(-1);
  }

  peekRedo(): Entry | undefined {
    return this.redos.at(-1);
  }

  undone(): void {
    const e = this.undos.pop();
    if (e) this.redos.push(e);
  }

  redone(): void {
    const e = this.redos.pop();
    if (e) this.undos.push(e);
  }

  /** Forgets everything: the repository changed in a way the entries cannot follow. */
  clear(): void {
    this.undos = [];
    this.redos = [];
    this.pending = null;
  }
}
