import type { Ref, Remote, RepoId, Stash, Submodule, Worktree } from "@shared/domain";
import { repoLocationOf } from "@shared/domain";
import { stashKey } from "@shared/visibility";
import type { ReactNode } from "react";
import {
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { platform } from "@/lib/api";
import { useRefs, useRepoInfo } from "@/lib/queries";
import { WriteMenuItem } from "@/components/busy";
import { useSectionStack } from "./SectionStack";
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
  | {
      readonly kind: "contributor";
      readonly contributor: Contributor;
      /** One of their emails, for an email row. */
      readonly email?: string;
    }
  | {
      readonly kind: "section";
      readonly section:
        | "local"
        | "remote"
        | "contributors"
        | "worktrees"
        | "stashes"
        | "tags"
        | "submodules";
      /** The sidebar's sections, to show or hide. */
      readonly sections: readonly { readonly id: string; readonly title: string }[];
    };

interface Props {
  readonly repo: RepoId;
  readonly target: SidebarTarget;
  readonly vis: ReturnType<typeof useVisibility>;
}

/** What the platform's file manager calls showing a file. */
const REVEAL =
  platform === "darwin"
    ? "Reveal in Finder"
    : platform === "win32"
      ? "Show in Explorer"
      : "Show in file manager";

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
      {vis.isFiltered(name) ? (
        // Only showing its owner brings the branch back.
        <Item onClick={() => vis.showOwner(name)}>
          Show {vis.ownerOf(name)?.name ?? "its owner"}'s branches
        </Item>
      ) : (
        <>
          <Item onClick={() => (hidden ? vis.show([name]) : vis.hide([name]))}>
            {hidden ? "Show in graph" : "Hide from graph"}
          </Item>
          <Item onClick={() => vis.solo([name])}>Solo (hide everything else)</Item>
        </>
      )}
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
  const members = (refs?.refs ?? []).filter((x) => x.name.startsWith(prefix)).map((x) => x.name);
  // Branches the contributor filter hides keep their state.
  const active = members.filter((m) => !vis.isFiltered(m));
  const allHidden = active.length > 0 && active.every((m) => vis.isHiddenByEye(m));
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
      {active.length > 0 && (
        <Item onClick={() => vis.toggleGroup(members, prefix)}>
          {allHidden ? `Show ${r.name} branches` : `Hide ${r.name} branches`}
        </Item>
      )}
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
  const anyHidden = vis.contributors.some((c) => vis.contributorVisibility(c) !== "visible");
  return (
    <>
      {who && (
        <>
          <Item onClick={() => vis.toggleContributor(who)}>
            {vis.contributorVisibility(who) === "hidden"
              ? `Show ${who.name}'s branches`
              : `Hide ${who.name}'s branches`}
          </Item>
          <Item onClick={() => vis.soloContributors([who.person])}>
            Show only {who.isMe ? "my" : `${who.name}'s`} branches
          </Item>
        </>
      )}
      {me && me !== who && (
        <Item onClick={() => vis.soloContributors([me.person])}>Show only my branches</Item>
      )}
      {anyHidden && <Item onClick={vis.showAllContributors}>Show all contributors</Item>}
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
  // Branches the contributor filter hides keep their state.
  const active = names.filter((n) => !vis.isFiltered(n));
  const allHidden = active.length > 0 && active.every((n) => vis.isHiddenByEye(n));
  return (
    <Menu>
      {active.length > 0 && (
        <Item onClick={() => vis.toggleGroup(names, prefix)}>
          {allHidden ? `Show ${name} in graph` : `Hide ${name} from graph`}
        </Item>
      )}
      <Item onClick={() => vis.solo(members)}>Solo {name} (hide everything else)</Item>
      {vis.anyHidden && <Item onClick={vis.showAll}>Show all</Item>}
    </Menu>
  );
}

/**
 * The menu for a right-clicked sidebar item; rendered only while it is open. Git arguments
 * name refs in full: a branch, a remote branch and a tag can share a short name.
 */
export function SidebarMenu({ repo, target, vis }: Props) {
  const { data: info } = useRepoInfo(repo);
  const { data: refs } = useRefs(repo);
  const head = info?.head.branch ?? "HEAD";
  const isLocal = repoLocationOf(repo).kind === "local";

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
              <WriteMenuItem repo={repo} onClick={() => void commands.merge(repo, r.name)}>
                Merge {r.short} into {head}
              </WriteMenuItem>
              <WriteMenuItem repo={repo} onClick={() => void commands.rebase(repo, r.name)}>
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
          <WriteMenuItem repo={repo} onClick={() => void commands.merge(repo, r.name)}>
            Merge {r.short} into {head}
          </WriteMenuItem>
          <WriteMenuItem repo={repo} onClick={() => void commands.rebase(repo, r.name)}>
            Rebase {head} onto {r.short}
          </WriteMenuItem>
          <Sep />
          <WriteMenuItem
            repo={repo}
            onClick={() => void commands.createWorktree(repo, r.name, r.short)}
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
          <WriteMenuItem repo={repo} onClick={() => void commands.checkoutRef(repo, r)}>
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
          <WriteMenuItem repo={repo} onClick={() => void commands.applyStash(repo, s)}>
            Apply stash
          </WriteMenuItem>
          <WriteMenuItem repo={repo} onClick={() => void commands.pop(repo, s)}>
            Pop stash
          </WriteMenuItem>
          <WriteMenuItem repo={repo} onClick={() => void commands.stashBranch(repo, s)}>
            Create branch here…
          </WriteMenuItem>
          <Sep />
          <WriteMenuItem
            repo={repo}
            variant="destructive"
            onClick={() => void commands.dropStash(repo, s)}
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
          {isLocal && <Item onClick={() => commands.reveal(repo, w.path)}>{REVEAL}</Item>}
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
      const email = target.email ?? (c.emails.length === 1 ? c.emails[0]!.email : undefined);
      return (
        <Menu>
          {target.email && (
            <>
              <Item onClick={() => vis.toggleEmail(c, target.email!)}>
                {vis.isEmailHidden(target.email)
                  ? `Show ${target.email} branches`
                  : `Hide ${target.email} branches`}
              </Item>
              <Sep />
            </>
          )}
          <ContributorItems who={c} vis={vis} />
          {email && (
            <>
              <Sep />
              <Item onClick={() => commands.copy(email, "Email copied")}>Copy email</Item>
            </>
          )}
        </Menu>
      );
    }

    case "section": {
      const names = (prefix: string) =>
        (refs?.refs ?? []).filter((r) => r.name.startsWith(prefix) && !r.isHead).map((r) => r.name);
      const groupItems = (prefix: string) => {
        const members = names(prefix);
        return (
          <>
            <Item onClick={() => vis.showGroup(members, prefix)}>Show all</Item>
            <Item
              onClick={() =>
                // New local branches stay visible.
                prefix === "refs/heads/" ? vis.hideGroup(members) : vis.hideGroup(members, prefix)
              }
            >
              Hide all
            </Item>
          </>
        );
      };
      const actions = (): ReactNode => {
        switch (target.section) {
          case "local":
            return (
              <>
                <WriteMenuItem
                  repo={repo}
                  onClick={() => void commands.createBranch(repo, "HEAD", head)}
                >
                  Create branch…
                </WriteMenuItem>
                <Sep />
                {groupItems("refs/heads/")}
              </>
            );
          case "remote": {
            // A single remote is shown without its own row, so offer its actions here.
            const only = refs?.remotes.length === 1 ? refs.remotes[0] : undefined;
            return (
              <>
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
              </>
            );
          }
          case "tags":
            return (
              <>
                <WriteMenuItem repo={repo} onClick={() => void commands.createTag(repo, "HEAD")}>
                  Create tag at HEAD…
                </WriteMenuItem>
                <Sep />
                {groupItems("refs/tags/")}
              </>
            );
          case "contributors":
            return (
              <>
                <ContributorItems vis={vis} />
                {vis.contributors.length === 0 && <Item disabled>No contributors</Item>}
              </>
            );
          case "worktrees":
            return (
              <>
                <WriteMenuItem
                  repo={repo}
                  onClick={() => void commands.createWorktree(repo, "HEAD", head)}
                >
                  Create worktree…
                </WriteMenuItem>
                <WriteMenuItem repo={repo} onClick={() => void commands.pruneWorktrees(repo)}>
                  Prune stale worktrees
                </WriteMenuItem>
              </>
            );
          case "stashes":
          case "submodules":
            return null;
        }
      };
      const own = actions();
      return (
        <Menu>
          {own}
          {own && <Sep />}
          <SectionToggles sections={target.sections} />
        </Menu>
      );
    }
  }
}

/** Shows or hides each sidebar section; the last one shown stays. */
function SectionToggles({
  sections,
}: {
  readonly sections: readonly { id: string; title: string }[];
}) {
  const hidden = useSectionStack((s) => s.hidden);
  const setHidden = useSectionStack((s) => s.setHidden);
  const shown = sections.filter((s) => !hidden[s.id]);
  return sections.map((s) => (
    <ContextMenuCheckboxItem
      key={s.id}
      checked={!hidden[s.id]}
      disabled={shown.length === 1 && shown[0] === s}
      onCheckedChange={(checked) => setHidden(s.id, !checked)}
    >
      {s.title}
    </ContextMenuCheckboxItem>
  ));
}
