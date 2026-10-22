import type { GraphRow, Ref, RepoId, Stash } from "@shared/domain";
import { useQueryClient } from "@tanstack/react-query";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { shortHash } from "@/lib/format";
import { keys, useRepoInfo } from "@/lib/queries";
import { WriteMenuItem } from "@/components/busy";
import type { PickedCommit } from "@/stores/repo-ui";
import { commands } from "../commands";
import { useVisibility } from "../sidebar/visibility";
import { api } from "@/lib/api";

export type MenuTarget =
  | { readonly kind: "wip" }
  | { readonly kind: "commit"; readonly row: GraphRow; readonly refs: readonly Ref[] }
  /** A multi-selection, newest first. */
  | { readonly kind: "commits"; readonly commits: readonly PickedCommit[] };

/** The menu for a right-clicked graph row; rendered only while it is open. */
export function CommitContextMenu({
  repo,
  target,
  stashes,
}: {
  repo: RepoId;
  target: MenuTarget;
  stashes: readonly Stash[];
}) {
  const { data: info } = useRepoInfo(repo);
  const vis = useVisibility(repo);
  const client = useQueryClient();

  if (target.kind === "commits") {
    const hashes = target.commits.map((c) => c.row.hash);
    // Stashes are not commits to apply elsewhere.
    const commitsOnly = !hashes.some((h) => stashes.some((s) => s.hash === h));
    return (
      <ContextMenuContent className="min-w-56">
        {commitsOnly && (
          <>
            <WriteMenuItem repo={repo} onClick={() => void commands.cherryPick(repo, hashes)}>
              Cherry-pick {hashes.length} commits
            </WriteMenuItem>
            <WriteMenuItem repo={repo} onClick={() => void commands.revert(repo, hashes)}>
              Revert {hashes.length} commits
            </WriteMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem
          onClick={() => commands.copy(hashes.join("\n"), `${hashes.length} commit SHAs copied`)}
        >
          Copy {hashes.length} commit SHAs
        </ContextMenuItem>
      </ContextMenuContent>
    );
  }

  if (target.kind === "wip") {
    return (
      <ContextMenuContent className="min-w-56">
        <WriteMenuItem repo={repo} onClick={() => void commands.stageAll(repo)}>
          Stage all changes
        </WriteMenuItem>
        <WriteMenuItem repo={repo} onClick={() => void commands.stash(repo)}>
          Stash all changes
        </WriteMenuItem>
      </ContextMenuContent>
    );
  }

  const { row, refs } = target;
  const hash = row.hash;
  const stash = stashes.find((s) => s.hash === hash);
  const headName = info?.head.branch ?? "HEAD";
  const branchRefs = refs.filter((r) => r.kind === "branch" || r.kind === "remote");
  const tags = refs.filter((r) => r.kind === "tag");

  if (stash) {
    return (
      <ContextMenuContent className="min-w-56">
        <WriteMenuItem repo={repo} onClick={() => void commands.applyStash(repo, stash)}>
          Apply stash
        </WriteMenuItem>
        <WriteMenuItem repo={repo} onClick={() => void commands.pop(repo, stash)}>
          Pop stash
        </WriteMenuItem>
        <WriteMenuItem repo={repo} onClick={() => void commands.stashBranch(repo, stash)}>
          Create branch here…
        </WriteMenuItem>
        <ContextMenuSeparator />
        <WriteMenuItem
          repo={repo}
          variant="destructive"
          onClick={() => void commands.dropStash(repo, stash)}
        >
          Delete stash
        </WriteMenuItem>
      </ContextMenuContent>
    );
  }

  // Git arguments name refs in full: a branch and a tag can share a short name.
  return (
    <ContextMenuContent className="min-w-64">
      {branchRefs.map((ref) => (
        <ContextMenuSub key={ref.name}>
          <ContextMenuSubTrigger>{ref.short}</ContextMenuSubTrigger>
          <ContextMenuSubContent className="min-w-56">
            {!ref.isHead && (
              <WriteMenuItem repo={repo} onClick={() => void commands.checkoutRef(repo, ref)}>
                Checkout {ref.short}
              </WriteMenuItem>
            )}
            {!ref.isHead && (
              <WriteMenuItem repo={repo} onClick={() => void commands.merge(repo, ref.name)}>
                Merge {ref.short} into {headName}
              </WriteMenuItem>
            )}
            {!ref.isHead && (
              <WriteMenuItem repo={repo} onClick={() => void commands.rebase(repo, ref.name)}>
                Rebase {headName} onto {ref.short}
              </WriteMenuItem>
            )}
            {ref.kind === "branch" && (
              <WriteMenuItem
                repo={repo}
                onClick={() => void commands.renameBranch(repo, ref.short)}
              >
                Rename {ref.short}…
              </WriteMenuItem>
            )}
            <ContextMenuItem onClick={() => commands.copy(ref.short, "Branch name copied")}>
              Copy branch name
            </ContextMenuItem>
            {!ref.isHead && (
              <ContextMenuItem onClick={() => vis.hide([ref.name])}>
                Hide from graph
              </ContextMenuItem>
            )}
            {!ref.isHead && (
              <>
                <ContextMenuSeparator />
                <WriteMenuItem
                  repo={repo}
                  variant="destructive"
                  onClick={() => void commands.deleteBranch(repo, ref)}
                >
                  Delete {ref.short}
                </WriteMenuItem>
              </>
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>
      ))}
      {tags.map((tag) => (
        <ContextMenuSub key={tag.name}>
          <ContextMenuSubTrigger>Tag {tag.short}</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem onClick={() => commands.copy(tag.short, "Tag name copied")}>
              Copy tag name
            </ContextMenuItem>
            <ContextMenuItem onClick={() => vis.hide([tag.name])}>Hide from graph</ContextMenuItem>
            <WriteMenuItem
              repo={repo}
              variant="destructive"
              onClick={() => void commands.deleteTag(repo, tag.short)}
            >
              Delete tag {tag.short}
            </WriteMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
      ))}
      {(branchRefs.length > 0 || tags.length > 0) && <ContextMenuSeparator />}
      <WriteMenuItem repo={repo} onClick={() => void commands.checkout(repo, hash)}>
        Checkout this commit (detached)
      </WriteMenuItem>
      <WriteMenuItem
        repo={repo}
        onClick={() => void commands.createBranch(repo, hash, shortHash(hash))}
      >
        Create branch here…
      </WriteMenuItem>
      <WriteMenuItem repo={repo} onClick={() => void commands.createTag(repo, hash)}>
        Create tag here…
      </WriteMenuItem>
      <ContextMenuSeparator />
      <WriteMenuItem repo={repo} onClick={() => void commands.cherryPick(repo, [hash])}>
        Cherry-pick commit
      </WriteMenuItem>
      <WriteMenuItem repo={repo} onClick={() => void commands.revert(repo, [hash])}>
        Revert commit
      </WriteMenuItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger>Reset {headName} to this commit</ContextMenuSubTrigger>
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
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => commands.copy(hash, "Commit SHA copied")}>
        Copy commit SHA
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => {
          // The graph has the subject only: copy the whole message (the subject, without one).
          client
            .fetchQuery({
              queryKey: keys.commit(repo, hash),
              queryFn: () => api("repo.commitDetails", repo, hash),
            })
            .then(
              (d) => (!d ? row.subject : d.body ? `${d.subject}\n\n${d.body}` : d.subject),
              () => row.subject,
            )
            .then((message) => commands.copy(message, "Message copied"));
        }}
      >
        Copy commit message
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
