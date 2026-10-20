import type { RefsSnapshot, RepoId } from "@shared/domain";
import { isHidden, showNames, stashKey, toggleHidden } from "@shared/visibility";
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

/** Graph visibility state and actions for one repository. */
export const useVisibility = (repo: RepoId) => {
  const client = useQueryClient();
  const { data } = useHiddenRefs(repo);
  const { data: refs } = useRefs(repo);
  const hidden = useMemo(() => data ?? [], [data]);
  const set = useMemo(() => new Set(hidden), [hidden]);
  const all = useMemo(() => allVisibilityNames(refs), [refs]);

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
    anyHidden: hidden.length > 0,
    isHidden: useCallback((name: string) => isHidden(set, name), [set]),
    toggle: useCallback(
      (name: string) => save(toggleHidden(hidden, name, all)),
      [hidden, all, save],
    ),
    hide: useCallback(
      (names: readonly string[]) => save([...new Set([...hidden, ...names])]),
      [hidden, save],
    ),
    /** Shows names and group prefixes, splitting any hidden group that covers them. */
    show: useCallback(
      (names: readonly string[]) => save(showNames(hidden, names, all)),
      [hidden, all, save],
    ),
    /**
     * Shows a group when all of its `names` are hidden and hides it otherwise:
     * by `prefix` when given (covering members added later), else name by name.
     */
    toggleGroup: useCallback(
      (names: readonly string[], prefix?: string) => {
        const scope = prefix === undefined ? names : [prefix, ...names];
        const allHidden = names.length > 0 && names.every((n) => isHidden(set, n));
        save(
          allHidden
            ? showNames(hidden, scope, all)
            : [...new Set([...hidden, ...(prefix === undefined ? names : [prefix])])],
        );
      },
      [hidden, set, all, save],
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
