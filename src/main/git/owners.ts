/**
 * Branch owners for the contributor filter (see `BranchOwners`). Pure functions
 * over `for-each-ref` (`REFS_FORMAT`) and `git log` (`OWNERS_LOG_ARGS`) output.
 */
import type { BranchOwners } from "@shared/domain";

/** Branch names that are shared by everyone, besides each remote's `HEAD`. */
const SHARED = ["main", "master", "trunk"];

/** Commits per branch considered when looking for its owners (newest first). */
const COMMITS_PER_BRANCH = 100;

/**
 * `git log` arguments listing commits that are on some branch but not on a default
 * one, newest first. Capped so that a repository without a default branch does not
 * stream its whole history.
 */
export const OWNERS_LOG_ARGS = [
  "log",
  "--format=%H%x00%P%x00%aN%x00%aE",
  "--max-count=5000",
  "--branches",
  "--remotes",
  "--not",
  "--remotes=*/HEAD",
  ...SHARED.flatMap((n) => [`--glob=refs/heads/${n}`, `--glob=refs/remotes/*/${n}`]),
];

interface Tip {
  readonly name: string;
  readonly hash: string;
  readonly upstream: string;
  readonly authorName: string;
  readonly authorEmail: string;
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

/**
 * Computes branch owners from `for-each-ref --format=REFS_FORMAT` output (which
 * ends with the tip's author name and email) and `OWNERS_LOG_ARGS` output.
 */
export const branchOwners = (refsOut: string, logOut: string, me: string | null): BranchOwners => {
  const tips: Tip[] = [];
  const shared = new Set(SHARED);
  for (const line of refsOut.split("\n")) {
    const f = line.split("\0");
    const [name, oid, , upstream, , , symref, authorName, authorEmail] = f;
    if (!name || !oid || !(name.startsWith("refs/heads/") || name.startsWith("refs/remotes/")))
      continue;
    if (symref) {
      // A remote's HEAD names its default branch.
      const target = name.endsWith("/HEAD") ? branchName(symref) : null;
      if (target) shared.add(target);
      continue;
    }
    tips.push({
      name,
      hash: oid,
      upstream: upstream ?? "",
      authorName: authorName ?? "",
      authorEmail: (authorEmail ?? "").replace(/^<|>$/g, "").toLowerCase(),
    });
  }
  const isShared = (ref: string) => {
    const b = branchName(ref);
    return b !== null && shared.has(b);
  };

  const names: Record<string, string> = {};
  const commits = new Map<string, Commit>();
  for (const line of logOut.split("\n")) {
    const [hash, parents, name, email] = line.split("\0");
    if (!hash || email === undefined) continue;
    const e = email.toLowerCase();
    if (e && name) names[e] ??= name;
    commits.set(hash, { parents: parents ? parents.split(" ") : [], email: e });
  }

  const byRef: Record<string, string[]> = {};
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
    if (counts.size === 0 && tip.authorEmail) {
      counts.set(tip.authorEmail, 1);
      if (tip.authorName) names[tip.authorEmail] ??= tip.authorName;
    }
    if (counts.size > 0)
      byRef[tip.name] = [...counts].toSorted((a, b) => b[1] - a[1]).map(([e]) => e);
  }
  return { byRef, names, me: me?.trim().toLowerCase() || null };
};
