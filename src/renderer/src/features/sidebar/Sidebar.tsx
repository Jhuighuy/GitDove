import type { AvatarProvider } from "@shared/avatars";
import type { Ref, RefsSnapshot, Remote, RepoId, Stash, Submodule, Worktree } from "@shared/domain";
import { stashKey } from "@shared/visibility";
import {
  IconArchive,
  IconBox,
  IconBrandBitbucket,
  IconBrandGithub,
  IconChevronDown,
  IconChevronRight,
  IconBrandGitlab,
  IconCloud,
  IconDeviceLaptop,
  IconEye,
  IconEyeOff,
  IconFolder,
  IconFolderOpen,
  IconFolders,
  IconGitBranch,
  IconSearch,
  IconSquareCheckFilled,
  IconTag,
  IconUserOff,
  IconUsers,
} from "@tabler/icons-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  memo,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { Avatar, useAvatarProviders } from "@/components/Avatar";
import {
  ContextMenu,
  ContextMenuTrigger,
  isMenuKey,
  openActiveMenu,
  useContextMenuTarget,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { useRefs, useRepoInfo } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { commands } from "../commands";
import { type SectionDef, SectionStack } from "./SectionStack";
import { SidebarMenu, type SidebarTarget } from "./SidebarMenu";
import { buildTree, type TreeNode } from "./tree";
import { type Contributor, type ContributorEmail, useVisibility } from "./visibility";

type SectionTarget = Extract<SidebarTarget, { kind: "section" }>;

/** `filtered`: hidden by the contributor filter, which its own eye cannot change. */
type Visibility = "visible" | "hidden" | "filtered" | "partial" | "head" | "none";

interface FolderState {
  /** Collapsed branch folders, keyed by `folderKey` (default: expanded). */
  readonly collapsed: Readonly<Record<string, true>>;
  /** Contributors whose emails are listed, keyed by `folderKey` (default: collapsed). */
  readonly expanded: Readonly<Record<string, true>>;
  readonly toggle: (key: string) => void;
  readonly toggleExpanded: (key: string) => void;
  /** Forgets the folders of `repo` that are gone, keeping those in `keep`. */
  readonly prune: (repo: RepoId, keep: ReadonlySet<string>) => void;
}

const folderKey = (repo: RepoId, prefix: string) => `${repo}\n${prefix}`;

const useFolderStore = create<FolderState>()(
  persist(
    (set) => ({
      collapsed: {},
      expanded: {},
      toggle: (key) =>
        set((s) => {
          const { [key]: was, ...rest } = s.collapsed;
          return { collapsed: was ? rest : { ...rest, [key]: true } };
        }),
      toggleExpanded: (key) =>
        set((s) => {
          const { [key]: was, ...rest } = s.expanded;
          return { expanded: was ? rest : { ...rest, [key]: true } };
        }),
      prune: (repo, keep) =>
        set((s) => {
          const own = folderKey(repo, "");
          const stale = (k: string) => k.startsWith(own) && !keep.has(k);
          const drop = (r: Readonly<Record<string, true>>) =>
            Object.keys(r).some(stale)
              ? Object.fromEntries(Object.entries(r).filter(([k]) => !stale(k)))
              : r;
          const collapsed = drop(s.collapsed);
          const expanded = drop(s.expanded);
          return collapsed === s.collapsed && expanded === s.expanded ? s : { collapsed, expanded };
        }),
    }),
    { name: "gitdove.sidebar-folders" },
  ),
);

// ---------------------------------------------------------------------------
// Rows: the sections as flat lists, so that only the rows on screen are rendered
// ---------------------------------------------------------------------------

type Row =
  | {
      readonly kind: "folder";
      readonly key: string;
      readonly depth: number;
      readonly name: string;
      readonly title: string;
      readonly open: boolean;
      /** Collapsed over the checked-out branch, which it stands in for. */
      readonly hidesHead: boolean;
      readonly count: number;
      /** Full names of its branches, without the checked-out one (which is always shown). */
      readonly names: readonly string[];
      /** Full names of all its branches. */
      readonly members: readonly string[];
      /** The prefix it hides by, when it hides as a group. */
      readonly prefix: string | undefined;
      readonly folderKey: string;
      readonly visibility: Visibility;
    }
  | {
      readonly kind: "ref";
      readonly key: string;
      readonly depth: number;
      readonly ref: Ref;
      readonly label: string;
      readonly menu: "branch" | "remote-branch" | "tag";
      readonly visibility: Visibility;
      /** Who works on the branch. */
      readonly owner: Contributor | undefined;
    }
  | {
      readonly kind: "remote";
      readonly key: string;
      readonly name: string;
      readonly remote: Remote | undefined;
      readonly names: readonly string[];
      readonly visibility: Visibility;
    }
  | {
      readonly kind: "contributor";
      readonly key: string;
      readonly contributor: Contributor;
      /** Whether the emails are listed, for a contributor with several. */
      readonly open: boolean | undefined;
      readonly folderKey: string;
      readonly visibility: Visibility;
    }
  | {
      readonly kind: "email";
      readonly key: string;
      readonly contributor: Contributor;
      readonly email: ContributorEmail;
      readonly visibility: Visibility;
    }
  | {
      readonly kind: "worktree";
      readonly key: string;
      readonly worktree: Worktree;
      readonly current: boolean;
    }
  | {
      readonly kind: "stash";
      readonly key: string;
      readonly stash: Stash;
      readonly visibility: Visibility;
    }
  | { readonly kind: "submodule"; readonly key: string; readonly submodule: Submodule };

/** How many of a section's items the graph shows. */
interface Count {
  readonly shown: number;
  readonly total: number;
}

type Vis = ReturnType<typeof useVisibility>;

interface Groups {
  readonly locals: { readonly refs: readonly Ref[]; readonly tree: readonly TreeNode<Ref>[] };
  readonly remotes: ReadonlyMap<string, { refs: readonly Ref[]; tree: readonly TreeNode<Ref>[] }>;
  /** Newest first. */
  readonly tags: readonly Ref[];
}

const groupsOf = (data: RefsSnapshot | undefined): Groups => {
  const refs = data?.refs ?? [];
  const byRemote = new Map<string, Ref[]>();
  for (const r of data?.remotes ?? []) byRemote.set(r.name, []);
  for (const r of refs) {
    if (r.kind !== "remote") continue;
    const list = byRemote.get(r.remote ?? "") ?? [];
    list.push(r);
    byRemote.set(r.remote ?? "", list);
  }
  const remotes = new Map<string, { refs: Ref[]; tree: TreeNode<Ref>[] }>();
  for (const [name, list] of byRemote) {
    const tree = buildTree(list, (r) => r.short.slice(name.length + 1), `refs/remotes/${name}/`);
    remotes.set(name, { refs: list, tree });
  }
  const branches = refs.filter((r) => r.kind === "branch");
  return {
    locals: { refs: branches, tree: buildTree(branches, (r) => r.short, "refs/heads/") },
    remotes,
    tags: refs.filter((r) => r.kind === "tag").toReversed(),
  };
};

/** Every folder key of a repository's refs, to forget collapsed folders that are gone. */
const folderKeysOf = (repo: RepoId, groups: Groups, contributors: readonly Contributor[]) => {
  const keys = new Set<string>();
  const walk = (nodes: readonly TreeNode<Ref>[]) => {
    for (const n of nodes) {
      if (n.kind === "folder") {
        keys.add(folderKey(repo, n.prefix));
        walk(n.children);
      }
    }
  };
  walk(groups.locals.tree);
  for (const { tree } of groups.remotes.values()) walk(tree);
  for (const c of contributors) keys.add(folderKey(repo, `contributor:${c.person}`));
  return keys;
};

interface RowsInput {
  readonly repo: RepoId;
  readonly data: RefsSnapshot | undefined;
  readonly groups: Groups;
  /** Lowercase; empty for no filter. */
  readonly filter: string;
  readonly collapsed: FolderState["collapsed"];
  readonly expanded: FolderState["expanded"];
  readonly vis: Pick<
    Vis,
    | "isHidden"
    | "isFiltered"
    | "ownerOf"
    | "contributors"
    | "contributorVisibility"
    | "isEmailHidden"
  >;
  readonly workTree: string | undefined;
}

/** The rows of each section, and how many of their items the graph shows. */
const rowsOf = ({
  repo,
  data,
  groups,
  filter: f,
  collapsed,
  expanded,
  vis,
  workTree,
}: RowsInput) => {
  const match = (s: string) => !f || s.toLowerCase().includes(f);
  const count = (names: readonly string[]): Count => ({
    shown: names.reduce((n, name) => (vis.isHidden(name) ? n : n + 1), 0),
    total: names.length,
  });
  const refVisibility = (r: Ref): Visibility =>
    r.isHead
      ? "head"
      : vis.isFiltered(r.name)
        ? "filtered"
        : vis.isHidden(r.name)
          ? "hidden"
          : "visible";
  const groupVisibility = (names: readonly string[]): Visibility => {
    if (names.length > 0 && names.every(vis.isFiltered)) return "filtered";
    const hidden = names.reduce((n, name) => (vis.isHidden(name) ? n + 1 : n), 0);
    if (names.length === 0 || hidden === 0) return "visible";
    return hidden === names.length ? "hidden" : "partial";
  };
  const refRow = (
    r: Ref,
    label: string,
    depth: number,
    menu: "branch" | "remote-branch" | "tag",
  ): Row => ({
    kind: "ref",
    key: `ref:${r.name}`,
    depth,
    ref: r,
    label,
    menu,
    visibility: refVisibility(r),
    owner: vis.ownerOf(r.name),
  });

  /**
   * Adds a branch tree's rows. Folders hide by prefix when `byPrefix` is set, else branch by
   * branch (like the Local section, so new branches stay visible).
   */
  const tree = (
    out: Row[],
    nodes: readonly TreeNode<Ref>[],
    depth: number,
    byPrefix: boolean,
    menu: "branch" | "remote-branch",
  ) => {
    for (const n of nodes) {
      if (n.kind === "leaf") {
        if (match(n.item.short)) out.push(refRow(n.item, n.name, depth, menu));
        continue;
      }
      if (f && !n.items.some((r) => match(r.short))) continue;
      // The checked-out branch is always shown, so it does not count towards a folder's state.
      const names = n.items.filter((r) => !r.isHead).map((r) => r.name);
      const key = folderKey(repo, n.prefix);
      const open = !!f || !collapsed[key];
      out.push({
        kind: "folder",
        key: `folder:${n.prefix}`,
        depth,
        name: n.name,
        title: n.prefix.replace(/^refs\/(heads|remotes)\//, ""),
        open,
        hidesHead: !open && n.items.some((r) => r.isHead),
        count: n.items.length,
        names,
        members: n.items.map((r) => r.name),
        prefix: byPrefix ? n.prefix : undefined,
        folderKey: key,
        visibility: groupVisibility(names),
      });
      if (open) tree(out, n.children, depth + 1, byPrefix, menu);
    }
  };

  const local: Row[] = [];
  tree(local, groups.locals.tree, 0, false, "branch");

  const remote: Row[] = [];
  // With a single remote its subtree adds nothing: its branches are listed flatly (and its
  // own actions move to the section header menu).
  const flat = groups.remotes.size === 1;
  for (const [name, { refs, tree: nodes }] of groups.remotes) {
    if (!flat) {
      const names = refs.map((r) => r.name);
      remote.push({
        kind: "remote",
        key: `remote:${name}`,
        name,
        remote: data?.remotes.find((r) => r.name === name),
        names,
        visibility: groupVisibility(names),
      });
    }
    tree(remote, nodes, flat ? 0 : 1, true, "remote-branch");
  }

  const contributors: Row[] = [];
  for (const c of vis.contributors) {
    const emails = c.emails.filter((e) => match(e.email));
    if (!match(c.name) && emails.length === 0) continue;
    const multi = c.emails.length > 1;
    const key = folderKey(repo, `contributor:${c.person}`);
    // Searching by email shows the matching emails.
    const open = multi && (!!expanded[key] || (!!f && emails.length > 0 && !match(c.name)));
    contributors.push({
      kind: "contributor",
      key: `person:${c.person}`,
      contributor: c,
      open: multi ? open : undefined,
      folderKey: key,
      visibility: vis.contributorVisibility(c),
    });
    if (!open) continue;
    for (const e of f && !match(c.name) ? emails : c.emails) {
      contributors.push({
        kind: "email",
        key: `email:${c.person}\n${e.email}`,
        contributor: c,
        email: e,
        visibility: vis.isEmailHidden(e.email) ? "hidden" : "visible",
      });
    }
  }

  const stashes = data?.stashes ?? [];
  return {
    local,
    remote,
    contributors,
    worktrees: (data?.worktrees ?? [])
      .filter((w) => match(w.path))
      .map((w): Row => ({
        kind: "worktree",
        key: `worktree:${w.path}`,
        worktree: w,
        current: w.path === workTree,
      })),
    stashes: stashes
      .filter((s) => match(s.message))
      .map((s): Row => ({
        kind: "stash",
        key: `stash:${s.hash}`,
        stash: s,
        visibility: vis.isHidden(stashKey(s.hash)) ? "hidden" : "visible",
      })),
    tags: groups.tags.filter((r) => match(r.short)).map((r) => refRow(r, r.short, 0, "tag")),
    submodules: (data?.submodules ?? [])
      .filter((s) => match(s.path))
      .map((s): Row => ({ kind: "submodule", key: `submodule:${s.path}`, submodule: s })),
    counts: {
      local: count(groups.locals.refs.map((r) => r.name)),
      remote: count([...groups.remotes.values()].flatMap((t) => t.refs.map((r) => r.name))),
      contributors: {
        shown: vis.contributors.filter((c) => vis.contributorVisibility(c) !== "hidden").length,
        total: vis.contributors.length,
      },
      stashes: count(stashes.map((s) => stashKey(s.hash))),
      tags: count(groups.tags.map((t) => t.name)),
    },
  };
};

/** What a row's context menu is for; none for a row without one. */
const targetOf = (row: Row): SidebarTarget | null => {
  switch (row.kind) {
    case "folder":
      return {
        kind: "folder",
        name: row.name,
        names: row.names,
        members: row.members,
        prefix: row.prefix,
      };
    case "ref":
      return { kind: row.menu, ref: row.ref };
    case "remote":
      return row.remote ? { kind: "remote", remote: row.remote } : null;
    case "contributor":
      return { kind: "contributor", contributor: row.contributor };
    case "email":
      return { kind: "contributor", contributor: row.contributor, email: row.email.email };
    case "worktree":
      return { kind: "worktree", worktree: row.worktree };
    case "stash":
      return { kind: "stash", stash: row.stash };
    case "submodule":
      return { kind: "submodule", submodule: row.submodule };
  }
};

/** What rows do when used. */
interface RowActions {
  /** The eye: shows or hides the row in the graph. */
  toggle(row: Row): void;
  click(row: Row): void;
  doubleClick(row: Row): void;
  /** Enter: the click's action, or the double-click's for rows that only open. */
  activate(row: Row): void;
  /** The keyboard cursor moved onto the row: shows its commit, like a click. */
  hop(row: Row): void;
  contextMenu(row: Row): void;
}

/** Runs a row action; stable for the sidebar's lifetime. */
type OnAction = (action: keyof RowActions, row: Row) => void;

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

const renderCount = ({ shown, total }: Count) =>
  shown === total ? (
    <span>{total}</span>
  ) : (
    <span className="font-medium text-primary">
      {shown}/{total}
    </span>
  );

export const Sidebar = memo(function Sidebar({ repo }: { repo: RepoId }) {
  const { data } = useRefs(repo);
  const { data: info } = useRepoInfo(repo);
  const vis = useVisibility(repo);
  const providers = useAvatarProviders(repo);
  const [filter, setFilter] = useState("");
  // The rows follow typing when there is time: the field never waits for them.
  const f = useDeferredValue(filter.trim().toLowerCase());
  const collapsed = useFolderStore((s) => s.collapsed);
  const expanded = useFolderStore((s) => s.expanded);
  const menu = useContextMenuTarget<SidebarTarget>();

  const groups = useMemo(() => groupsOf(data), [data]);
  const { isHidden, isFiltered, ownerOf, contributors, contributorVisibility, isEmailHidden } = vis;
  const rows = useMemo(
    () =>
      rowsOf({
        repo,
        data,
        groups,
        filter: f,
        collapsed,
        expanded,
        vis: {
          isHidden,
          isFiltered,
          ownerOf,
          contributors,
          contributorVisibility,
          isEmailHidden,
        },
        workTree: info?.workTree,
      }),
    [
      repo,
      data,
      groups,
      f,
      collapsed,
      expanded,
      isHidden,
      isFiltered,
      ownerOf,
      contributors,
      contributorVisibility,
      isEmailHidden,
      info?.workTree,
    ],
  );

  // Collapsed folders that are gone are forgotten.
  useEffect(() => {
    if (data) useFolderStore.getState().prune(repo, folderKeysOf(repo, groups, contributors));
  }, [repo, data, groups, contributors]);

  // Rows call the latest of these through `onAction`, which stays the same.
  const handlers: RowActions = {
    toggle(row) {
      switch (row.kind) {
        case "folder":
          return vis.toggleGroup(row.names, row.prefix);
        case "ref":
          return vis.toggle(row.ref.name);
        case "remote":
          return vis.toggleGroup(row.names, `refs/remotes/${row.name}/`);
        case "contributor":
          return vis.toggleContributor(row.contributor);
        case "email":
          return vis.toggleEmail(row.contributor, row.email.email);
        case "stash":
          return vis.toggle(stashKey(row.stash.hash));
      }
    },
    click(row) {
      switch (row.kind) {
        case "folder":
          // While filtering, matching folders are open whatever their saved state.
          if (!f) useFolderStore.getState().toggle(row.folderKey);
          return;
        case "ref":
          return commands.selectCommit(repo, row.ref.hash);
        case "contributor":
          if (row.open !== undefined) useFolderStore.getState().toggleExpanded(row.folderKey);
          return;
        case "stash":
          return commands.selectCommit(repo, row.stash.hash);
      }
    },
    doubleClick(row) {
      switch (row.kind) {
        case "ref":
          // A tag checks out its commit: a branch may have the same name.
          return void commands.checkoutRef(repo, row.ref);
        case "worktree":
          if (!row.current) commands.openSibling(repo, row.worktree.path);
          return;
        case "stash":
          return void commands.applyStash(repo, row.stash);
        case "submodule":
          return commands.openSibling(repo, row.submodule.path);
      }
    },
    activate(row) {
      if (row.kind === "worktree" || row.kind === "submodule") handlers.doubleClick(row);
      else handlers.click(row);
    },
    hop(row) {
      // Only rows with a commit: clicking the others expands or collapses them.
      if (row.kind === "ref" || row.kind === "stash") handlers.click(row);
    },
    contextMenu(row) {
      const target = targetOf(row);
      if (target) menu.capture(target);
    },
  };
  const handlersRef = useRef(handlers);
  useLayoutEffect(() => {
    handlersRef.current = handlers;
  });
  const onAction = useCallback<OnAction>((action, row) => handlersRef.current[action](row), []);
  const capture = menu.capture;
  const list = (items: readonly Row[], label: string) => (
    <RowList rows={items} label={label} onAction={onAction} providers={providers} />
  );

  // Every header offers to show or hide the sections.
  const sectionMenu = (section: SectionTarget["section"]): void =>
    capture({
      kind: "section",
      section,
      sections: sections.map(({ id, title }) => ({ id, title })),
    });

  const sections: SectionDef[] = [
    {
      id: "local",
      title: "Local",
      icon: <IconDeviceLaptop />,
      count: renderCount(rows.counts.local),
      onHeaderContextMenu: () => sectionMenu("local"),
      children: list(rows.local, "Local branches"),
    },
    {
      id: "remote",
      title: "Remote",
      icon: <IconCloud />,
      count: renderCount(rows.counts.remote),
      onHeaderContextMenu: () => sectionMenu("remote"),
      children: list(rows.remote, "Remote branches"),
    },
    {
      id: "contributors",
      title: "Contributors",
      icon: <IconUsers />,
      count: renderCount(rows.counts.contributors),
      onHeaderContextMenu: () => sectionMenu("contributors"),
      children: list(rows.contributors, "Contributors"),
    },
    {
      id: "worktrees",
      title: "Worktrees",
      icon: <IconFolders />,
      count: <span>{data?.worktrees.length ?? 0}</span>,
      defaultOpen: false,
      onHeaderContextMenu: () => sectionMenu("worktrees"),
      children: list(rows.worktrees, "Worktrees"),
    },
    {
      id: "stashes",
      title: "Stashes",
      icon: <IconArchive />,
      count: renderCount(rows.counts.stashes),
      onHeaderContextMenu: () => sectionMenu("stashes"),
      children: list(rows.stashes, "Stashes"),
    },
    {
      id: "tags",
      title: "Tags",
      icon: <IconTag />,
      count: renderCount(rows.counts.tags),
      defaultOpen: false,
      onHeaderContextMenu: () => sectionMenu("tags"),
      children: list(rows.tags, "Tags"),
    },
    ...((data?.submodules.length ?? 0) > 0
      ? [
          {
            id: "submodules",
            title: "Submodules",
            icon: <IconBox />,
            count: <span>{data?.submodules.length}</span>,
            defaultOpen: false,
            onHeaderContextMenu: () => sectionMenu("submodules"),
            children: list(rows.submodules, "Submodules"),
          },
        ]
      : []),
  ];

  return (
    <div className="bg-sidebar flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-1.5 p-2 pb-1.5">
        <div className="flex h-5 items-center justify-between px-1 text-[11px]">
          <span className="text-muted-foreground">
            Viewing{" "}
            <span className={cn("tabular-nums", vis.anyHidden && "font-medium text-primary")}>
              {vis.visibleCount}/{vis.all.length}
            </span>
          </span>
          {vis.anyHidden && (
            <button type="button" className="text-primary hover:underline" onClick={vis.showAll}>
              Show all
            </button>
          )}
        </div>
        <div className="relative">
          <IconSearch className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter"
            aria-label="Filter branches, tags and more"
            className="h-7 rounded-lg pl-7 text-xs"
          />
        </div>
      </div>
      <ContextMenu {...menu.rootProps}>
        <ContextMenuTrigger render={<div className="flex min-h-0 flex-1 flex-col border-t" />}>
          <SectionStack sections={sections} />
        </ContextMenuTrigger>
        {menu.target && <SidebarMenu repo={repo} target={menu.target} vis={vis} />}
      </ContextMenu>
    </div>
  );
});

function RemoteIcon({ remote }: { remote: Remote | undefined }) {
  const url = remote?.fetchUrl ?? "";
  if (url.includes("github")) return <IconBrandGithub />;
  if (url.includes("gitlab")) return <IconBrandGitlab />;
  if (url.includes("bitbucket")) return <IconBrandBitbucket />;
  return <IconCloud />;
}

// ---------------------------------------------------------------------------
// A section's rows
// ---------------------------------------------------------------------------

const ITEM_HEIGHT = 24;

/**
 * A section's rows as a tree, rendering only those on screen. The keyboard moves a cursor over
 * the rows (the list keeps focus), selecting the commit of each branch, tag or stash it lands
 * on: Enter uses a row, Space toggles its eye, Left and Right collapse and expand, and the menu
 * key opens its context menu.
 */
const RowList = memo(function RowList({
  rows,
  label,
  onAction,
  providers,
}: {
  rows: readonly Row[];
  label: string;
  onAction: OnAction;
  providers: readonly AvatarProvider[];
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const id = useId();
  // Stable while the rows are: a new function makes the virtualizer measure every row again.
  const getItemKey = useCallback((i: number) => rows[i]!.key, [rows]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ITEM_HEIGHT,
    getItemKey,
    overscan: 12,
    paddingEnd: 4,
  });
  // The keyboard cursor, by row key so that it stays on its row when rows come and go.
  const [cursor, setCursor] = useState<string | null>(null);
  const cursorIndex = useMemo(
    () => (cursor === null ? -1 : rows.findIndex((r) => r.key === cursor)),
    [rows, cursor],
  );
  const rowId = (index: number) => `${id}-${index}`;
  const items = virtualizer.getVirtualItems();

  const moveTo = (index: number) => {
    const row = rows[Math.min(rows.length - 1, Math.max(0, index))];
    if (!row) return;
    setCursor(row.key);
    virtualizer.scrollToIndex(rows.indexOf(row), { align: "auto" });
    if (row.key !== cursor) onAction("hop", row);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const row = rows[cursorIndex];
    if (isMenuKey(e)) {
      e.preventDefault();
      if (row) {
        openActiveMenu(scrollRef.current, rowId(cursorIndex), () =>
          virtualizer.scrollToIndex(cursorIndex, { align: "auto" }),
        );
      }
      return;
    }
    const page = Math.max(1, Math.floor((virtualizer.scrollRect?.height ?? 0) / ITEM_HEIGHT) - 1);
    const open = row?.kind === "folder" || row?.kind === "contributor" ? row.open : undefined;
    switch (e.key) {
      case "ArrowDown":
        moveTo(cursorIndex + 1);
        break;
      case "ArrowUp":
        moveTo(cursorIndex < 0 ? 0 : cursorIndex - 1);
        break;
      case "PageDown":
        moveTo(cursorIndex + page);
        break;
      case "PageUp":
        moveTo(cursorIndex - page);
        break;
      case "Home":
        moveTo(0);
        break;
      case "End":
        moveTo(rows.length - 1);
        break;
      case "Enter":
        if (row) onAction("activate", row);
        break;
      case " ":
        if (row) onAction("toggle", row);
        break;
      case "ArrowRight":
        if (row && open === false) onAction("click", row);
        break;
      case "ArrowLeft":
        if (row && open === true) onAction("click", row);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <div
      ref={scrollRef}
      role="tree"
      aria-label={label}
      tabIndex={0}
      aria-activedescendant={
        items.some((i) => i.index === cursorIndex) ? rowId(cursorIndex) : undefined
      }
      className="group/tree min-h-0 flex-1 overflow-y-auto outline-none"
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        // Tabbing in starts at the first row, unless a click put the cursor somewhere.
        const first = rows[0];
        if (e.target === e.currentTarget && first)
          setCursor((c) => (c !== null && rows.some((r) => r.key === c) ? c : first.key));
      }}
      onMouseDown={(e) => {
        // The cursor goes on from the row clicked.
        const key = (e.target as HTMLElement).closest<HTMLElement>("[data-key]")?.dataset.key;
        if (key !== undefined) setCursor(key);
      }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {items.map((item) => (
          <SidebarItem
            key={item.key}
            id={rowId(item.index)}
            top={item.start}
            row={rows[item.index]!}
            cursor={item.index === cursorIndex}
            onAction={onAction}
            providers={providers}
          />
        ))}
      </div>
    </div>
  );
});

const SidebarItem = memo(function SidebarItem({
  id,
  top,
  row,
  cursor,
  onAction,
  providers,
}: {
  id: string;
  top: number;
  row: Row;
  cursor: boolean;
  onAction: OnAction;
  providers: readonly AvatarProvider[];
}) {
  const common = {
    id,
    rowKey: row.key,
    top,
    cursor,
    onToggle: () => onAction("toggle", row),
    onClick: () => onAction("click", row),
    onDoubleClick: () => onAction("doubleClick", row),
    onContextMenu: () => onAction("contextMenu", row),
  };
  switch (row.kind) {
    case "folder":
      return (
        <Item
          {...common}
          depth={row.depth}
          expanded={row.open}
          icon={row.open ? <IconFolderOpen /> : <IconFolder />}
          label={row.name}
          title={row.title}
          active={row.hidesHead}
          visibility={row.visibility}
          trailing={
            !row.open && (
              <>
                {row.hidesHead && (
                  <span
                    className="flex shrink-0 text-primary"
                    title="Contains the checked-out branch"
                  >
                    <IconSquareCheckFilled aria-hidden />
                    <span className="sr-only">Contains the checked-out branch</span>
                  </span>
                )}
                <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">
                  {row.count}
                </span>
              </>
            )
          }
        />
      );
    case "ref":
      return (
        <RefItem
          {...common}
          depth={row.depth}
          refItem={row.ref}
          label={row.label}
          title={row.ref.short}
          icon={row.menu === "tag" ? <IconTag /> : <IconGitBranch />}
          owner={row.owner}
          providers={providers}
          visibility={row.visibility}
        />
      );
    case "remote":
      return (
        <Item
          {...common}
          icon={<RemoteIcon remote={row.remote} />}
          label={row.name}
          title={row.remote?.fetchUrl ?? row.name}
          visibility={row.visibility}
        />
      );
    case "contributor":
      return (
        <ContributorItem
          {...common}
          contributor={row.contributor}
          providers={providers}
          open={row.open}
          visibility={row.visibility}
        />
      );
    case "email":
      return (
        <Item
          {...common}
          depth={1}
          icon={
            <Avatar name={row.email.name} email={row.email.email} providers={providers} size={14} />
          }
          label={row.email.email}
          title={row.email.email}
          visibility={row.visibility}
          trailing={
            <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">
              {row.email.branches}
            </span>
          }
        />
      );
    case "worktree":
      return <WorktreeItem {...common} worktree={row.worktree} current={row.current} />;
    case "stash":
      return <StashItem {...common} stash={row.stash} visibility={row.visibility} />;
    case "submodule":
      return <SubmoduleItem {...common} submodule={row.submodule} />;
  }
});

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

interface ItemProps {
  readonly id: string;
  /** The row's key, for the list to find the row clicked. */
  readonly rowKey: string;
  /** Where the row is in the list, in pixels. */
  readonly top: number;
  /** The keyboard cursor is on it. */
  readonly cursor: boolean;
  readonly icon: ReactNode;
  readonly label: string;
  readonly depth?: number;
  /** Whether its children are shown, for a row that has some. */
  readonly expanded?: boolean;
  readonly visibility?: Visibility;
  /** Who hides a `filtered` item, for its tooltip. */
  readonly filteredBy?: string;
  readonly active?: boolean;
  readonly trailing?: ReactNode;
  readonly title?: string;
  readonly onToggle?: () => void;
  readonly onClick?: () => void;
  readonly onDoubleClick?: () => void;
  readonly onContextMenu?: () => void;
}

function Item({
  id,
  rowKey,
  top,
  cursor,
  icon,
  label,
  depth = 0,
  expanded,
  visibility = "none",
  filteredBy,
  active,
  trailing,
  title,
  onToggle,
  onClick,
  onDoubleClick,
  onContextMenu,
}: ItemProps) {
  const dim = visibility === "hidden" || visibility === "filtered";
  return (
    <div
      id={id}
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={expanded}
      aria-selected={cursor}
      data-key={rowKey}
      className={cn(
        "group hover:bg-sidebar-accent absolute inset-x-0 top-0 flex h-6 cursor-default items-center gap-1.5 pr-2 pl-1 text-[12px] select-none [&_svg]:size-3.5 [&_svg]:shrink-0",
        active && "bg-selected hover:bg-selected font-semibold",
        cursor &&
          "group-focus-visible/tree:ring-ring/60 group-focus-visible/tree:ring-1 group-focus-visible/tree:ring-inset",
      )}
      style={{ transform: `translateY(${top}px)` }}
      title={title ?? label}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <VisibilityToggle
        label={label}
        visibility={visibility}
        filteredBy={filteredBy}
        onToggle={onToggle}
      />
      <span
        className={cn("text-muted-foreground flex", dim && "opacity-50")}
        style={{ marginLeft: depth * 14 }}
      >
        {icon}
      </span>
      <span className={cn("min-w-0 flex-1 truncate", dim && "text-muted-foreground opacity-70")}>
        {label}
      </span>
      {trailing}
    </div>
  );
}

function VisibilityToggle({
  label,
  visibility,
  filteredBy = "its owner",
  onToggle,
}: {
  label: string;
  visibility: Visibility;
  filteredBy?: string;
  onToggle?: () => void;
}) {
  if (visibility === "none") return <span className="w-5 shrink-0" />;
  if (visibility === "head") {
    return (
      <span
        className="flex w-5 shrink-0 justify-center text-primary"
        title="Checked out (always shown)"
      >
        <IconSquareCheckFilled />
      </span>
    );
  }
  const off = visibility === "hidden" || visibility === "partial";
  if (visibility === "filtered") {
    return (
      <span
        className="text-muted-foreground flex w-5 shrink-0 justify-center"
        title={`Hidden with ${filteredBy}`}
      >
        <IconUserOff />
      </span>
    );
  }
  const action = visibility === "hidden" ? "Show in graph" : "Hide from graph";
  return (
    // The list's Space key toggles it, so it stays out of the tab order.
    <button
      type="button"
      tabIndex={-1}
      title={action}
      aria-label={`${action}: ${label}`}
      className={cn(
        "text-muted-foreground hover:text-foreground flex w-5 shrink-0 justify-center",
        !off && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
      )}
      // The focus stays with the list, whose keys go on from this row.
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        onToggle?.();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {off ? <IconEyeOff /> : <IconEye />}
    </button>
  );
}

function RefItem({
  refItem: r,
  owner,
  providers,
  ...rest
}: Omit<ItemProps, "active" | "trailing"> & {
  refItem: Ref;
  /** Who works on the branch. */
  owner: Contributor | undefined;
  providers: readonly AvatarProvider[];
}) {
  const track = r.upstreamGone
    ? "gone"
    : [r.ahead ? r.ahead + "↑" : "", r.behind ? r.behind + "↓" : ""].join(" ").trim();
  return (
    <Item
      {...rest}
      filteredBy={owner?.name}
      active={r.isHead}
      trailing={
        <>
          {track && (
            <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">{track}</span>
          )}
          {owner && (
            <span
              className={cn("flex shrink-0", rest.visibility === "filtered" && "opacity-50")}
              title={`By ${owner.name}`}
            >
              <Avatar name={owner.name} email={owner.avatarEmail} providers={providers} size={14} />
            </span>
          )}
        </>
      }
    />
  );
}

function ContributorItem({
  contributor: c,
  providers,
  open,
  ...rest
}: Omit<ItemProps, "label" | "icon" | "trailing" | "expanded"> & {
  contributor: Contributor;
  providers: readonly AvatarProvider[];
  /** Whether the emails are listed, for a contributor with several. */
  open: boolean | undefined;
}) {
  const dim = rest.visibility === "hidden";
  return (
    <Item
      {...rest}
      expanded={open}
      icon={
        <span className={cn("flex", dim && "grayscale")}>
          <Avatar name={c.name} email={c.avatarEmail} providers={providers} size={14} />
        </span>
      }
      label={c.name}
      title={c.emails.map((e) => e.email).join(", ")}
      trailing={
        <>
          {c.isMe && <span className="text-muted-foreground shrink-0 text-[10px]">you</span>}
          {open !== undefined && (
            <span
              className="text-muted-foreground flex shrink-0"
              title={`${c.emails.length} emails`}
            >
              {open ? <IconChevronDown /> : <IconChevronRight />}
            </span>
          )}
          <span
            className="text-muted-foreground shrink-0 text-[10px] tabular-nums"
            title={`${c.branches} ${c.branches === 1 ? "branch" : "branches"}`}
          >
            {c.branches}
          </span>
        </>
      }
    />
  );
}

function StashItem({ stash, ...rest }: Omit<ItemProps, "label" | "icon"> & { stash: Stash }) {
  return (
    <Item
      {...rest}
      icon={<IconArchive />}
      label={stash.message}
      title={`${stash.name}: ${stash.message}`}
    />
  );
}

function WorktreeItem({
  worktree: w,
  current,
  ...rest
}: Omit<ItemProps, "label" | "icon"> & { worktree: Worktree; current: boolean }) {
  const name = w.path.split(/[\\/]/).at(-1) ?? w.path;
  return (
    <Item
      {...rest}
      icon={<IconFolders />}
      label={w.branch ? `${name} (${w.branch})` : `${name} (detached)`}
      title={w.path}
      active={current}
      trailing={w.isMain && <span className="text-muted-foreground text-[10px]">main</span>}
    />
  );
}

function SubmoduleItem({
  submodule: s,
  ...rest
}: Omit<ItemProps, "label" | "icon"> & { submodule: Submodule }) {
  return (
    <Item
      {...rest}
      icon={<IconBox />}
      label={s.path}
      trailing={
        s.status !== "ok" && <span className="text-muted-foreground text-[10px]">{s.status}</span>
      }
    />
  );
}
