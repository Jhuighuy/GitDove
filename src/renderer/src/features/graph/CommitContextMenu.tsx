import type { GraphRow, Ref, RepoId, Stash } from "@shared/domain";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { shortHash } from "@/lib/format";
import { useRepoInfo } from "@/lib/queries";
import { commands } from "../commands";
import { api } from "@/lib/api";
import { runAction } from "@/lib/actions";

export type MenuTarget =
  | { readonly kind: "wip" }
  | {
      readonly kind: "commit";
      readonly row: GraphRow;
      readonly refs: readonly Ref[];
      readonly stashIndex: number | null;
    };

export function CommitContextMenu({
  repo,
  target,
  stashes,
}: {
  repo: RepoId;
  target: MenuTarget | null;
  stashes: readonly Stash[];
}) {
  const { data: info } = useRepoInfo(repo);
  if (!target) return <ContextMenuContent className="hidden" />;

  if (target.kind === "wip") {
    return (
      <ContextMenuContent className="min-w-56">
        <ContextMenuItem
          onClick={() => void runAction(repo, "Stage all", () => api("repo.stageAll", repo))}
        >
          Stage all changes
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void commands.stash(repo)}>
          Stash all changes
        </ContextMenuItem>
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
        <ContextMenuItem onClick={() => void commands.applyStash(repo, stash.index)}>
          Apply stash
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void commands.pop(repo, stash.index)}>
          Pop stash
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          onClick={() => void commands.dropStash(repo, stash.index)}
        >
          Delete stash
        </ContextMenuItem>
      </ContextMenuContent>
    );
  }

  return (
    <ContextMenuContent className="min-w-64">
      {branchRefs.map((ref) => (
        <ContextMenuSub key={ref.name}>
          <ContextMenuSubTrigger>{ref.short}</ContextMenuSubTrigger>
          <ContextMenuSubContent className="min-w-56">
            {!ref.isHead && (
              <ContextMenuItem onClick={() => void commands.checkoutRef(repo, ref)}>
                Checkout {ref.short}
              </ContextMenuItem>
            )}
            {!ref.isHead && (
              <ContextMenuItem onClick={() => void commands.merge(repo, ref.short)}>
                Merge {ref.short} into {headName}
              </ContextMenuItem>
            )}
            {!ref.isHead && (
              <ContextMenuItem onClick={() => void commands.rebase(repo, ref.short)}>
                Rebase {headName} onto {ref.short}
              </ContextMenuItem>
            )}
            {ref.kind === "branch" && (
              <ContextMenuItem onClick={() => void commands.renameBranch(repo, ref.short)}>
                Rename {ref.short}…
              </ContextMenuItem>
            )}
            <ContextMenuItem onClick={() => commands.copy(ref.short, "Branch name copied")}>
              Copy branch name
            </ContextMenuItem>
            {!ref.isHead && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem
                  variant="destructive"
                  onClick={() => void commands.deleteBranch(repo, ref)}
                >
                  Delete {ref.short}
                </ContextMenuItem>
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
            <ContextMenuItem
              variant="destructive"
              onClick={() => void commands.deleteTag(repo, tag.short)}
            >
              Delete tag {tag.short}
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
      ))}
      {(branchRefs.length > 0 || tags.length > 0) && <ContextMenuSeparator />}
      <ContextMenuItem onClick={() => void commands.checkout(repo, hash)}>
        Checkout this commit (detached)
      </ContextMenuItem>
      <ContextMenuItem onClick={() => void commands.createBranch(repo, hash, shortHash(hash))}>
        Create branch here…
      </ContextMenuItem>
      <ContextMenuItem onClick={() => void commands.createTag(repo, hash)}>
        Create tag here…
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => void commands.cherryPick(repo, hash)}>
        Cherry-pick commit
      </ContextMenuItem>
      <ContextMenuItem onClick={() => void commands.revert(repo, hash)}>
        Revert commit
      </ContextMenuItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger>Reset {headName} to this commit</ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuItem onClick={() => void commands.reset(repo, hash, "soft")}>
            Soft — keep all changes staged
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void commands.reset(repo, hash, "mixed")}>
            Mixed — keep working copy, reset index
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            onClick={() => void commands.reset(repo, hash, "hard")}
          >
            Hard — discard all changes
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => commands.copy(hash, "Commit SHA copied")}>
        Copy commit SHA
      </ContextMenuItem>
      <ContextMenuItem onClick={() => commands.copy(row.subject, "Message copied")}>
        Copy commit message
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
