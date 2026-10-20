import type { RefsSnapshot, RepoId } from "@shared/domain";
import { isHidden, stashKey, toggleHidden } from "@shared/visibility";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { keys } from "@/lib/queries";

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
  const hidden = useMemo(() => data ?? [], [data]);
  const set = useMemo(() => new Set(hidden), [hidden]);

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
    anyHidden: hidden.length > 0,
    isHidden: useCallback((name: string) => isHidden(set, name), [set]),
    /** Toggles one name; `siblings` lists the members of a group it may belong to. */
    toggle: useCallback(
      (name: string, siblings: readonly string[] = []) =>
        save(toggleHidden(hidden, name, siblings)),
      [hidden, save],
    ),
    hide: useCallback(
      (names: readonly string[]) => save([...new Set([...hidden, ...names])]),
      [hidden, save],
    ),
    show: useCallback(
      (names: readonly string[]) => {
        const drop = new Set(names);
        save(hidden.filter((h) => !drop.has(h)));
      },
      [hidden, save],
    ),
    /** Hides everything except `keep`. */
    solo: useCallback(
      (all: readonly string[], keep: string) => save(all.filter((n) => n !== keep)),
      [save],
    ),
    showAll: useCallback(() => save([]), [save]),
  };
};
