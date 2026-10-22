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
import { useEditableHistory, useRepoInfo } from "@/lib/queries";
import { WriteMenuItem } from "@/components/busy";
import { commands } from "../commands";
import { historyCommands } from "../history/commands";
import { contiguous, editable } from "../history/plan";
import { useVisibility } from "../sidebar/visibility";
import { api } from "@/lib/api";
import { runAction } from "@/lib/actions";

export type MenuTarget =
  | { readonly kind: "wip" }
  | {
      readonly kind: "commit";
      readonly row: GraphRow;
      readonly refs: readonly Ref[];
      readonly stashIndex: number | null;
    }
  /** Several selected commits, newest first. */
  | { readonly kind: "commits"; readonly rows: readonly GraphRow[] };

const refOf = (row: GraphRow) => ({ hash: row.hash, subject: row.subject });

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
  const { data: history } = useEditableHistory(repo);
  const vis = useVisibility(repo);
  if (!target) return <ContextMenuContent className="hidden" />;

  if (target.kind === "wip") {
    return (
      <ContextMenuContent className="min-w-56">
        <WriteMenuItem
          repo={repo}
          onClick={() => void runAction(repo, "Stage all", () => api("repo.stageAll", repo))}
        >
          Stage all changes
        </WriteMenuItem>
        <WriteMenuItem repo={repo} onClick={() => void commands.stash(repo)}>
          Stash all changes
        </WriteMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => void historyCommands.workingPatch(repo, "file")}>
          Save changes as patch…
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void historyCommands.workingPatch(repo, "clipboard")}>
          Copy changes as patch
        </ContextMenuItem>
        <WriteMenuItem repo={repo} onClick={() => void historyCommands.applyPatch(repo)}>
          Apply patch…
        </WriteMenuItem>
      </ContextMenuContent>
    );
  }

  const headName = info?.head.branch ?? "HEAD";

  if (target.kind === "commits") {
    const rows = target.rows;
    const hashes = rows.map((r) => r.hash);
    const n = rows.length;
    const inBranch = editable(history, hashes);
    const adjacent = inBranch && contiguous(history, hashes);
    const indexes = hashes.map((h) => history?.commits.indexOf(h) ?? -1);
    return (
      <ContextMenuContent className="min-w-64">
        <WriteMenuItem
          repo={repo}
          onClick={() => void historyCommands.cherryPick(repo, rows.map(refOf))}
        >
          Cherry-pick {n} commits…
        </WriteMenuItem>
        {inBranch && (
          <>
            <ContextMenuSeparator />
            <WriteMenuItem repo={repo} onClick={() => void historyCommands.squash(repo, hashes)}>
              Squash {n} commits…
            </WriteMenuItem>
            <WriteMenuItem
              repo={repo}
              variant="destructive"
              onClick={() => void historyCommands.drop(repo, rows.map(refOf))}
            >
              Drop {n} commits…
            </WriteMenuItem>
            {adjacent && Math.min(...indexes) > 0 && (
              <WriteMenuItem
                repo={repo}
                onClick={() => void historyCommands.move(repo, hashes, "up")}
              >
                Move {n} commits up
              </WriteMenuItem>
            )}
            {adjacent && Math.max(...indexes) + 1 < (history?.commits.length ?? 0) && (
              <WriteMenuItem
                repo={repo}
                onClick={() => void historyCommands.move(repo, hashes, "down")}
              >
                Move {n} commits down
              </WriteMenuItem>
            )}
            <WriteMenuItem
              repo={repo}
              onClick={() => void historyCommands.rebaseFrom(repo, hashes)}
            >
              Interactive rebase from here…
            </WriteMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => void historyCommands.savePatch(repo, rows.map(refOf))}>
          Save {n} commits as patch…
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void historyCommands.copyPatch(repo, rows.map(refOf))}>
          Copy as patch
        </ContextMenuItem>
        <ContextMenuItem onClick={() => commands.copy(hashes.join("\n"), "Commit SHAs copied")}>
          Copy commit SHAs
        </ContextMenuItem>
      </ContextMenuContent>
    );
  }

  const { row, refs } = target;
  const hash = row.hash;
  const stash = stashes.find((s) => s.hash === hash);
  const branchRefs = refs.filter((r) => r.kind === "branch" || r.kind === "remote");
  const tags = refs.filter((r) => r.kind === "tag");
  const index = history?.commits.indexOf(hash) ?? -1;
  const inBranch = index >= 0;
  const isHead = info?.head.hash === hash;

  if (stash) {
    return (
      <ContextMenuContent className="min-w-56">
        <WriteMenuItem repo={repo} onClick={() => void commands.applyStash(repo, stash.index)}>
          Apply stash
        </WriteMenuItem>
        <WriteMenuItem repo={repo} onClick={() => void commands.pop(repo, stash.index)}>
          Pop stash
        </WriteMenuItem>
        <ContextMenuSeparator />
        <WriteMenuItem
          repo={repo}
          variant="destructive"
          onClick={() => void commands.dropStash(repo, stash.index)}
        >
          Delete stash
        </WriteMenuItem>
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
              <WriteMenuItem repo={repo} onClick={() => void commands.checkoutRef(repo, ref)}>
                Checkout {ref.short}
              </WriteMenuItem>
            )}
            {!ref.isHead && (
              <WriteMenuItem repo={repo} onClick={() => void commands.merge(repo, ref.short)}>
                Merge {ref.short} into {headName}
              </WriteMenuItem>
            )}
            {!ref.isHead && (
              <WriteMenuItem repo={repo} onClick={() => void commands.rebase(repo, ref.short)}>
                Rebase {headName} onto {ref.short}
              </WriteMenuItem>
            )}
            {!ref.isHead && (
              <WriteMenuItem
                repo={repo}
                onClick={() => historyCommands.rebaseInteractive(repo, ref.hash)}
              >
                Interactive rebase {headName} onto {ref.short}…
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
      <WriteMenuItem
        repo={repo}
        onClick={() => void historyCommands.cherryPick(repo, [refOf(row)])}
      >
        Cherry-pick commit…
      </WriteMenuItem>
      <WriteMenuItem repo={repo} onClick={() => void commands.revert(repo, hash)}>
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
      {!inBranch && !isHead && history && (
        <WriteMenuItem repo={repo} onClick={() => historyCommands.rebaseInteractive(repo, hash)}>
          Interactive rebase {headName} onto this commit…
        </WriteMenuItem>
      )}
      {inBranch && (
        <>
          <ContextMenuSeparator />
          <WriteMenuItem repo={repo} onClick={() => void historyCommands.reword(repo, hash)}>
            Edit commit message…
          </WriteMenuItem>
          <WriteMenuItem repo={repo} onClick={() => void historyCommands.edit(repo, refOf(row))}>
            Edit commit
          </WriteMenuItem>
          {index + 1 < history!.commits.length && (
            <WriteMenuItem
              repo={repo}
              onClick={() => void historyCommands.squashIntoParent(repo, hash)}
            >
              Squash into parent…
            </WriteMenuItem>
          )}
          <WriteMenuItem
            repo={repo}
            variant="destructive"
            onClick={() => void historyCommands.drop(repo, [refOf(row)])}
          >
            Drop commit…
          </WriteMenuItem>
          {index > 0 && (
            <WriteMenuItem
              repo={repo}
              onClick={() => void historyCommands.move(repo, [hash], "up")}
            >
              Move commit up
            </WriteMenuItem>
          )}
          {index + 1 < history!.commits.length && (
            <WriteMenuItem
              repo={repo}
              onClick={() => void historyCommands.move(repo, [hash], "down")}
            >
              Move commit down
            </WriteMenuItem>
          )}
          <WriteMenuItem repo={repo} onClick={() => void historyCommands.rebaseFrom(repo, [hash])}>
            Interactive rebase from here…
          </WriteMenuItem>
        </>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => void historyCommands.savePatch(repo, [refOf(row)])}>
        Save as patch…
      </ContextMenuItem>
      <ContextMenuItem onClick={() => void historyCommands.copyPatch(repo, [refOf(row)])}>
        Copy as patch
      </ContextMenuItem>
      <ContextMenuItem onClick={() => commands.copy(hash, "Commit SHA copied")}>
        Copy commit SHA
      </ContextMenuItem>
      <ContextMenuItem onClick={() => commands.copy(row.subject, "Message copied")}>
        Copy commit message
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
