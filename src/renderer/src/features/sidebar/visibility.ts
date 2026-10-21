import type { BranchOwners, RefsSnapshot, RepoId } from "@shared/domain";
import {
  authorKey,
  exceptionKey,
  isContributorKey,
  isEmailHidden,
  isFilteredOut,
  isHidden,
  personKey,
  personOf,
  personOfEmail,
  setContributorFilter,
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

/** One email of a contributor. */
export interface ContributorEmail {
  readonly email: string;
  /** The name of its latest commit. */
  readonly name: string;
  /** Local and remote branches it owns. */
  readonly branches: number;
}

/** Someone who owns at least one branch: the owner emails that share a name (see `personOf`). */
export interface Contributor {
  readonly person: string;
  /** The spelling of the name used on most branches. */
  readonly name: string;
  /** The email with the latest commit, whose avatar stands for the contributor. */
  readonly avatarEmail: string;
  /** Most branches first. */
  readonly emails: readonly ContributorEmail[];
  /** Local and remote branches owned by any of the emails. */
  readonly branches: number;
  readonly isMe: boolean;
}

const NO_OWNERS: BranchOwners = { byRef: {}, people: {}, me: { email: null, name: null } };

/** Branch owners as a list: the current user first, then by number of branches. */
export const contributorsOf = (owners: BranchOwners): Contributor[] => {
  const byEmail = new Map<string, number>();
  const byPerson = new Map<string, Set<string>>();
  for (const [ref, emails] of Object.entries(owners.byRef)) {
    for (const e of emails) {
      byEmail.set(e, (byEmail.get(e) ?? 0) + 1);
      const person = personOfEmail(e, owners.people);
      const refs = byPerson.get(person) ?? new Set();
      refs.add(ref);
      byPerson.set(person, refs);
    }
  }
  const groups = new Map<string, ContributorEmail[]>();
  for (const [email, branches] of byEmail) {
    const person = personOfEmail(email, owners.people);
    const list = groups.get(person) ?? [];
    list.push({ email, name: owners.people[email]?.name ?? email, branches });
    groups.set(person, list);
  }
  const me = owners.me;
  return [...groups]
    .map(([person, list]): Contributor => {
      const emails = list.toSorted((a, b) => b.branches - a.branches);
      const spellings = new Map<string, number>();
      for (const e of emails) spellings.set(e.name, (spellings.get(e.name) ?? 0) + e.branches);
      const time = (e: ContributorEmail) => owners.people[e.email]?.time ?? 0;
      return {
        person,
        name: [...spellings].toSorted((a, b) => b[1] - a[1])[0]![0],
        avatarEmail: emails.reduce((a, b) => (time(b) > time(a) ? b : a)).email,
        emails,
        branches: byPerson.get(person)!.size,
        isMe:
          emails.some((e) => e.email === me.email) ||
          (me.name !== null && personOf(me.name) === person),
      };
    })
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
  const owners = refs?.owners ?? NO_OWNERS;
  const byRef = owners.byRef;
  const contributors = useMemo(() => contributorsOf(owners), [owners]);
  /** The `author:` and `person:` entries. */
  const filter = useMemo(() => hidden.filter(isContributorKey), [hidden]);
  const emailHidden = useCallback(
    (email: string) => isEmailHidden(set, email, owners.people),
    [set, owners],
  );

  /** Hidden by its own eye (or a hidden group). */
  const explicit = useCallback((name: string) => isHidden(set, name), [set]);
  /** Hidden only by the contributor filter. */
  const filtered = useCallback(
    (name: string) => !isHidden(set, name) && isFilteredOut(set, name, owners),
    [set, owners],
  );
  const hiddenNow = useCallback(
    (name: string) => explicit(name) || isFilteredOut(set, name, owners),
    [explicit, set, owners],
  );
  /** `showNames`, plus exceptions for names the contributor filter would still hide. */
  const reveal = useCallback(
    (names: readonly string[]) => {
      const next = showNames(hidden, names, all);
      const filteredOut = names.filter((n) => isFilteredOut(next, n, owners));
      return [...new Set([...next, ...filteredOut.map(exceptionKey)])];
    },
    [hidden, all, owners],
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
  const saveFilter = useCallback(
    (entries: readonly string[]) => save(setContributorFilter(hidden, entries, owners)),
    [hidden, owners, save],
  );

  return {
    hidden,
    /** Every visibility-toggleable name. */
    all,
    anyHidden: filter.length > 0 || all.some(hiddenNow),
    /** Whether a name is left out of the graph, by its own eye or the contributor filter. */
    isHidden: hiddenNow,
    /** Whether a name is left out of the graph only by the contributor filter. */
    isFiltered: filtered,
    /** Owner emails of each branch, by full ref name. */
    owners: byRef,
    contributors,
    /** Whether the contributor filter hides an email. */
    isEmailHidden: emailHidden,
    /** Whether the contributor filter hides all, some or none of a contributor's emails. */
    contributorVisibility: useCallback(
      (c: Contributor): "hidden" | "partial" | "visible" => {
        const n = c.emails.filter((e) => emailHidden(e.email)).length;
        return n === 0 ? "visible" : n === c.emails.length ? "hidden" : "partial";
      },
      [emailHidden],
    ),
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
    /**
     * Shows a contributor when all of their emails are hidden and hides them otherwise, by
     * name (covering emails added later).
     */
    toggleContributor: useCallback(
      (c: Contributor) => {
        const own = new Set([personKey(c.person), ...c.emails.map((e) => authorKey(e.email))]);
        const rest = filter.filter((h) => !own.has(h));
        const allHidden = c.emails.every((e) => emailHidden(e.email));
        saveFilter(allHidden ? rest : [...rest, personKey(c.person)]);
      },
      [filter, emailHidden, saveFilter],
    ),
    /** Toggles one email of a contributor, splitting a hidden contributor into their other emails. */
    toggleEmail: useCallback(
      (c: Contributor, email: string) => {
        const key = personKey(c.person);
        if (!emailHidden(email)) saveFilter([...filter, authorKey(email)]);
        else if (filter.includes(key))
          saveFilter([
            ...filter.filter((h) => h !== key),
            ...c.emails.filter((e) => e.email !== email).map((e) => authorKey(e.email)),
          ]);
        else saveFilter(filter.filter((h) => h !== authorKey(email)));
      },
      [filter, emailHidden, saveFilter],
    ),
    /** Hides every other contributor's branches (exceptions stay). */
    soloContributors: useCallback(
      (persons: readonly string[]) =>
        saveFilter(
          contributors.filter((c) => !persons.includes(c.person)).map((c) => personKey(c.person)),
        ),
      [contributors, saveFilter],
    ),
    showAllContributors: useCallback(() => saveFilter([]), [saveFilter]),
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
