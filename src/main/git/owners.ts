/**
 * Branch owners for the contributor filter (see `BranchOwners`). Pure functions
 * over `for-each-ref` (`REFS_FORMAT`), `git log` (`OWNERS_LOG_ARGS`, `TIPS_LOG_ARGS`)
 * and `git config` (`USER_CONFIG_ARGS`) output.
 */
import type { BranchOwners } from "@shared/domain";

/** Branch names that are shared by everyone, besides each remote's `HEAD`. */
const SHARED = ["main", "master", "trunk"];

/** Commits per branch considered when looking for its owners (newest first). */
const COMMITS_PER_BRANCH = 100;

const AUTHOR_FORMAT = "%aN%x00%aE%x00%at";

/**
 * `git log` arguments listing commits that are on some branch but not on a default
 * one, newest first. Capped so that a repository without a default branch does not
 * stream its whole history.
 */
export const OWNERS_LOG_ARGS = [
  "log",
  `--format=%H%x00%P%x00${AUTHOR_FORMAT}`,
  "--max-count=5000",
  "--branches",
  "--remotes",
  "--not",
  "--remotes=*/HEAD",
  ...SHARED.flatMap((n) => [`--glob=refs/heads/${n}`, `--glob=refs/remotes/*/${n}`]),
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
  readonly parents: readonly string[];
  readonly email: string;
}

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
    if (!m || !m[2]!.trim()) continue;
    if (m[1]!.toLowerCase() === "email") email = m[2]!.trim().toLowerCase();
    else name = m[2]!.trim();
  }
  return { email, name };
};

/** Computes branch owners from `for-each-ref --format=REFS_FORMAT` and the logs above. */
export const branchOwners = (refsOut: string, logs: OwnerLogs, userOut: string): BranchOwners => {
  const tips: { name: string; hash: string; upstream: string }[] = [];
  const shared = new Set(SHARED);
  for (const line of refsOut.split("\n")) {
    const [name, oid, , upstream, , , symref] = line.split("\0");
    if (!name || !oid || !(name.startsWith("refs/heads/") || name.startsWith("refs/remotes/")))
      continue;
    if (symref) {
      // A remote's HEAD names its default branch.
      const target = name.endsWith("/HEAD") ? branchName(symref) : null;
      if (target) shared.add(target);
      continue;
    }
    tips.push({ name, hash: oid, upstream: upstream ?? "" });
  }
  const isShared = (ref: string) => {
    const b = branchName(ref);
    return b !== null && shared.has(b);
  };

  const people: Record<string, { name: string; time: number }> = {};
  /** Reads commits; both logs list the newest commits first. */
  const read = (out: string) => {
    const commits = new Map<string, Commit>();
    for (const line of out.split("\n")) {
      const [hash, parents, name, email, time] = line.split("\0");
      if (!hash || time === undefined) continue;
      const e = email!.toLowerCase();
      commits.set(hash, { parents: parents ? parents.split(" ") : [], email: e });
      if (!e) continue;
      const p = people[e];
      const t = Number(time);
      if (!p) people[e] = { name: name || e, time: t };
      else if (t > p.time) people[e] = { name: name || p.name, time: t };
    }
    return commits;
  };
  const commits = read(logs.commits);
  const tipCommits = read(logs.tips);

  const byRef: Record<string, string[]> = {};
  const used = new Set<string>();
  for (const tip of tips) {
    if (isShared(tip.name) || (tip.upstream && isShared(tip.upstream))) continue;
    // Count the authors of the branch's own commits, newest first.
    const counts = new Map<string, number>();
    const seen = new Set<string>();
    const queue = [tip.hash];
    for (let i = 0; i < queue.length && seen.size < COMMITS_PER_BRANCH; i++) {
      const hash = queue[i]!;
      const c = commits.get(hash);
      if (!c || seen.has(hash)) continue;
      seen.add(hash);
      if (c.email) counts.set(c.email, (counts.get(c.email) ?? 0) + 1);
      queue.push(...c.parents);
    }
    const tipEmail = tipCommits.get(tip.hash)?.email;
    if (counts.size === 0 && tipEmail) counts.set(tipEmail, 1);
    if (counts.size === 0) continue;
    byRef[tip.name] = [...counts].toSorted((a, b) => b[1] - a[1]).map(([e]) => e);
    for (const e of counts.keys()) used.add(e);
  }
  return {
    byRef,
    people: Object.fromEntries(Object.entries(people).filter(([e]) => used.has(e))),
    me: parseUser(userOut),
  };
};
