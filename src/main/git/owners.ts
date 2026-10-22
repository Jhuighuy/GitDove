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

/**
 * The first `limit` commits of `log` that are reachable from `start` but not from a base,
 * by position in the log. Bases are the tips of other branches that `start` was built on
 * (see `isBase`), so that a branch made on top of another one gets its own commits only.
 * As parents come after their children, one pass from `start` finds them.
 */
const ownCommits = (
  start: number,
  log: readonly { readonly parents: readonly number[] }[],
  isBase: (position: number) => boolean,
  limit: number,
): number[] => {
  /** 1: reachable from `start`, 2: reachable from a base. */
  const mark = new Map<number, number>([[start, 1]]);
  /** Positions marked reachable from `start` and not processed yet. */
  let pending = 1;
  const out: number[] = [];
  for (let i = start; i < log.length && pending > 0 && out.length < limit; i++) {
    const m = mark.get(i);
    if (m === undefined) continue;
    if (m === 1) pending--;
    const excluded = m === 2 || (i !== start && isBase(i));
    if (!excluded) out.push(i);
    for (const p of log[i]!.parents) {
      const pm = mark.get(p);
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

  /** Branch tips by log position, to find the branches a branch was built on. */
  const tipsAt = new Map<number, typeof tips>();
  for (const tip of tips) {
    const at = position.get(tip.hash);
    if (at !== undefined) tipsAt.set(at, [...(tipsAt.get(at) ?? []), tip]);
  }

  const byRef: Record<string, string> = {};
  const used = new Set<string>();
  for (const tip of tips) {
    if (isDefault(tip.name)) continue;
    // Its copies elsewhere (its upstream, the same name on a remote) are not its bases.
    const name = branchName(tip.name);
    const isBase = (at: number) =>
      (tipsAt.get(at) ?? []).some((t) => t.name !== tip.upstream && branchName(t.name) !== name);
    // Weigh the authors of its own commits by closeness to the tip: the k-th newest commit
    // that is not a merge counts 1/k, so whoever works on it now owns it.
    const weights = new Map<string, number>();
    const start = position.get(tip.hash);
    let k = 0;
    for (const i of start === undefined ? [] : ownCommits(start, log, isBase, COMMITS_PER_BRANCH)) {
      const { email, parents } = commits[i]!;
      if (!email || parents.length > 1) continue;
      weights.set(email, (weights.get(email) ?? 0) + 1 / ++k);
    }
    let owner = [...weights].toSorted((a, b) => b[1] - a[1])[0]?.[0];
    if (owner === undefined) {
      // Without commits of its own, a branch is merged, or a local copy of a default branch.
      const copy =
        (tip.upstream && isDefault(tip.upstream)) ||
        (tip.name.startsWith("refs/heads/") && headNames.has(name));
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
