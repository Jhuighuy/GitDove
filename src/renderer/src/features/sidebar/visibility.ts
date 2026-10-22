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
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { api } from "@/lib/api";
import { keys, useHiddenRefs, useRefs } from "@/lib/queries";

/** All visibility-toggleable names in a repository (refs and stashes). */
export const allVisibilityNames = (refs: RefsSnapshot | undefined): string[] => [
  ...(refs?.refs ?? []).map((r) => r.name),
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

/** Flags of a name's state: hidden by its own eye (or group), hidden by the contributor filter. */
const EYE = 1;
const FILTER = 2;

const flagsFor = (hidden: readonly string[], name: string, owners: BranchOwners): number =>
  (isHidden(hidden, name) ? EYE : 0) | (isFilteredOut(hidden, name, owners) ? FILTER : 0);

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

/**
 * Hidden names being saved, by repository. They are shown rather than what a refresh reads
 * meanwhile, which may still be the names from before the save.
 */
const useSaving = create<{ readonly byRepo: Readonly<Record<RepoId, readonly string[]>> }>()(
  () => ({ byRepo: {} }),
);
/** The latest save per repository: only it ends the saving state. */
const saveSeq = new Map<RepoId, number>();

/** Graph visibility state and actions for one repository. */
export const useVisibility = (repo: RepoId) => {
  const client = useQueryClient();
  const { data } = useHiddenRefs(repo);
  const saving = useSaving((s) => s.byRepo[repo]);
  const { data: refs } = useRefs(repo);
  const hidden = useMemo(() => saving ?? data ?? [], [saving, data]);
  const all = useMemo(() => allVisibilityNames(refs), [refs]);
  const owners = refs?.owners ?? NO_OWNERS;
  const byRef = owners.byRef;
  const contributors = useMemo(() => contributorsOf(owners), [owners]);
  /** The `author:` and `person:` entries. */
  const filter = useMemo(() => hidden.filter(isContributorKey), [hidden]);
  const emailHidden = useCallback(
    (email: string) => isEmailHidden(hidden, email, owners.people),
    [hidden, owners],
  );

  // The state of every name, worked out once per change rather than on every lookup.
  const state = useMemo(() => {
    const flags = new Map<string, number>();
    let shown = 0;
    for (const name of all) {
      const f = flagsFor(hidden, name, owners);
      flags.set(name, f);
      if (f === 0) shown++;
    }
    return { flags, shown };
  }, [all, hidden, owners]);
  const flagsOf = useCallback(
    (name: string) => state.flags.get(name) ?? flagsFor(hidden, name, owners),
    [state, hidden, owners],
  );

  /** Hidden by its own eye (or a hidden group); remembered while the contributor filter hides it. */
  const explicit = useCallback((name: string) => (flagsOf(name) & EYE) !== 0, [flagsOf]);
  /** Hidden by the contributor filter: its own eye cannot change that. */
  const filtered = useCallback((name: string) => (flagsOf(name) & FILTER) !== 0, [flagsOf]);
  const hiddenNow = useCallback((name: string) => flagsOf(name) !== 0, [flagsOf]);
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
      const seq = (saveSeq.get(repo) ?? 0) + 1;
      saveSeq.set(repo, seq);
      useSaving.setState((s) => ({ byRepo: { ...s.byRepo, [repo]: next } }));
      client.setQueryData(keys.hidden(repo), next);
      const stamp = client.getQueryState(keys.hidden(repo))?.dataUpdatedAt;
      const saved = (ok: boolean) => {
        if (saveSeq.get(repo) !== seq) return;
        // A refresh meanwhile may have read the names from before the save, and a failed save
        // leaves them as they were: then they are read again.
        const query = client.getQueryState(keys.hidden(repo));
        const outdated = !ok || query?.dataUpdatedAt !== stamp || query?.fetchStatus === "fetching";
        if (ok) client.setQueryData(keys.hidden(repo), next);
        useSaving.setState((s) => {
          const { [repo]: _, ...rest } = s.byRepo;
          return { byRepo: rest };
        });
        if (outdated) void client.invalidateQueries({ queryKey: keys.hidden(repo) });
      };
      void api("repo.setHiddenRefs", repo, next).then(
        () => saved(true),
        (e: unknown) => {
          toast.error("Could not update graph visibility", { description: String(e) });
          saved(false);
        },
      );
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
    /** How many of `all` the graph shows. */
    visibleCount: state.shown,
    anyHidden: filter.length > 0 || state.shown < all.length,
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
