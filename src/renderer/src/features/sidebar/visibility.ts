import type { RefsSnapshot, RepoId } from "@shared/domain";
import {
  authorKey,
  exceptionKey,
  hiddenAuthors,
  isFilteredOut,
  isHidden,
  setHiddenAuthors,
  showNames,
  stashKey,
} from "@shared/visibility";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { keys, useRefs } from "@/lib/queries";

const hiddenKey = (repo: RepoId) => [...keys.repo(repo), "hidden"] as const;

export const useHiddenRefs = (repo: RepoId) =>
  useQuery({ queryKey: hiddenKey(repo), queryFn: () => api("repo.hiddenRefs", repo) });

/** All visibility-toggleable names in a repository (refs and stashes). */
export const allVisibilityNames = (refs: RefsSnapshot | undefined): string[] => [
  ...(refs?.refs ?? []).filter((r) => !r.short.endsWith("/HEAD")).map((r) => r.name),
  ...(refs?.stashes ?? []).map((s) => stashKey(s.hash)),
];

/** Someone who owns at least one branch (see `BranchOwners`). */
export interface Contributor {
  readonly email: string;
  readonly name: string;
  /** Local and remote branches they own. */
  readonly branches: number;
  readonly isMe: boolean;
}

/** Branch owners as a list: the current user first, then by number of branches. */
export const contributorsOf = (refs: RefsSnapshot | undefined): Contributor[] => {
  if (!refs) return [];
  const counts = new Map<string, number>();
  for (const emails of Object.values(refs.owners.byRef))
    for (const e of emails) counts.set(e, (counts.get(e) ?? 0) + 1);
  return [...counts]
    .map(([email, branches]) => ({
      email,
      name: refs.owners.names[email] ?? email,
      branches,
      isMe: email === refs.owners.me,
    }))
    .toSorted(
      (a, b) =>
        Number(b.isMe) - Number(a.isMe) || b.branches - a.branches || a.name.localeCompare(b.name),
    );
};

/** Graph visibility state and actions for one repository. */
export const useVisibility = (repo: RepoId) => {
  const client = useQueryClient();
  const { data } = useHiddenRefs(repo);
  const { data: refs } = useRefs(repo);
  const hidden = useMemo(() => data ?? [], [data]);
  const set = useMemo(() => new Set(hidden), [hidden]);
  const all = useMemo(() => allVisibilityNames(refs), [refs]);
  const owners = refs?.owners.byRef;
  const byRef = useMemo(() => owners ?? {}, [owners]);
  const contributors = useMemo(() => contributorsOf(refs), [refs]);
  const authors = useMemo(() => hiddenAuthors(hidden), [hidden]);

  /** Hidden by its own eye (or a hidden group). */
  const explicit = useCallback((name: string) => isHidden(set, name), [set]);
  /** Hidden only by the contributor filter. */
  const filtered = useCallback(
    (name: string) => !isHidden(set, name) && isFilteredOut(set, name, byRef[name]),
    [set, byRef],
  );
  const hiddenNow = useCallback(
    (name: string) => explicit(name) || isFilteredOut(set, name, byRef[name]),
    [explicit, set, byRef],
  );
  /** `showNames`, plus exceptions for names the contributor filter would still hide. */
  const reveal = useCallback(
    (names: readonly string[]) => {
      const next = showNames(hidden, names, all);
      const filteredOut = names.filter((n) => isFilteredOut(next, n, byRef[n]));
      return [...new Set([...next, ...filteredOut.map(exceptionKey)])];
    },
    [hidden, all, byRef],
  );

  const save = useCallback(
    (next: string[]) => {
      client.setQueryData(hiddenKey(repo), next);
      api("repo.setHiddenRefs", repo, next).catch((e: unknown) => {
        toast.error("Could not update graph visibility", { description: String(e) });
        void client.invalidateQueries({ queryKey: hiddenKey(repo) });
      });
    },
    [client, repo],
  );

  return {
    hidden,
    /** Every visibility-toggleable name. */
    all,
    anyHidden: authors.length > 0 || all.some(hiddenNow),
    /** Whether a name is left out of the graph, by its own eye or the contributor filter. */
    isHidden: hiddenNow,
    /** Whether a name is left out of the graph only by the contributor filter. */
    isFiltered: filtered,
    /** Owner emails of each branch, by full ref name. */
    owners: byRef,
    contributors,
    isAuthorHidden: useCallback((email: string) => set.has(authorKey(email)), [set]),
    toggle: useCallback(
      (name: string) =>
        save(
          hiddenNow(name)
            ? reveal([name])
            : [...hidden.filter((h) => h !== exceptionKey(name)), name],
        ),
      [hiddenNow, reveal, hidden, save],
    ),
    hide: useCallback(
      (names: readonly string[]) => save([...new Set([...hidden, ...names])]),
      [hidden, save],
    ),
    /**
     * Shows names and group prefixes, splitting any hidden group that covers them
     * and making exceptions to the contributor filter.
     */
    show: useCallback((names: readonly string[]) => save(reveal(names)), [reveal, save]),
    toggleAuthor: useCallback(
      (email: string) =>
        save(
          setHiddenAuthors(
            hidden,
            authors.includes(email) ? authors.filter((a) => a !== email) : [...authors, email],
            byRef,
          ),
        ),
      [hidden, authors, byRef, save],
    ),
    /** Hides every other contributor's branches (exceptions stay). */
    soloAuthors: useCallback(
      (emails: readonly string[]) =>
        save(
          setHiddenAuthors(
            hidden,
            contributors.map((c) => c.email).filter((e) => !emails.includes(e)),
            byRef,
          ),
        ),
      [hidden, contributors, byRef, save],
    ),
    showAllAuthors: useCallback(
      () => save(setHiddenAuthors(hidden, [], byRef)),
      [hidden, byRef, save],
    ),
    /**
     * Shows a group when all of its `names` are hidden and hides it otherwise:
     * by `prefix` when given (covering members added later), else name by name.
     */
    toggleGroup: useCallback(
      (names: readonly string[], prefix?: string) => {
        const scope = prefix === undefined ? names : [prefix, ...names];
        const allHidden = names.length > 0 && names.every(hiddenNow);
        save(
          allHidden
            ? reveal(scope)
            : [...new Set([...hidden, ...(prefix === undefined ? names : [prefix])])],
        );
      },
      [hidden, hiddenNow, reveal, save],
    ),
    /** Hides everything except `keep`. */
    solo: useCallback(
      (keep: readonly string[]) => {
        const kept = new Set(keep);
        save(all.filter((n) => !kept.has(n)));
      },
      [all, save],
    ),
    showAll: useCallback(() => save([]), [save]),
  };
};
