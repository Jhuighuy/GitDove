import type { BranchOwners } from "./domain";

/**
 * Graph visibility ("eye" toggles in the sidebar).
 *
 * A hidden entry is either a full ref name (`refs/heads/topic`), a prefix ending
 * in `/` that hides a whole group (`refs/remotes/origin/`, `refs/tags/`), or a
 * stash written as `stash:<hash>`.
 *
 * The contributor filter lives in the same list: `author:<email>` hides one email
 * and `person:<name>` every email with that name (see `personOf`), like a group
 * prefix. A branch is hidden when its owner (see `BranchOwners`) is, whatever its
 * own entry says; that entry is kept for when the owner is shown again.
 */
export const stashKey = (hash: string): string => `stash:${hash}`;

export const authorKey = (email: string): string => `author:${email.toLowerCase()}`;

/** Contributors are grouped by name, ignoring case, accents and extra spaces. */
export const personOf = (name: string): string =>
  name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim().replace(/\s+/g, " ");

export const personKey = (person: string): string => `person:${person}`;

export const isContributorKey = (entry: string): boolean =>
  entry.startsWith("author:") || entry.startsWith("person:");

type People = BranchOwners["people"];

/** The person (see `personOf`) an email belongs to. */
export const personOfEmail = (email: string, people: People): string =>
  personOf(people[email]?.name ?? email);

const asSet = (hidden: ReadonlySet<string> | readonly string[]): ReadonlySet<string> =>
  hidden instanceof Set ? hidden : new Set(hidden as readonly string[]);

/** Whether the contributor filter hides an email, by itself or by its person. */
export const isEmailHidden = (
  hidden: ReadonlySet<string> | readonly string[],
  email: string,
  people: People,
): boolean => {
  const list = asSet(hidden);
  return list.has(authorKey(email)) || list.has(personKey(personOfEmail(email, people)));
};

export const isHidden = (
  hidden: ReadonlySet<string> | readonly string[],
  name: string,
): boolean => {
  const list = asSet(hidden);
  if (list.has(name)) return true;
  for (const entry of list) if (entry.endsWith("/") && name.startsWith(entry)) return true;
  return false;
};

/** Whether the contributor filter hides a branch, by its owner. */
export const isFilteredOut = (
  hidden: ReadonlySet<string> | readonly string[],
  name: string,
  owners: Pick<BranchOwners, "byRef" | "people">,
): boolean => {
  const email = owners.byRef[name];
  return email !== undefined && isEmailHidden(hidden, email, owners.people);
};

/**
 * Shows `names`. A hidden group prefix that covers any of them is expanded into
 * its other members (taken from `all`) so that the rest of the group stays hidden.
 */
export const showNames = (
  hidden: readonly string[],
  names: readonly string[],
  /** Every toggleable name, used to expand group prefixes. */
  all: readonly string[] = [],
): string[] => {
  const show = new Set(names);
  const out = new Set<string>();
  for (const entry of hidden) {
    if (show.has(entry)) continue;
    if (entry.endsWith("/") && names.some((n) => n.startsWith(entry))) {
      for (const n of all) if (n.startsWith(entry) && !show.has(n)) out.add(n);
      continue;
    }
    out.add(entry);
  }
  return [...out];
};

/** Toggles one entry, expanding hidden groups into their remaining members when needed. */
export const toggleHidden = (
  hidden: readonly string[],
  name: string,
  /** Every toggleable name, used to expand group prefixes. */
  all: readonly string[] = [],
): string[] =>
  isHidden(hidden, name) ? showNames(hidden, [name], all) : [...new Set([...hidden, name])];

/** Replaces the contributor filter with `entries` (`author:` and `person:` keys). */
export const setContributorFilter = (
  hidden: readonly string[],
  entries: readonly string[],
): string[] => [...new Set([...hidden.filter((h) => !isContributorKey(h)), ...entries])];
