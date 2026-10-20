/**
 * Graph visibility ("eye" toggles in the sidebar).
 *
 * A hidden entry is either a full ref name (`refs/heads/topic`), a prefix ending
 * in `/` that hides a whole group (`refs/remotes/origin/`, `refs/tags/`), or a
 * stash written as `stash:<hash>`.
 */
export const stashKey = (hash: string): string => `stash:${hash}`;

export const isHidden = (
  hidden: ReadonlySet<string> | readonly string[],
  name: string,
): boolean => {
  const list = hidden instanceof Set ? hidden : new Set(hidden as readonly string[]);
  if (list.has(name)) return true;
  for (const entry of list) if (entry.endsWith("/") && name.startsWith(entry)) return true;
  return false;
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
