import type { AvatarProvider } from "@shared/avatars";
import type { Ref, Remote, RepoId, Stash, Submodule, Worktree } from "@shared/domain";
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
import { type ReactNode, useMemo, useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { Avatar, useAvatarProviders } from "@/components/Avatar";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { useRefs, useRepoInfo } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { commands } from "../commands";
import { type SectionDef, SectionStack } from "./SectionStack";
import { SidebarMenu, type SidebarTarget } from "./SidebarMenu";

type SectionTarget = Extract<SidebarTarget, { kind: "section" }>;
import { buildTree, type TreeNode } from "./tree";
import { type Contributor, useVisibility } from "./visibility";

/** `filtered`: hidden by the contributor filter, which its own eye cannot change. */
type Visibility = "visible" | "hidden" | "filtered" | "partial" | "head" | "none";

interface FolderState {
  /** Collapsed branch folders, keyed by `folderKey` (default: expanded). */
  readonly collapsed: Readonly<Record<string, true>>;
  /** Contributors whose emails are listed, keyed by `folderKey` (default: collapsed). */
  readonly expanded: Readonly<Record<string, true>>;
  toggle(key: string): void;
  toggleExpanded(key: string): void;
}

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
    }),
    { name: "gitdove.sidebar-folders" },
  ),
);

const folderKey = (repo: RepoId, prefix: string) => `${repo}\n${prefix}`;

export function Sidebar({ repo }: { repo: RepoId }) {
  const { data } = useRefs(repo);
  const { data: info } = useRepoInfo(repo);
  const vis = useVisibility(repo);
  const providers = useAvatarProviders(repo);
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<SidebarTarget | null>(null);
  const collapsed = useFolderStore((s) => s.collapsed);
  const toggleFolder = useFolderStore((s) => s.toggle);
  const expanded = useFolderStore((s) => s.expanded);
  const toggleExpanded = useFolderStore((s) => s.toggleExpanded);

  const f = filter.trim().toLowerCase();
  const match = (s: string) => !f || s.toLowerCase().includes(f);

  const { locals, remotes, tags } = useMemo(() => {
    const refs = data?.refs ?? [];
    const byRemote = new Map<string, Ref[]>();
    for (const r of data?.remotes ?? []) byRemote.set(r.name, []);
    for (const r of refs) {
      if (r.kind !== "remote" || r.short.endsWith("/HEAD")) continue;
      const list = byRemote.get(r.remote ?? "") ?? [];
      list.push(r);
      byRemote.set(r.remote ?? "", list);
    }
    const trees = new Map<string, { refs: Ref[]; tree: TreeNode<Ref>[] }>();
    for (const [name, list] of byRemote) {
      const tree = buildTree(list, (r) => r.short.slice(name.length + 1), `refs/remotes/${name}/`);
      trees.set(name, { refs: list, tree });
    }
    const branches = refs.filter((r) => r.kind === "branch");
    return {
      locals: { refs: branches, tree: buildTree(branches, (r) => r.short, "refs/heads/") },
      remotes: trees,
      tags: refs.filter((r) => r.kind === "tag").toReversed(),
    };
  }, [data]);

  const stashes = data?.stashes ?? [];
  const worktrees = data?.worktrees ?? [];
  const submodules = data?.submodules ?? [];
  const remoteList = data?.remotes ?? [];
  const reveal = (hash: string) => commands.selectCommit(repo, hash);

  const refVisibility = (r: Ref): Visibility =>
    r.isHead
      ? "head"
      : vis.isFiltered(r.name)
        ? "filtered"
        : vis.isHidden(r.name)
          ? "hidden"
          : "visible";
  const contributors = vis.contributors;
  const count = (names: readonly string[], hidden = vis.isHidden) => {
    const shown = names.filter((n) => !hidden(n)).length;
    return shown === names.length ? (
      <span>{names.length}</span>
    ) : (
      <span className="font-medium text-sky-500">
        {shown}/{names.length}
      </span>
    );
  };
  const all = vis.all;
  const visibleTotal = all.filter((n) => !vis.isHidden(n)).length;
  const groupVisibility = (names: readonly string[]): Visibility => {
    if (names.length > 0 && names.every(vis.isFiltered)) return "filtered";
    const hiddenCount = names.filter((n) => vis.isHidden(n)).length;
    if (names.length === 0 || hiddenCount === 0) return "visible";
    return hiddenCount === names.length ? "hidden" : "partial";
  };

  /**
   * Renders a branch tree. Folders hide by prefix when `byPrefix` is set, else
   * branch by branch (like the Local section, so new branches stay visible).
   */
  const tree = (
    nodes: readonly TreeNode<Ref>[],
    depth: number,
    byPrefix: boolean,
    leaf: (r: Ref, label: string, depth: number) => ReactNode,
  ): ReactNode[] =>
    nodes.flatMap((n) => {
      if (n.kind === "leaf") return match(n.item.short) ? [leaf(n.item, n.name, depth)] : [];
      if (f && !n.items.some((r) => match(r.short))) return [];
      // The checked-out branch is always shown, so it does not count towards a folder's state.
      const names = n.items.filter((r) => !r.isHead).map((r) => r.name);
      const key = folderKey(repo, n.prefix);
      const open = !!f || !collapsed[key];
      const prefix = byPrefix ? n.prefix : undefined;
      // A collapsed folder stands in for the checked-out branch inside it.
      const hidesHead = !open && n.items.some((r) => r.isHead);
      return [
        <Item
          key={n.prefix}
          depth={depth}
          icon={open ? <IconFolderOpen /> : <IconFolder />}
          label={n.name}
          title={n.prefix.replace(/^refs\/(heads|remotes)\//, "")}
          active={hidesHead}
          visibility={groupVisibility(names)}
          trailing={
            !open && (
              <>
                {hidesHead && (
                  <span
                    className="flex shrink-0 text-primary"
                    title="Contains the checked-out branch"
                  >
                    <IconSquareCheckFilled aria-hidden />
                    <span className="sr-only">Contains the checked-out branch</span>
                  </span>
                )}
                <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">
                  {n.items.length}
                </span>
              </>
            )
          }
          onToggle={() => vis.toggleGroup(names, prefix)}
          onClick={() => !f && toggleFolder(key)}
          onContextMenu={() =>
            setMenu({
              kind: "folder",
              name: n.name,
              names,
              members: n.items.map((r) => r.name),
              prefix,
            })
          }
        />,
        ...(open ? tree(n.children, depth + 1, byPrefix, leaf) : []),
      ];
    });

  const sectionMenu = (section: SectionTarget["section"]): void =>
    setMenu({
      kind: "section",
      section,
      sections: sections.map(({ id, title }) => ({ id, title })),
    });

  const sections: SectionDef[] = [
    {
      id: "local",
      title: "Local",
      icon: <IconDeviceLaptop />,
      count: count(locals.refs.map((r) => r.name)),
      onHeaderContextMenu: () => sectionMenu("local"),
      children: tree(locals.tree, 0, false, (r, label, depth) => (
        <RefItem
          key={r.name}
          depth={depth}
          refItem={r}
          label={label}
          title={r.short}
          icon={<IconGitBranch />}
          owner={vis.ownerOf(r.name)}
          providers={providers}
          visibility={refVisibility(r)}
          onToggle={() => vis.toggle(r.name)}
          onClick={() => reveal(r.hash)}
          onDoubleClick={() => void commands.checkoutRef(repo, r)}
          onContextMenu={() => setMenu({ kind: "branch", ref: r })}
        />
      )),
    },
    {
      id: "remote",
      title: "Remote",
      icon: <IconCloud />,
      count: count([...remotes.values()].flatMap((t) => t.refs.map((r) => r.name))),
      onHeaderContextMenu: () => sectionMenu("remote"),
      children: [...remotes].map(([name, { refs, tree: nodes }]) => {
        const remote = remoteList.find((r) => r.name === name);
        const names = refs.map((r) => r.name);
        // With a single remote its subtree adds nothing: list its branches flatly
        // (its own actions move to the section header menu).
        const flat = remotes.size === 1;
        return (
          <div key={name}>
            {!flat && (
              <Item
                icon={<RemoteIcon remote={remote} />}
                label={name}
                title={remote?.fetchUrl ?? name}
                visibility={groupVisibility(names)}
                onToggle={() => vis.toggleGroup(names, `refs/remotes/${name}/`)}
                onContextMenu={() => remote && setMenu({ kind: "remote", remote })}
              />
            )}
            {tree(nodes, flat ? 0 : 1, true, (r, label, depth) => (
              <RefItem
                key={r.name}
                depth={depth}
                refItem={r}
                label={label}
                title={r.short}
                icon={<IconGitBranch />}
                owner={vis.ownerOf(r.name)}
                providers={providers}
                visibility={refVisibility(r)}
                onToggle={() => vis.toggle(r.name)}
                onClick={() => reveal(r.hash)}
                onDoubleClick={() => void commands.checkoutRef(repo, r)}
                onContextMenu={() => setMenu({ kind: "remote-branch", ref: r })}
              />
            ))}
          </div>
        );
      }),
    },
    {
      id: "contributors",
      title: "Contributors",
      icon: <IconUsers />,
      count: count(
        contributors.map((c) => c.person),
        (person) =>
          contributors.some(
            (c) => c.person === person && vis.contributorVisibility(c) === "hidden",
          ),
      ),
      onHeaderContextMenu: () => sectionMenu("contributors"),
      children: contributors.flatMap((c) => {
        const emails = c.emails.filter((e) => match(e.email));
        if (!match(c.name) && emails.length === 0) return [];
        const multi = c.emails.length > 1;
        const key = folderKey(repo, `contributor:${c.person}`);
        // Searching by email shows the matching emails.
        const open = multi && (expanded[key] || (!!f && emails.length > 0 && !match(c.name)));
        return [
          <ContributorItem
            key={c.person}
            contributor={c}
            providers={providers}
            open={multi ? open : undefined}
            visibility={vis.contributorVisibility(c)}
            onToggle={() => vis.toggleContributor(c)}
            onClick={() => multi && toggleExpanded(key)}
            onContextMenu={() => setMenu({ kind: "contributor", contributor: c })}
          />,
          ...(open
            ? (f && !match(c.name) ? emails : c.emails).map((e) => (
                <Item
                  key={`${c.person}\n${e.email}`}
                  depth={1}
                  icon={<Avatar name={e.name} email={e.email} providers={providers} size={14} />}
                  label={e.email}
                  title={e.email}
                  visibility={vis.isEmailHidden(e.email) ? "hidden" : "visible"}
                  trailing={
                    <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">
                      {e.branches}
                    </span>
                  }
                  onToggle={() => vis.toggleEmail(c, e.email)}
                  onContextMenu={() =>
                    setMenu({ kind: "contributor", contributor: c, email: e.email })
                  }
                />
              ))
            : []),
        ];
      }),
    },
    {
      id: "worktrees",
      title: "Worktrees",
      icon: <IconFolders />,
      count: <span>{worktrees.length}</span>,
      defaultOpen: false,
      onHeaderContextMenu: () => sectionMenu("worktrees"),
      children: worktrees
        .filter((w) => match(w.path))
        .map((w) => (
          <WorktreeItem
            key={w.path}
            worktree={w}
            current={w.path === info?.workTree}
            onDoubleClick={() => {
              if (w.path !== info?.workTree) commands.openSibling(repo, w.path);
            }}
            onContextMenu={() => setMenu({ kind: "worktree", worktree: w })}
          />
        )),
    },
    {
      id: "stashes",
      title: "Stashes",
      icon: <IconArchive />,
      count: count(stashes.map((s) => stashKey(s.hash))),
      onHeaderContextMenu: () => sectionMenu("stashes"),
      children: stashes
        .filter((s) => match(s.message))
        .map((s) => (
          <StashItem
            key={s.hash}
            stash={s}
            visibility={vis.isHidden(stashKey(s.hash)) ? "hidden" : "visible"}
            onToggle={() => vis.toggle(stashKey(s.hash))}
            onClick={() => reveal(s.hash)}
            onDoubleClick={() => void commands.applyStash(repo, s.index)}
            onContextMenu={() => setMenu({ kind: "stash", stash: s })}
          />
        )),
    },
    {
      id: "tags",
      title: "Tags",
      icon: <IconTag />,
      count: count(tags.map((t) => t.name)),
      defaultOpen: false,
      onHeaderContextMenu: () => sectionMenu("tags"),
      children: tags
        .filter((r) => match(r.short))
        .slice(0, 1000)
        .map((r) => (
          <RefItem
            key={r.name}
            refItem={r}
            icon={<IconTag />}
            visibility={refVisibility(r)}
            onToggle={() => vis.toggle(r.name)}
            onClick={() => reveal(r.hash)}
            onDoubleClick={() => void commands.checkout(repo, r.short)}
            onContextMenu={() => setMenu({ kind: "tag", ref: r })}
          />
        )),
    },
    ...(submodules.length > 0
      ? [
          {
            id: "submodules",
            title: "Submodules",
            icon: <IconBox />,
            count: <span>{submodules.length}</span>,
            defaultOpen: false,
            onHeaderContextMenu: () => sectionMenu("submodules"),
            children: submodules
              .filter((s) => match(s.path))
              .map((s) => (
                <SubmoduleItem
                  key={s.path}
                  submodule={s}
                  onDoubleClick={() => commands.openSibling(repo, s.path)}
                  onContextMenu={() => setMenu({ kind: "submodule", submodule: s })}
                />
              )),
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
            <span className={cn("tabular-nums", vis.anyHidden && "font-medium text-sky-500")}>
              {visibleTotal}/{all.length}
            </span>
          </span>
          {vis.anyHidden && (
            <button type="button" className="text-sky-500 hover:underline" onClick={vis.showAll}>
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
            className="h-7 rounded-lg pl-7 text-xs"
          />
        </div>
      </div>
      <ContextMenu>
        <ContextMenuTrigger render={<div className="flex min-h-0 flex-1 flex-col border-t" />}>
          <SectionStack sections={sections} />
        </ContextMenuTrigger>
        <SidebarMenu repo={repo} target={menu} vis={vis} />
      </ContextMenu>
    </div>
  );
}

function RemoteIcon({ remote }: { remote: Remote | undefined }) {
  const url = remote?.fetchUrl ?? "";
  if (url.includes("github")) return <IconBrandGithub />;
  if (url.includes("gitlab")) return <IconBrandGitlab />;
  if (url.includes("bitbucket")) return <IconBrandBitbucket />;
  return <IconCloud />;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

interface ItemProps {
  readonly icon: ReactNode;
  readonly label: string;
  readonly depth?: number;
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
  icon,
  label,
  depth = 0,
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
      className={cn(
        "group hover:bg-sidebar-accent flex h-6 cursor-default items-center gap-1.5 pr-2 pl-1 text-[12px] select-none [&_svg]:size-3.5 [&_svg]:shrink-0",
        active && "bg-primary/20 hover:bg-primary/25 font-semibold",
      )}
      title={title ?? label}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <VisibilityToggle visibility={visibility} filteredBy={filteredBy} onToggle={onToggle} />
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
  visibility,
  filteredBy = "its owner",
  onToggle,
}: {
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
  return (
    <button
      type="button"
      title={visibility === "hidden" ? "Show in graph" : "Hide from graph"}
      className={cn(
        "text-muted-foreground hover:text-foreground flex w-5 shrink-0 justify-center",
        !off && "opacity-0 group-hover:opacity-100",
      )}
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
  label,
  owner,
  providers = [],
  ...rest
}: Omit<ItemProps, "label" | "active" | "trailing"> & {
  refItem: Ref;
  label?: string;
  /** Who works on the branch. */
  owner?: Contributor;
  providers?: readonly AvatarProvider[];
}) {
  const track = r.upstreamGone
    ? "gone"
    : [r.ahead ? r.ahead + "↑" : "", r.behind ? r.behind + "↓" : ""].join(" ").trim();
  return (
    <Item
      {...rest}
      filteredBy={owner?.name}
      label={label ?? r.short}
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
}: Omit<ItemProps, "label" | "icon" | "trailing"> & {
  contributor: Contributor;
  providers: readonly AvatarProvider[];
  /** Whether the emails are listed, for a contributor with several. */
  open: boolean | undefined;
}) {
  const dim = rest.visibility === "hidden";
  return (
    <Item
      {...rest}
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
