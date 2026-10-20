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

/** Toggles one entry, expanding a hidden group into its remaining members when needed. */
export const toggleHidden = (
  hidden: readonly string[],
  name: string,
  /** All names currently covered by a group prefix that contains `name`. */
  siblings: readonly string[] = [],
): string[] => {
  const set = new Set(hidden);
  if (set.has(name)) {
    set.delete(name);
    return [...set];
  }
  const group = [...set].find((e) => e.endsWith("/") && name.startsWith(e));
  if (group) {
    // Showing one member of a hidden group: hide the other members individually.
    set.delete(group);
    for (const s of siblings) if (s !== name) set.add(s);
    return [...set];
  }
  set.add(name);
  return [...set];
};
