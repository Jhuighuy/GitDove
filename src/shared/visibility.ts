/**
 * Graph visibility ("eye" toggles in the sidebar).
 *
 * A hidden entry is either a full ref name (`refs/heads/topic`), a prefix ending
 * in `/` that hides a whole group (`refs/remotes/origin/`, `refs/tags/`), or a
 * stash written as `stash:<hash>`.
 *
 * The contributor filter lives in the same list: `author:<email>` hides every
 * branch whose owners (see `BranchOwners`) are all hidden, except branches
 * listed as `show:<ref name>`.
 */
export const stashKey = (hash: string): string => `stash:${hash}`;

export const authorKey = (email: string): string => `author:${email.toLowerCase()}`;

/** A branch shown although the contributor filter hides its owners. */
export const exceptionKey = (name: string): string => `show:${name}`;

export const isAuthorKey = (entry: string): boolean => entry.startsWith("author:");

const asSet = (hidden: ReadonlySet<string> | readonly string[]): ReadonlySet<string> =>
  hidden instanceof Set ? hidden : new Set(hidden as readonly string[]);

export const isHidden = (
  hidden: ReadonlySet<string> | readonly string[],
  name: string,
): boolean => {
  const list = asSet(hidden);
  if (list.has(name)) return true;
  for (const entry of list) if (entry.endsWith("/") && name.startsWith(entry)) return true;
  return false;
};

/** Whether the contributor filter hides a branch with these owners. */
export const isFilteredOut = (
  hidden: ReadonlySet<string> | readonly string[],
  name: string,
  owners: readonly string[] | undefined,
): boolean => {
  if (!owners || owners.length === 0) return false;
  const list = asSet(hidden);
  return !list.has(exceptionKey(name)) && owners.every((e) => list.has(authorKey(e)));
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

/**
 * Sets which contributors are hidden. Exceptions for branches the filter no
 * longer hides are dropped, so they do not linger.
 */
export const setHiddenAuthors = (
  hidden: readonly string[],
  emails: readonly string[],
  /** Owners of each branch, by full ref name. */
  owners: Readonly<Record<string, readonly string[]>>,
): string[] => {
  const base = hidden.filter((h) => !isAuthorKey(h));
  const next = [...base, ...new Set(emails.map(authorKey))];
  return next.filter(
    (h) =>
      !h.startsWith("show:") ||
      isFilteredOut(
        next.filter((e) => e !== h),
        h.slice("show:".length),
        owners[h.slice("show:".length)],
      ),
  );
};

/** Emails of hidden contributors (lowercase). */
export const hiddenAuthors = (hidden: readonly string[]): string[] =>
  hidden.filter(isAuthorKey).map((h) => h.slice("author:".length));
