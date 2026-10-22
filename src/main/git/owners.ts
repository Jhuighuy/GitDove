/**
 * Branch owners for the contributor filter (see `BranchOwners`). Pure functions
 * over `for-each-ref` (`REFS_FORMAT`), `git log` (`OWNERS_LOG_ARGS`, `TIPS_LOG_ARGS`)
 * and `git config` (`USER_CONFIG_ARGS`) output.
 */
import type { BranchOwners } from "@shared/domain";

/** Branch names that are shared by everyone, besides each remote's `HEAD`. */
const SHARED = ["main", "master", "trunk"];

/** Commits per branch considered when looking for its owner (newest first). */
const COMMITS_PER_BRANCH = 100;

const AUTHOR_FORMAT = "%aN%x00%aE%x00%at";

/**
 * `git log` arguments listing commits that are on some branch but not on a default
 * one, newest first and never before their children. Capped so that a repository
 * without a default branch does not stream its whole history.
 */
export const OWNERS_LOG_ARGS = [
  "log",
  "--date-order",
  `--format=%H%x00%P%x00${AUTHOR_FORMAT}`,
  "--max-count=5000",
  "--branches",
  "--remotes",
  "--not",
  "--remotes=*/HEAD",
  // A glob without a wildcard matches `<pattern>/*`: `[m]ain` matches `main` exactly.
  ...SHARED.flatMap((n) => [
    `--glob=refs/heads/[${n[0]}]${n.slice(1)}`,
    `--glob=refs/remotes/*/${n}`,
  ]),
];

/** `git log` arguments listing the tip commit of every branch, with `.mailmap` applied. */
export const TIPS_LOG_ARGS = [
  "log",
  "--no-walk=unsorted",
  `--format=%H%x00%x00${AUTHOR_FORMAT}`,
  "--branches",
  "--remotes",
];

/** `git config` arguments printing `user.name` and `user.email` (exit code 1 when unset). */
export const USER_CONFIG_ARGS = ["config", "--get-regexp", "^user\\.(name|email)$"];

export interface OwnerLogs {
  /** `OWNERS_LOG_ARGS` output. */
  readonly commits: string;
  /** `TIPS_LOG_ARGS` output. */
  readonly tips: string;
}

interface Commit {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly email: string;
}

/** Commits visited by all `ownCommits` walks of one `branchOwners` call. */
const WALK_BUDGET = 2_000_000;

/** A binary min-heap of log positions. */
const heapPush = (heap: number[], value: number): void => {
  heap.push(value);
  for (let i = heap.length - 1; i > 0;) {
    const up = (i - 1) >> 1;
    if (heap[up]! <= heap[i]!) break;
    [heap[i], heap[up]] = [heap[up]!, heap[i]!];
    i = up;
  }
};

const heapPop = (heap: number[]): number => {
  const top = heap[0]!;
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    for (let i = 0; ;) {
      const l = 2 * i + 1;
      const m = l + 1 < heap.length && heap[l + 1]! < heap[l]! ? l + 1 : l;
      if (m >= heap.length || heap[i]! <= heap[m]!) break;
      [heap[i], heap[m]] = [heap[m]!, heap[i]!];
      i = m;
    }
  }
  return top;
};

/**
 * The first `limit` commits of `log` that are reachable from `start` but not from a base,
 * by position in the log. Bases are the tips of other branches that `start` was built on
 * (see `isBase`), so that a branch made on top of another one gets its own commits only.
 * As parents come after their children, visiting reachable positions in increasing order
 * sees all children of a commit before it. `null` when `budget` runs out.
 */
const ownCommits = (
  start: number,
  log: readonly { readonly parents: readonly number[] }[],
  isBase: (position: number) => boolean,
  limit: number,
  budget: { left: number },
): number[] | null => {
  /** 1: reachable from `start`, 2: reachable from a base. */
  const mark = new Map<number, number>([[start, 1]]);
  const heap = [start];
  /** Positions marked reachable from `start` and not visited yet. */
  let pending = 1;
  const out: number[] = [];
  while (heap.length > 0 && pending > 0 && out.length < limit) {
    if (--budget.left < 0) return null;
    const i = heapPop(heap);
    const m = mark.get(i)!;
    if (m === 1) pending--;
    const excluded = m === 2 || (i !== start && isBase(i));
    if (!excluded) out.push(i);
    for (const p of log[i]!.parents) {
      const pm = mark.get(p);
      if (pm === undefined) heapPush(heap, p);
      if (excluded) {
        if (pm === 1) pending--;
        if (pm !== 2) mark.set(p, 2);
      } else if (pm === undefined) {
        mark.set(p, 1);
        pending++;
      }
    }
  }
  return out;
};

const branchName = (ref: string): string | null => {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  const m = /^refs\/remotes\/[^/]+\/(.+)$/.exec(ref);
  return m ? m[1]! : null;
};

/** Parses `USER_CONFIG_ARGS` output. */
const parseUser = (out: string): BranchOwners["me"] => {
  let email: string | null = null;
  let name: string | null = null;
  for (const line of out.split("\n")) {
    const m = /^user\.(name|email) (.*)$/i.exec(line);
    const value = m?.[2]?.trim();
    if (!value) continue;
    if (m![1]!.toLowerCase() === "email") email = value.toLowerCase();
    else name = value;
  }
  return { email, name };
};

/** Computes branch owners from `for-each-ref --format=REFS_FORMAT` and the logs above. */
export const branchOwners = (refsOut: string, logs: OwnerLogs, userOut: string): BranchOwners => {
  const tips: { name: string; hash: string; upstream: string }[] = [];
  /** Targets of the remotes' `HEAD`s, as full ref names. */
  const heads = new Set<string>();
  for (const line of refsOut.split("\n")) {
    const [name, oid, , upstream, , , symref] = line.split("\0");
    if (!name || !oid || !(name.startsWith("refs/heads/") || name.startsWith("refs/remotes/")))
      continue;
    if (symref) {
      if (name.endsWith("/HEAD")) heads.add(symref);
      continue;
    }
    tips.push({ name, hash: oid, upstream: upstream ?? "" });
  }
  /** `main`, `master` or `trunk` anywhere, and each remote's `HEAD`. */
  const isDefault = (ref: string) => heads.has(ref) || SHARED.includes(branchName(ref) ?? "");
  /** Remote default branch names, which a local copy of them is usually named after. */
  const headNames = new Set([...heads].map((h) => branchName(h)));

  const people: Record<string, { name: string; time: number }> = {};
  /** Reads commits; both logs list the newest commits first. */
  const read = (out: string): Commit[] => {
    const commits: Commit[] = [];
    for (const line of out.split("\n")) {
      const [hash, parents, name, email, time] = line.split("\0");
      if (!hash || time === undefined) continue;
      const e = email!.toLowerCase();
      commits.push({ hash, parents: parents ? parents.split(" ") : [], email: e });
      if (!e) continue;
      const p = people[e];
      const t = Number(time);
      if (!p) people[e] = { name: name || e, time: t };
      else if (t > p.time) people[e] = { name: name || p.name, time: t };
    }
    return commits;
  };
  const commits = read(logs.commits);
  const position = new Map(commits.map((c, i) => [c.hash, i]));
  const log = commits.map((c) => ({
    parents: c.parents.flatMap((p) => position.get(p) ?? []),
  }));
  const tipEmails = new Map(read(logs.tips).map((c) => [c.hash, c.email]));

  /**
   * Branch tips by log position and branch name, to find the branches a branch was built on.
   * Many refs may share a commit, so lookups must not scan them all.
   */
  const tipsAt = new Map<number, Map<string | null, string[]>>();
  /** The position of each branch name's tips, or -1 when they are at several. */
  const namesAt = new Map<string | null, number>();
  const refAt = new Map<string, number>();
  for (const tip of tips) {
    const at = position.get(tip.hash);
    if (at === undefined) continue;
    let names = tipsAt.get(at);
    if (!names) {
      names = new Map();
      tipsAt.set(at, names);
    }
    const n = branchName(tip.name);
    const refs = names.get(n);
    if (refs) refs.push(tip.name);
    else names.set(n, [tip.name]);
    namesAt.set(n, namesAt.has(n) && namesAt.get(n) !== at ? -1 : at);
    refAt.set(tip.name, at);
  }

  /**
   * Weighs the authors of a branch's own commits by closeness to its tip: the k-th newest
   * commit that is not a merge counts 1/k, so whoever works on it now owns it.
   */
  const ownerOf = (own: readonly number[] | null): string | undefined | null => {
    if (own === null) return null;
    const weights = new Map<string, number>();
    let k = 0;
    for (const i of own) {
      const { email, parents } = commits[i]!;
      if (!email || parents.length > 1) continue;
      weights.set(email, (weights.get(email) ?? 0) + 1 / ++k);
    }
    return [...weights].toSorted((a, b) => b[1] - a[1])[0]?.[0];
  };

  /** Owners from the walks so far, by `walkKey`; `null` when the budget ran out. */
  const walks = new Map<string, string | undefined | null>();
  const budget = { left: WALK_BUDGET };
  const byRef: Record<string, string> = {};
  const used = new Set<string>();
  for (const tip of tips) {
    if (isDefault(tip.name)) continue;
    // Its copies elsewhere (its upstream, the same name on a remote) are not its bases. Only
    // one name is its own and only one ref its upstream, so this looks at three names at most.
    const name = branchName(tip.name);
    const isBase = (at: number) => {
      for (const [n, refs] of tipsAt.get(at) ?? []) {
        if (n !== name && (refs.length > 1 || refs[0] !== tip.upstream)) return true;
      }
      return false;
    };
    const start = position.get(tip.hash);
    let owner: string | undefined | null;
    if (start !== undefined) {
      // Refs on one commit walk alike unless their name or upstream is the tip of a commit
      // they may reach, so that many refs on one commit cost one walk.
      const at = namesAt.get(name);
      const up = refAt.get(tip.upstream);
      const walkKey = [
        start,
        at !== undefined && at !== start ? `n${name}` : "",
        up !== undefined && up !== start ? `u${tip.upstream}` : "",
      ].join("\0");
      if (walks.has(walkKey)) owner = walks.get(walkKey);
      else {
        owner = ownerOf(ownCommits(start, log, isBase, COMMITS_PER_BRANCH, budget));
        walks.set(walkKey, owner);
      }
    }
    // Out of budget, the tip is still one of its own commits.
    if (owner === null) owner = tipEmails.get(tip.hash);
    if (owner === undefined) {
      // Without commits of its own (its tip is one when it is in the log), a branch is merged,
      // or a local copy of a default branch. With merges only, its tip author owns it.
      const copy =
        start === undefined &&
        ((tip.upstream && isDefault(tip.upstream)) ||
          (tip.name.startsWith("refs/heads/") && headNames.has(name)));
      owner = tipEmails.get(tip.hash);
      if (copy || !owner) continue;
    }
    byRef[tip.name] = owner;
    used.add(owner);
  }
  return {
    byRef,
    people: Object.fromEntries(Object.entries(people).filter(([e]) => used.has(e))),
    me: parseUser(userOut),
  };
};
