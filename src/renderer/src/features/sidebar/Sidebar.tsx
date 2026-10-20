import type { Ref, RepoId, Stash, Submodule, Worktree } from "@shared/domain";
import {
  IconArchive,
  IconBox,
  IconChevronDown,
  IconCloud,
  IconDeviceLaptop,
  IconFolders,
  IconGitBranch,
  IconSearch,
  IconTag,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { useRefs, useRepoInfo } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { commands } from "../commands";

type MenuTarget = { kind: "ref"; ref: Ref } | { kind: "stash"; stash: Stash } | null;

export function Sidebar({ repo }: { repo: RepoId }) {
  const { data } = useRefs(repo);
  const { data: info } = useRepoInfo(repo);
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<MenuTarget>(null);

  const f = filter.trim().toLowerCase();
  const match = (s: string) => !f || s.toLowerCase().includes(f);

  const { locals, remotes, tags } = useMemo(() => {
    const refs = data?.refs ?? [];
    const byRemote = new Map<string, Ref[]>();
    for (const r of refs) {
      if (r.kind !== "remote" || r.short.endsWith("/HEAD")) continue;
      const list = byRemote.get(r.remote ?? "") ?? [];
      list.push(r);
      byRemote.set(r.remote ?? "", list);
    }
    return {
      locals: refs.filter((r) => r.kind === "branch"),
      remotes: byRemote,
      tags: refs.filter((r) => r.kind === "tag").toReversed(),
    };
  }, [data]);

  const reveal = (hash: string) => commands.selectCommit(repo, hash);
  const headName = info?.head.branch ?? "HEAD";

  return (
    <div className="bg-sidebar flex h-full min-h-0 flex-col">
      <div className="p-2">
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
        <ContextMenuTrigger render={<div className="min-h-0 flex-1 overflow-y-auto pb-4" />}>
          <Section title="Local" icon={<IconDeviceLaptop />} count={locals.length}>
            {locals
              .filter((r) => match(r.short))
              .map((r) => (
                <RefItem
                  key={r.name}
                  refItem={r}
                  icon={<IconGitBranch />}
                  onClick={() => reveal(r.hash)}
                  onDoubleClick={() => void commands.checkoutRef(repo, r)}
                  onContextMenu={() => setMenu({ kind: "ref", ref: r })}
                />
              ))}
          </Section>
          <Section title="Remote" icon={<IconCloud />} count={remotes.size}>
            {[...remotes].map(([remote, refs]) => (
              <Section key={remote} title={remote} nested count={refs.length}>
                {refs
                  .filter((r) => match(r.short))
                  .map((r) => (
                    <RefItem
                      key={r.name}
                      refItem={r}
                      label={r.short.slice(remote.length + 1)}
                      icon={<IconGitBranch />}
                      onClick={() => reveal(r.hash)}
                      onDoubleClick={() => void commands.checkoutRef(repo, r)}
                      onContextMenu={() => setMenu({ kind: "ref", ref: r })}
                    />
                  ))}
              </Section>
            ))}
          </Section>
          <Section title="Tags" icon={<IconTag />} count={tags.length} defaultOpen={false}>
            {tags
              .filter((r) => match(r.short))
              .slice(0, 500)
              .map((r) => (
                <RefItem
                  key={r.name}
                  refItem={r}
                  icon={<IconTag />}
                  onClick={() => reveal(r.hash)}
                  onContextMenu={() => setMenu({ kind: "ref", ref: r })}
                />
              ))}
          </Section>
          <Section title="Stashes" icon={<IconArchive />} count={data?.stashes.length ?? 0}>
            {data?.stashes
              .filter((s) => match(s.message))
              .map((s) => (
                <Item
                  key={s.hash}
                  icon={<IconArchive />}
                  label={s.message}
                  onClick={() => reveal(s.hash)}
                  onDoubleClick={() => void commands.applyStash(repo, s.index)}
                  onContextMenu={() => setMenu({ kind: "stash", stash: s })}
                />
              ))}
          </Section>
          {(data?.worktrees.length ?? 0) > 1 && (
            <Section
              title="Worktrees"
              icon={<IconFolders />}
              count={data!.worktrees.length}
              defaultOpen={false}
            >
              {data!.worktrees.map((w) => (
                <WorktreeItem key={w.path} worktree={w} />
              ))}
            </Section>
          )}
          {(data?.submodules.length ?? 0) > 0 && (
            <Section
              title="Submodules"
              icon={<IconBox />}
              count={data!.submodules.length}
              defaultOpen={false}
            >
              {data!.submodules.map((s) => (
                <SubmoduleItem key={s.path} submodule={s} />
              ))}
            </Section>
          )}
        </ContextMenuTrigger>
        <SidebarMenu repo={repo} target={menu} headName={headName} />
      </ContextMenu>
    </div>
  );
}

function SidebarMenu({
  repo,
  target,
  headName,
}: {
  repo: RepoId;
  target: MenuTarget;
  headName: string;
}) {
  if (!target) return <ContextMenuContent className="hidden" />;
  if (target.kind === "stash") {
    const s = target.stash;
    return (
      <ContextMenuContent className="min-w-52">
        <ContextMenuItem onClick={() => void commands.applyStash(repo, s.index)}>
          Apply stash
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void commands.pop(repo, s.index)}>
          Pop stash
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          onClick={() => void commands.dropStash(repo, s.index)}
        >
          Delete stash
        </ContextMenuItem>
      </ContextMenuContent>
    );
  }
  const r = target.ref;
  if (r.kind === "tag") {
    return (
      <ContextMenuContent className="min-w-52">
        <ContextMenuItem onClick={() => void commands.checkout(repo, r.short)}>
          Checkout {r.short}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => commands.copy(r.short, "Tag name copied")}>
          Copy tag name
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          onClick={() => void commands.deleteTag(repo, r.short)}
        >
          Delete {r.short}
        </ContextMenuItem>
      </ContextMenuContent>
    );
  }
  return (
    <ContextMenuContent className="min-w-60">
      {!r.isHead && (
        <ContextMenuItem onClick={() => void commands.checkoutRef(repo, r)}>
          Checkout {r.short}
        </ContextMenuItem>
      )}
      {r.isHead && (
        <ContextMenuItem onClick={() => void commands.pull(repo)}>
          Pull (fast-forward if possible)
        </ContextMenuItem>
      )}
      {r.isHead && <ContextMenuItem onClick={() => void commands.push(repo)}>Push</ContextMenuItem>}
      {!r.isHead && (
        <ContextMenuItem onClick={() => void commands.merge(repo, r.short)}>
          Merge {r.short} into {headName}
        </ContextMenuItem>
      )}
      {!r.isHead && (
        <ContextMenuItem onClick={() => void commands.rebase(repo, r.short)}>
          Rebase {headName} onto {r.short}
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={() => void commands.createBranch(repo, r.hash, r.short)}>
        Create branch here…
      </ContextMenuItem>
      {r.kind === "branch" && (
        <ContextMenuItem onClick={() => void commands.renameBranch(repo, r.short)}>
          Rename {r.short}…
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={() => commands.copy(r.short, "Branch name copied")}>
        Copy branch name
      </ContextMenuItem>
      {!r.isHead && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            onClick={() => void commands.deleteBranch(repo, r)}
          >
            Delete {r.short}
          </ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  );
}

function Section({
  title,
  icon,
  count,
  nested,
  defaultOpen = true,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  count: number;
  nested?: boolean;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <CollapsibleTrigger
        className={cn(
          "hover:bg-sidebar-accent text-muted-foreground flex h-7 w-full items-center gap-1.5 text-[11px] font-semibold select-none [&_svg]:size-3.5 [&[data-panel-open]>svg:first-child]:rotate-0",
          nested ? "pl-5 normal-case" : "px-2 tracking-wider uppercase",
        )}
      >
        <IconChevronDown className="-rotate-90 transition-transform" />
        {icon}
        <span className="truncate">{title}</span>
        <span className="ml-auto pr-2 font-normal tabular-nums">{count}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

function Item({
  icon,
  label,
  active,
  trailing,
  onClick,
  onDoubleClick,
  onContextMenu,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  trailing?: React.ReactNode;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: () => void;
}) {
  return (
    <div
      className={cn(
        "hover:bg-sidebar-accent flex h-6 cursor-default items-center gap-1.5 pr-2 pl-7 text-[12px] select-none [&_svg]:size-3.5 [&_svg]:shrink-0",
        active && "bg-primary/20 font-semibold",
      )}
      title={label}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <span className="text-muted-foreground flex">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </div>
  );
}

function RefItem({
  refItem: r,
  label,
  icon,
  onClick,
  onDoubleClick,
  onContextMenu,
}: {
  refItem: Ref;
  label?: string;
  icon: React.ReactNode;
  onClick: () => void;
  onDoubleClick?: () => void;
  onContextMenu: () => void;
}) {
  return (
    <Item
      icon={icon}
      label={label ?? r.short}
      active={r.isHead}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      trailing={
        (r.ahead > 0 || r.behind > 0 || r.upstreamGone) && (
          <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">
            {r.upstreamGone
              ? "gone"
              : `${r.ahead ? `${r.ahead}↑` : ""} ${r.behind ? `${r.behind}↓` : ""}`.trim()}
          </span>
        )
      }
    />
  );
}

function WorktreeItem({ worktree: w }: { worktree: Worktree }) {
  return (
    <Item
      icon={<IconFolders />}
      label={`${w.path.split("/").at(-1)}${w.branch ? ` (${w.branch})` : ""}`}
      active={w.isMain}
    />
  );
}

function SubmoduleItem({ submodule: s }: { submodule: Submodule }) {
  return (
    <Item
      icon={<IconBox />}
      label={s.path}
      trailing={
        s.status !== "ok" && <span className="text-muted-foreground text-[10px]">{s.status}</span>
      }
    />
  );
}
