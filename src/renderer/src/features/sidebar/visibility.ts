import type { BranchOwners, RefsSnapshot, RepoId } from "@shared/domain";
import {
  authorKey,
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
  toggleHidden,
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
  for (const [ref, e] of Object.entries(owners.byRef)) {
    byEmail.set(e, (byEmail.get(e) ?? 0) + 1);
    const person = personOfEmail(e, owners.people);
    const refs = byPerson.get(person) ?? new Set();
    refs.add(ref);
    byPerson.set(person, refs);
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
        avatarEmail: emails.reduce((a, b) => (time(b) > time(a) ? b : a), emails[0]!).email,
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

  /** Hidden by its own eye (or a hidden group); remembered while the contributor filter hides it. */
  const explicit = useCallback((name: string) => isHidden(set, name), [set]);
  /** Hidden by the contributor filter: its own eye cannot change that. */
  const filtered = useCallback((name: string) => isFilteredOut(set, name, owners), [set, owners]);
  const hiddenNow = useCallback(
    (name: string) => explicit(name) || filtered(name),
    [explicit, filtered],
  );
  const byEmail = useMemo(
    () => new Map(contributors.flatMap((c) => c.emails.map((e) => [e.email, c] as const))),
    [contributors],
  );
  /** The contributor who owns a branch. */
  const ownerOf = useCallback(
    (name: string): Contributor | undefined => {
      const email = byRef[name];
      return email === undefined ? undefined : byEmail.get(email);
    },
    [byRef, byEmail],
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
  /**
   * Shows or hides a group's members, by `prefix` when given (covering members added later).
   * Members the contributor filter hides keep their own state, so then they are left out and
   * the prefix is not used.
   */
  const setGroup = useCallback(
    (names: readonly string[], prefix: string | undefined, show: boolean) => {
      const active = names.filter((n) => !filtered(n));
      if (active.length === 0) return;
      const whole = prefix !== undefined && active.length === names.length;
      save(
        show
          ? showNames(hidden, whole ? [prefix, ...active] : active, all)
          : [...new Set([...hidden, ...(whole ? [prefix] : active)])],
      );
    },
    [filtered, hidden, all, save],
  );
  const saveFilter = useCallback(
    (entries: readonly string[]) => save(setContributorFilter(hidden, entries)),
    [hidden, save],
  );

  return {
    hidden,
    /** Every visibility-toggleable name. */
    all,
    anyHidden: filter.length > 0 || all.some(hiddenNow),
    /** Whether a name is left out of the graph, by its own eye or the contributor filter. */
    isHidden: hiddenNow,
    /** Whether its own eye hides a name (whatever the contributor filter does). */
    isHiddenByEye: explicit,
    /** Whether the contributor filter hides a branch. */
    isFiltered: filtered,
    /** Owner email of each branch, by full ref name. */
    owners: byRef,
    ownerOf,
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
    /** Toggles a name's own eye; does nothing to a branch the contributor filter hides. */
    toggle: useCallback(
      (name: string) => {
        if (!filtered(name)) save(toggleHidden(hidden, name, all));
      },
      [filtered, hidden, all, save],
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
    /** Shows the owner of a branch the contributor filter hides. */
    showOwner: useCallback(
      (name: string) => {
        const c = ownerOf(name);
        if (!c) return;
        const own = new Set([personKey(c.person), ...c.emails.map((e) => authorKey(e.email))]);
        saveFilter(filter.filter((h) => !own.has(h)));
      },
      [ownerOf, filter, saveFilter],
    ),
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
    /** Hides every other contributor's branches. */
    soloContributors: useCallback(
      (persons: readonly string[]) =>
        saveFilter(
          contributors.filter((c) => !persons.includes(c.person)).map((c) => personKey(c.person)),
        ),
      [contributors, saveFilter],
    ),
    showAllContributors: useCallback(() => saveFilter([]), [saveFilter]),
    /**
     * Shows a group when all of its `names` are hidden and hides it otherwise (see `setGroup`).
     * Branches the contributor filter hides do not count.
     */
    toggleGroup: useCallback(
      (names: readonly string[], prefix?: string) =>
        setGroup(names, prefix, names.filter((n) => !filtered(n)).every(explicit)),
      [setGroup, filtered, explicit],
    ),
    showGroup: useCallback(
      (names: readonly string[], prefix?: string) => setGroup(names, prefix, true),
      [setGroup],
    ),
    hideGroup: useCallback(
      (names: readonly string[], prefix?: string) => setGroup(names, prefix, false),
      [setGroup],
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
