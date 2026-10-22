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

/** `personOf` results: it runs per owner email on every contributor-filter lookup. */
const persons = new Map<string, string>();

/** Contributors are grouped by name, ignoring case, accents and extra spaces. */
export const personOf = (name: string): string => {
  let person = persons.get(name);
  if (person === undefined) {
    person = name
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ");
    // Names are few, but bound the cache anyway.
    if (persons.size >= 10_000) persons.clear();
    persons.set(name, person);
  }
  return person;
};

export const personKey = (person: string): string => `person:${person}`;

export const isContributorKey = (entry: string): boolean =>
  entry.startsWith("author:") || entry.startsWith("person:");

type People = BranchOwners["people"];

/** The person (see `personOf`) an email belongs to. */
export const personOfEmail = (email: string, people: People): string =>
  personOf(people[email]?.name ?? email);

/** A hidden list: treated as immutable, it is compiled once (see `compile`). */
type HiddenList = ReadonlySet<string> | readonly string[];

/** A hidden list compiled for lookups that do not scan it. */
interface Compiled {
  /** The size of the list when compiled, to notice a list changed in place. */
  readonly size: number;
  readonly exact: ReadonlySet<string>;
  /** Group prefixes (entries ending in `/`). */
  readonly prefixes: readonly string[];
  /** Whether the contributor filter is on (there are `author:` or `person:` entries). */
  readonly contributors: boolean;
}

const compiled = new WeakMap<HiddenList, Compiled>();

const compile = (hidden: HiddenList): Compiled => {
  const size = hidden instanceof Set ? hidden.size : (hidden as readonly string[]).length;
  const cached = compiled.get(hidden);
  if (cached?.size === size) return cached;
  const exact: ReadonlySet<string> =
    hidden instanceof Set ? hidden : new Set(hidden as readonly string[]);
  const prefixes: string[] = [];
  let contributors = false;
  for (const entry of exact) {
    if (entry.endsWith("/")) prefixes.push(entry);
    else if (!contributors && isContributorKey(entry)) contributors = true;
  }
  const c: Compiled = { size, exact, prefixes, contributors };
  compiled.set(hidden, c);
  return c;
};

const emailHidden = (c: Compiled, email: string, people: People): boolean =>
  c.contributors &&
  (c.exact.has(authorKey(email)) || c.exact.has(personKey(personOfEmail(email, people))));

/** Whether the contributor filter hides an email, by itself or by its person. */
export const isEmailHidden = (hidden: HiddenList, email: string, people: People): boolean =>
  emailHidden(compile(hidden), email, people);

/** Whether a name is hidden by its own entry or a group prefix (not the contributor filter). */
export const isHidden = (hidden: HiddenList, name: string): boolean => {
  const c = compile(hidden);
  if (c.exact.has(name)) return true;
  for (const prefix of c.prefixes) if (name.startsWith(prefix)) return true;
  return false;
};

/** Whether the contributor filter hides a branch, by its owner. */
export const isFilteredOut = (
  hidden: HiddenList,
  name: string,
  owners: Pick<BranchOwners, "byRef" | "people">,
): boolean => {
  const c = compile(hidden);
  if (!c.contributors) return false;
  const email = owners.byRef[name];
  return email !== undefined && emailHidden(c, email, owners.people);
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
