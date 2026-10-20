import type { Ref, Remote, RepoId, Stash, Submodule, Worktree } from "@shared/domain";
import { repoLocationOf } from "@shared/domain";
import { stashKey } from "@shared/visibility";
import type { ReactNode } from "react";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { useRefs, useRepoInfo } from "@/lib/queries";
import { commands } from "../commands";
import type { useVisibility } from "./visibility";

export type SidebarTarget =
  | { readonly kind: "branch"; readonly ref: Ref }
  | { readonly kind: "remote-branch"; readonly ref: Ref }
  | { readonly kind: "remote"; readonly remote: Remote }
  | {
      readonly kind: "folder";
      readonly name: string;
      /** Full names of the folder's branches (without the checked-out one). */
      readonly names: readonly string[];
      /** Prefix to hide the folder by, if it hides as a group. */
      readonly prefix: string | undefined;
    }
  | { readonly kind: "tag"; readonly ref: Ref }
  | { readonly kind: "stash"; readonly stash: Stash }
  | { readonly kind: "worktree"; readonly worktree: Worktree }
  | { readonly kind: "submodule"; readonly submodule: Submodule }
  | { readonly kind: "section"; readonly section: "local" | "remote" | "tags" | "worktrees" };

interface Props {
  readonly repo: RepoId;
  readonly target: SidebarTarget | null;
  readonly vis: ReturnType<typeof useVisibility>;
}

const Item = ContextMenuItem;
const Sep = ContextMenuSeparator;

function Menu({ children }: { children: ReactNode }) {
  return <ContextMenuContent className="min-w-60">{children}</ContextMenuContent>;
}

/** Hide/show and solo entries shared by every graph-visible item. */
function VisibilityItems({ name, vis }: { readonly name: string; readonly vis: Props["vis"] }) {
  const hidden = vis.isHidden(name);
  return (
    <>
      <Sep />
      <Item onClick={() => (hidden ? vis.show([name]) : vis.hide([name]))}>
        {hidden ? "Show in graph" : "Hide from graph"}
      </Item>
      <Item onClick={() => vis.solo([name])}>Solo (hide everything else)</Item>
      {vis.anyHidden && <Item onClick={vis.showAll}>Show all</Item>}
    </>
  );
}

function ResetItems({ repo, hash, head }: { repo: RepoId; hash: string; head: string }) {
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>Reset {head} to this commit</ContextMenuSubTrigger>
      <ContextMenuSubContent>
        <Item onClick={() => void commands.reset(repo, hash, "soft")}>
          Soft — keep all changes staged
        </Item>
        <Item onClick={() => void commands.reset(repo, hash, "mixed")}>
          Mixed — keep working copy, reset index
        </Item>
        <Item variant="destructive" onClick={() => void commands.reset(repo, hash, "hard")}>
          Hard — discard all changes
        </Item>
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

function RemoteMenu({
  repo,
  remote: r,
  vis,
}: {
  readonly repo: RepoId;
  readonly remote: Remote;
  readonly vis: Props["vis"];
}) {
  const { data: refs } = useRefs(repo);
  const prefix = `refs/remotes/${r.name}/`;
  const members = (refs?.refs ?? []).filter((x) => x.name.startsWith(prefix)).map((x) => x.name);
  const allHidden = members.length > 0 && members.every((m) => vis.isHidden(m));
  return (
    <Menu>
      <Item onClick={() => void commands.fetchRemote(repo, r.name)}>Fetch {r.name}</Item>
      <Sep />
      <Item onClick={() => void commands.editRemoteUrl(repo, r.name, r.fetchUrl)}>Edit URL…</Item>
      <Item onClick={() => commands.copy(r.fetchUrl, "Remote URL copied")}>Copy URL</Item>
      <Sep />
      <Item onClick={() => vis.toggleGroup(members, prefix)}>
        {allHidden ? `Show ${r.name} branches` : `Hide ${r.name} branches`}
      </Item>
      <Sep />
      <Item variant="destructive" onClick={() => void commands.removeRemote(repo, r.name)}>
        Remove {r.name}
      </Item>
    </Menu>
  );
}

function FolderMenu({
  target: { name, names, prefix },
  vis,
}: {
  readonly target: Extract<SidebarTarget, { kind: "folder" }>;
  readonly vis: Props["vis"];
}) {
  const allHidden = names.length > 0 && names.every((n) => vis.isHidden(n));
  return (
    <Menu>
      <Item onClick={() => vis.toggleGroup(names, prefix)}>
        {allHidden ? `Show ${name} in graph` : `Hide ${name} from graph`}
      </Item>
      <Item onClick={() => vis.solo(names)}>Solo {name} (hide everything else)</Item>
      {vis.anyHidden && <Item onClick={vis.showAll}>Show all</Item>}
    </Menu>
  );
}

export function SidebarMenu({ repo, target, vis }: Props) {
  const { data: info } = useRepoInfo(repo);
  const { data: refs } = useRefs(repo);
  const head = info?.head.branch ?? "HEAD";
  const isLocal = repoLocationOf(repo).kind === "local";

  if (!target) return <ContextMenuContent className="hidden" />;

  switch (target.kind) {
    case "branch": {
      const r = target.ref;
      return (
        <Menu>
          <Item
            disabled={!r.isHead && !r.upstream}
            onClick={() => void commands.pullBranch(repo, r)}
          >
            Pull (fast-forward if possible)
          </Item>
          <Item onClick={() => void commands.pushBranch(repo, r)}>Push</Item>
          <Item onClick={() => void commands.setUpstream(repo, r)}>Set upstream…</Item>
          {!r.isHead && (
            <>
              <Sep />
              <Item onClick={() => void commands.merge(repo, r.short)}>
                Merge {r.short} into {head}
              </Item>
              <Item onClick={() => void commands.rebase(repo, r.short)}>
                Rebase {head} onto {r.short}
              </Item>
              <Sep />
              <Item onClick={() => void commands.checkoutRef(repo, r)}>Checkout {r.short}</Item>
            </>
          )}
          <Sep />
          <Item onClick={() => void commands.createWorktree(repo, r.short, r.short)}>
            Create worktree from {r.short}…
          </Item>
          <Sep />
          <Item onClick={() => void commands.createBranch(repo, r.hash, r.short)}>
            Create branch here…
          </Item>
          <Item onClick={() => void commands.createTag(repo, r.hash)}>Create tag here…</Item>
          {!r.isHead && <ResetItems repo={repo} hash={r.hash} head={head} />}
          <Sep />
          <Item onClick={() => void commands.renameBranch(repo, r.short)}>Rename {r.short}…</Item>
          {!r.isHead && (
            <Item variant="destructive" onClick={() => void commands.deleteBranch(repo, r)}>
              Delete {r.short}
            </Item>
          )}
          <Sep />
          <Item onClick={() => commands.copy(r.short, "Branch name copied")}>Copy branch name</Item>
          <Item onClick={() => commands.copy(r.hash, "Commit SHA copied")}>Copy commit SHA</Item>
          {!r.isHead && <VisibilityItems name={r.name} vis={vis} />}
        </Menu>
      );
    }

    case "remote-branch": {
      const r = target.ref;
      return (
        <Menu>
          <Item onClick={() => void commands.checkoutRef(repo, r)}>Checkout {r.short}</Item>
          <Item onClick={() => void commands.merge(repo, r.short)}>
            Merge {r.short} into {head}
          </Item>
          <Item onClick={() => void commands.rebase(repo, r.short)}>
            Rebase {head} onto {r.short}
          </Item>
          <Sep />
          <Item onClick={() => void commands.createWorktree(repo, r.short, r.short)}>
            Create worktree from {r.short}…
          </Item>
          <Item onClick={() => void commands.createBranch(repo, r.hash, r.short)}>
            Create branch here…
          </Item>
          <Item onClick={() => void commands.createTag(repo, r.hash)}>Create tag here…</Item>
          <ResetItems repo={repo} hash={r.hash} head={head} />
          <Sep />
          <Item variant="destructive" onClick={() => void commands.deleteBranch(repo, r)}>
            Delete {r.short} on remote
          </Item>
          <Sep />
          <Item onClick={() => commands.copy(r.short, "Branch name copied")}>Copy branch name</Item>
          <Item onClick={() => commands.copy(r.hash, "Commit SHA copied")}>Copy commit SHA</Item>
          <VisibilityItems name={r.name} vis={vis} />
        </Menu>
      );
    }

    case "remote":
      return <RemoteMenu repo={repo} remote={target.remote} vis={vis} />;

    case "folder":
      return <FolderMenu target={target} vis={vis} />;

    case "tag": {
      const r = target.ref;
      return (
        <Menu>
          <Item onClick={() => void commands.checkout(repo, r.short)}>
            Checkout {r.short} (detached)
          </Item>
          <Item onClick={() => void commands.createBranch(repo, r.hash, r.short)}>
            Create branch here…
          </Item>
          <Sep />
          <Item onClick={() => void commands.pushTag(repo, r.short)}>Push {r.short} to remote</Item>
          <Sep />
          <Item variant="destructive" onClick={() => void commands.deleteTag(repo, r.short)}>
            Delete {r.short} locally
          </Item>
          <Item variant="destructive" onClick={() => void commands.deleteRemoteTag(repo, r.short)}>
            Delete {r.short} on remote
          </Item>
          <Sep />
          <Item onClick={() => commands.copy(r.short, "Tag name copied")}>Copy tag name</Item>
          <Item onClick={() => commands.copy(r.hash, "Commit SHA copied")}>Copy commit SHA</Item>
          <VisibilityItems name={r.name} vis={vis} />
        </Menu>
      );
    }

    case "stash": {
      const s = target.stash;
      return (
        <Menu>
          <Item onClick={() => void commands.applyStash(repo, s.index)}>Apply stash</Item>
          <Item onClick={() => void commands.pop(repo, s.index)}>Pop stash</Item>
          <Item onClick={() => void commands.createBranch(repo, s.hash, s.name)}>
            Create branch here…
          </Item>
          <Sep />
          <Item variant="destructive" onClick={() => void commands.dropStash(repo, s.index)}>
            Delete stash
          </Item>
          <VisibilityItems name={stashKey(s.hash)} vis={vis} />
        </Menu>
      );
    }

    case "worktree": {
      const w = target.worktree;
      const current = w.path === info?.workTree;
      return (
        <Menu>
          <Item disabled={current} onClick={() => commands.openSibling(repo, w.path)}>
            Open in new tab
          </Item>
          {isLocal && <Item onClick={() => commands.reveal(repo, w.path)}>Reveal in Finder</Item>}
          <Item onClick={() => commands.copy(w.path, "Path copied")}>Copy path</Item>
          {!w.isMain && !current && (
            <>
              <Sep />
              <Item
                variant="destructive"
                onClick={() => void commands.removeWorktree(repo, w.path)}
              >
                Remove worktree
              </Item>
            </>
          )}
        </Menu>
      );
    }

    case "submodule": {
      const s = target.submodule;
      return (
        <Menu>
          <Item onClick={() => commands.openSibling(repo, s.path)}>Open in new tab</Item>
          <Item onClick={() => void commands.updateSubmodule(repo, s.path)}>
            {s.status === "uninitialized" ? "Initialize and update" : "Update"}
          </Item>
          <Item onClick={() => commands.copy(s.path, "Path copied")}>Copy path</Item>
        </Menu>
      );
    }

    case "section": {
      const names = (prefix: string) =>
        (refs?.refs ?? [])
          .filter((r) => r.name.startsWith(prefix) && !r.isHead && !r.short.endsWith("/HEAD"))
          .map((r) => r.name);
      const groupItems = (prefix: string) => {
        const members = names(prefix);
        return (
          <>
            <Item onClick={() => vis.show([prefix, ...members])}>Show all</Item>
            <Item
              onClick={() => (prefix === "refs/heads/" ? vis.hide(members) : vis.hide([prefix]))}
            >
              Hide all
            </Item>
          </>
        );
      };
      switch (target.section) {
        case "local":
          return (
            <Menu>
              <Item onClick={() => void commands.createBranch(repo, "HEAD", head)}>
                Create branch…
              </Item>
              <Sep />
              {groupItems("refs/heads/")}
            </Menu>
          );
        case "remote": {
          // A single remote is shown without its own row, so offer its actions here.
          const only = refs?.remotes.length === 1 ? refs.remotes[0] : undefined;
          return (
            <Menu>
              {only ? (
                <>
                  <Item onClick={() => void commands.fetchRemote(repo, only.name)}>
                    Fetch {only.name}
                  </Item>
                  <Item onClick={() => void commands.editRemoteUrl(repo, only.name, only.fetchUrl)}>
                    Edit {only.name} URL…
                  </Item>
                  <Item onClick={() => commands.copy(only.fetchUrl, "Remote URL copied")}>
                    Copy {only.name} URL
                  </Item>
                  <Sep />
                  <Item onClick={() => void commands.addRemote(repo)}>Add remote…</Item>
                </>
              ) : (
                <>
                  <Item onClick={() => void commands.addRemote(repo)}>Add remote…</Item>
                  <Item onClick={() => void commands.fetch(repo)}>Fetch all</Item>
                </>
              )}
              <Sep />
              {groupItems("refs/remotes/")}
              {only && (
                <>
                  <Sep />
                  <Item
                    variant="destructive"
                    onClick={() => void commands.removeRemote(repo, only.name)}
                  >
                    Remove {only.name}
                  </Item>
                </>
              )}
            </Menu>
          );
        }
        case "tags":
          return (
            <Menu>
              <Item onClick={() => void commands.createTag(repo, "HEAD")}>Create tag at HEAD…</Item>
              <Sep />
              {groupItems("refs/tags/")}
            </Menu>
          );
        case "worktrees":
          return (
            <Menu>
              <Item onClick={() => void commands.createWorktree(repo, "HEAD", head)}>
                Create worktree…
              </Item>
              <Item onClick={() => void commands.pruneWorktrees(repo)}>Prune stale worktrees</Item>
            </Menu>
          );
      }
    }
  }
}
