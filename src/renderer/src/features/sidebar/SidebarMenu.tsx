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
import { WriteMenuItem } from "@/components/busy";
import { commands } from "../commands";
import type { Contributor, useVisibility } from "./visibility";

export type SidebarTarget =
  | { readonly kind: "branch"; readonly ref: Ref }
  | { readonly kind: "remote-branch"; readonly ref: Ref }
  | { readonly kind: "remote"; readonly remote: Remote }
  | {
      readonly kind: "folder";
      readonly name: string;
      /** Full names of the folder's branches (without the checked-out one, which is always shown). */
      readonly names: readonly string[];
      /** Full names of all the folder's branches. */
      readonly members: readonly string[];
      /** Prefix to hide the folder by, if it hides as a group. */
      readonly prefix: string | undefined;
    }
  | { readonly kind: "tag"; readonly ref: Ref }
  | { readonly kind: "stash"; readonly stash: Stash }
  | { readonly kind: "worktree"; readonly worktree: Worktree }
  | { readonly kind: "submodule"; readonly submodule: Submodule }
  | { readonly kind: "contributor"; readonly contributor: Contributor }
  | {
      readonly kind: "section";
      readonly section: "local" | "remote" | "tags" | "worktrees" | "contributors";
    };

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
        <WriteMenuItem repo={repo} onClick={() => void commands.reset(repo, hash, "soft")}>
          Soft — keep all changes staged
        </WriteMenuItem>
        <WriteMenuItem repo={repo} onClick={() => void commands.reset(repo, hash, "mixed")}>
          Mixed — keep working copy, reset index
        </WriteMenuItem>
        <WriteMenuItem
          repo={repo}
          variant="destructive"
          onClick={() => void commands.reset(repo, hash, "hard")}
        >
          Hard — discard all changes
        </WriteMenuItem>
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
  const members = (refs?.refs ?? [])
    .filter((x) => x.name.startsWith(prefix) && !x.short.endsWith("/HEAD"))
    .map((x) => x.name);
  const allHidden = members.length > 0 && members.every((m) => vis.isHidden(m));
  return (
    <Menu>
      <WriteMenuItem repo={repo} onClick={() => void commands.fetchRemote(repo, r.name)}>
        Fetch {r.name}
      </WriteMenuItem>
      <Sep />
      <WriteMenuItem
        repo={repo}
        onClick={() => void commands.editRemoteUrl(repo, r.name, r.fetchUrl)}
      >
        Edit URL…
      </WriteMenuItem>
      <Item onClick={() => commands.copy(r.fetchUrl, "Remote URL copied")}>Copy URL</Item>
      <Sep />
      <Item onClick={() => vis.toggleGroup(members, prefix)}>
        {allHidden ? `Show ${r.name} branches` : `Hide ${r.name} branches`}
      </Item>
      <Sep />
      <WriteMenuItem
        repo={repo}
        variant="destructive"
        onClick={() => void commands.removeRemote(repo, r.name)}
      >
        Remove {r.name}
      </WriteMenuItem>
    </Menu>
  );
}

/** Contributor filter entries; `who` is the contributor the menu is for, if any. */
function ContributorItems({
  who,
  vis,
}: {
  readonly who?: Contributor;
  readonly vis: Props["vis"];
}) {
  const me = vis.contributors.find((c) => c.isMe);
  const anyHidden = vis.contributors.some((c) => vis.isAuthorHidden(c.email));
  return (
    <>
      {who && (
        <>
          <Item onClick={() => vis.toggleAuthor(who.email)}>
            {vis.isAuthorHidden(who.email)
              ? `Show ${who.name}'s branches`
              : `Hide ${who.name}'s branches`}
          </Item>
          <Item onClick={() => vis.soloAuthors([who.email])}>
            Show only {who.isMe ? "my" : `${who.name}'s`} branches
          </Item>
        </>
      )}
      {me && me !== who && (
        <Item onClick={() => vis.soloAuthors([me.email])}>Show only my branches</Item>
      )}
      {anyHidden && <Item onClick={vis.showAllAuthors}>Show all contributors</Item>}
    </>
  );
}

function FolderMenu({
  target: { name, names, members, prefix },
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
      <Item onClick={() => vis.solo(members)}>Solo {name} (hide everything else)</Item>
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
          <WriteMenuItem
            repo={repo}
            disabled={!r.isHead && !r.upstream}
            onClick={() => void commands.pullBranch(repo, r)}
          >
            Pull (fast-forward if possible)
          </WriteMenuItem>
          <WriteMenuItem repo={repo} onClick={() => void commands.pushBranch(repo, r)}>
            Push
          </WriteMenuItem>
          <WriteMenuItem repo={repo} onClick={() => void commands.setUpstream(repo, r)}>
            Set upstream…
          </WriteMenuItem>
          {!r.isHead && (
            <>
              <Sep />
              <WriteMenuItem repo={repo} onClick={() => void commands.merge(repo, r.short)}>
                Merge {r.short} into {head}
              </WriteMenuItem>
              <WriteMenuItem repo={repo} onClick={() => void commands.rebase(repo, r.short)}>
                Rebase {head} onto {r.short}
              </WriteMenuItem>
              <Sep />
              <WriteMenuItem repo={repo} onClick={() => void commands.checkoutRef(repo, r)}>
                Checkout {r.short}
              </WriteMenuItem>
            </>
          )}
          <Sep />
          <WriteMenuItem
            repo={repo}
            onClick={() => void commands.createWorktree(repo, r.short, r.short)}
          >
            Create worktree from {r.short}…
          </WriteMenuItem>
          <Sep />
          <WriteMenuItem
            repo={repo}
            onClick={() => void commands.createBranch(repo, r.hash, r.short)}
          >
            Create branch here…
          </WriteMenuItem>
          <WriteMenuItem repo={repo} onClick={() => void commands.createTag(repo, r.hash)}>
            Create tag here…
          </WriteMenuItem>
          {!r.isHead && <ResetItems repo={repo} hash={r.hash} head={head} />}
          <Sep />
          <WriteMenuItem repo={repo} onClick={() => void commands.renameBranch(repo, r.short)}>
            Rename {r.short}…
          </WriteMenuItem>
          {!r.isHead && (
            <WriteMenuItem
              repo={repo}
              variant="destructive"
              onClick={() => void commands.deleteBranch(repo, r)}
            >
              Delete {r.short}
            </WriteMenuItem>
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
          <WriteMenuItem repo={repo} onClick={() => void commands.checkoutRef(repo, r)}>
            Checkout {r.short}
          </WriteMenuItem>
          <WriteMenuItem repo={repo} onClick={() => void commands.merge(repo, r.short)}>
            Merge {r.short} into {head}
          </WriteMenuItem>
          <WriteMenuItem repo={repo} onClick={() => void commands.rebase(repo, r.short)}>
            Rebase {head} onto {r.short}
          </WriteMenuItem>
          <Sep />
          <WriteMenuItem
            repo={repo}
            onClick={() => void commands.createWorktree(repo, r.short, r.short)}
          >
            Create worktree from {r.short}…
          </WriteMenuItem>
          <WriteMenuItem
            repo={repo}
            onClick={() => void commands.createBranch(repo, r.hash, r.short)}
          >
            Create branch here…
          </WriteMenuItem>
          <WriteMenuItem repo={repo} onClick={() => void commands.createTag(repo, r.hash)}>
            Create tag here…
          </WriteMenuItem>
          <ResetItems repo={repo} hash={r.hash} head={head} />
          <Sep />
          <WriteMenuItem
            repo={repo}
            variant="destructive"
            onClick={() => void commands.deleteBranch(repo, r)}
          >
            Delete {r.short} on remote
          </WriteMenuItem>
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
          <WriteMenuItem repo={repo} onClick={() => void commands.checkout(repo, r.short)}>
            Checkout {r.short} (detached)
          </WriteMenuItem>
          <WriteMenuItem
            repo={repo}
            onClick={() => void commands.createBranch(repo, r.hash, r.short)}
          >
            Create branch here…
          </WriteMenuItem>
          <Sep />
          <WriteMenuItem repo={repo} onClick={() => void commands.pushTag(repo, r.short)}>
            Push {r.short} to remote
          </WriteMenuItem>
          <Sep />
          <WriteMenuItem
            repo={repo}
            variant="destructive"
            onClick={() => void commands.deleteTag(repo, r.short)}
          >
            Delete {r.short} locally
          </WriteMenuItem>
          <WriteMenuItem
            repo={repo}
            variant="destructive"
            onClick={() => void commands.deleteRemoteTag(repo, r.short)}
          >
            Delete {r.short} on remote
          </WriteMenuItem>
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
          <WriteMenuItem repo={repo} onClick={() => void commands.applyStash(repo, s.index)}>
            Apply stash
          </WriteMenuItem>
          <WriteMenuItem repo={repo} onClick={() => void commands.pop(repo, s.index)}>
            Pop stash
          </WriteMenuItem>
          <WriteMenuItem
            repo={repo}
            onClick={() => void commands.createBranch(repo, s.hash, s.name)}
          >
            Create branch here…
          </WriteMenuItem>
          <Sep />
          <WriteMenuItem
            repo={repo}
            variant="destructive"
            onClick={() => void commands.dropStash(repo, s.index)}
          >
            Delete stash
          </WriteMenuItem>
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
              <WriteMenuItem
                repo={repo}
                variant="destructive"
                onClick={() => void commands.removeWorktree(repo, w.path)}
              >
                Remove worktree
              </WriteMenuItem>
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
          <WriteMenuItem repo={repo} onClick={() => void commands.updateSubmodule(repo, s.path)}>
            {s.status === "uninitialized" ? "Initialize and update" : "Update"}
          </WriteMenuItem>
          <Item onClick={() => commands.copy(s.path, "Path copied")}>Copy path</Item>
        </Menu>
      );
    }

    case "contributor": {
      const c = target.contributor;
      return (
        <Menu>
          <ContributorItems who={c} vis={vis} />
          <Sep />
          <Item onClick={() => commands.copy(c.email, "Email copied")}>Copy email</Item>
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
              <WriteMenuItem
                repo={repo}
                onClick={() => void commands.createBranch(repo, "HEAD", head)}
              >
                Create branch…
              </WriteMenuItem>
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
                  <WriteMenuItem
                    repo={repo}
                    onClick={() => void commands.fetchRemote(repo, only.name)}
                  >
                    Fetch {only.name}
                  </WriteMenuItem>
                  <WriteMenuItem
                    repo={repo}
                    onClick={() => void commands.editRemoteUrl(repo, only.name, only.fetchUrl)}
                  >
                    Edit {only.name} URL…
                  </WriteMenuItem>
                  <Item onClick={() => commands.copy(only.fetchUrl, "Remote URL copied")}>
                    Copy {only.name} URL
                  </Item>
                  <Sep />
                  <WriteMenuItem repo={repo} onClick={() => void commands.addRemote(repo)}>
                    Add remote…
                  </WriteMenuItem>
                </>
              ) : (
                <>
                  <WriteMenuItem repo={repo} onClick={() => void commands.addRemote(repo)}>
                    Add remote…
                  </WriteMenuItem>
                  <WriteMenuItem repo={repo} onClick={() => void commands.fetch(repo)}>
                    Fetch all
                  </WriteMenuItem>
                </>
              )}
              <Sep />
              {groupItems("refs/remotes/")}
              {only && (
                <>
                  <Sep />
                  <WriteMenuItem
                    repo={repo}
                    variant="destructive"
                    onClick={() => void commands.removeRemote(repo, only.name)}
                  >
                    Remove {only.name}
                  </WriteMenuItem>
                </>
              )}
            </Menu>
          );
        }
        case "tags":
          return (
            <Menu>
              <WriteMenuItem repo={repo} onClick={() => void commands.createTag(repo, "HEAD")}>
                Create tag at HEAD…
              </WriteMenuItem>
              <Sep />
              {groupItems("refs/tags/")}
            </Menu>
          );
        case "contributors":
          return (
            <Menu>
              <ContributorItems vis={vis} />
              {vis.contributors.length === 0 && <Item disabled>No contributors</Item>}
            </Menu>
          );
        case "worktrees":
          return (
            <Menu>
              <WriteMenuItem
                repo={repo}
                onClick={() => void commands.createWorktree(repo, "HEAD", head)}
              >
                Create worktree…
              </WriteMenuItem>
              <WriteMenuItem repo={repo} onClick={() => void commands.pruneWorktrees(repo)}>
                Prune stale worktrees
              </WriteMenuItem>
            </Menu>
          );
      }
    }
  }
}
