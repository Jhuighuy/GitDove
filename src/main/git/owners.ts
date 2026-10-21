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
 * The first `limit` commits of `log` reachable from `start`, by position in the log. As
 * parents come after their children, a best-first walk finds them without visiting more.
 */
const newest = (
  start: number,
  log: readonly { readonly parents: readonly number[] }[],
  limit: number,
): number[] => {
  const heap = [start];
  const seen = new Set(heap);
  const out: number[] = [];
  while (heap.length > 0 && out.length < limit) {
    out.push(heap[0]!);
    // Pop the smallest position.
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
    for (const p of log[out.at(-1)!]!.parents) {
      if (seen.has(p)) continue;
      seen.add(p);
      heap.push(p);
      for (let i = heap.length - 1; i > 0;) {
        const up = (i - 1) >> 1;
        if (heap[up]! <= heap[i]!) break;
        [heap[i], heap[up]] = [heap[up]!, heap[i]!];
        i = up;
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

  const byRef: Record<string, string[]> = {};
  const used = new Set<string>();
  for (const tip of tips) {
    if (isDefault(tip.name)) continue;
    // Count the authors of the branch's newest own commits.
    const counts = new Map<string, number>();
    const start = position.get(tip.hash);
    for (const i of start === undefined ? [] : newest(start, log, COMMITS_PER_BRANCH)) {
      const e = commits[i]!.email;
      if (e) counts.set(e, (counts.get(e) ?? 0) + 1);
    }
    if (counts.size === 0) {
      // Without commits of its own, a branch is merged, or a local copy of a default branch.
      const copy =
        (tip.upstream && isDefault(tip.upstream)) ||
        (tip.name.startsWith("refs/heads/") && headNames.has(branchName(tip.name)));
      const tipEmail = tipEmails.get(tip.hash);
      if (copy || !tipEmail) continue;
      counts.set(tipEmail, 1);
    }
    byRef[tip.name] = [...counts].toSorted((a, b) => b[1] - a[1]).map(([e]) => e);
    for (const e of counts.keys()) used.add(e);
  }
  return {
    byRef,
    people: Object.fromEntries(Object.entries(people).filter(([e]) => used.has(e))),
    me: parseUser(userOut),
  };
};
