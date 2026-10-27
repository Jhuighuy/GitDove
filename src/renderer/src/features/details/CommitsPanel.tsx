import type { FileChange, RepoId } from "@shared/domain";
import { useCallback, useState } from "react";
import { Avatar, useAvatarProviders } from "@/components/Avatar";
import { Spinner } from "@/components/ui/spinner";
import { absoluteTime, listTime, shortHash } from "@/lib/format";
import { useCompare } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { type PickedCommit, useRepoUiStore } from "@/stores/repo-ui";
import { useSettings } from "@/stores/settings";
import { fileTarget } from "../diff/targets";
import { FileList, filesChanged, MoreFiles } from "./FileList";

/**
 * Details of several selected commits: the commits, and the changes from the parent of the
 * oldest to the newest, which also hold any commits in between that are not selected.
 */
export function CommitsPanel({
  repo,
  commits,
}: {
  repo: RepoId;
  commits: readonly PickedCommit[];
}) {
  const avatarProviders = useAvatarProviders(repo);
  const dates = useSettings((s) => s.dates);
  const select = useRepoUiStore((s) => s.select);
  const diff = useRepoUiStore((s) => s.byRepo[repo]?.diff ?? null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const tip = commits[0]!.row;
  const oldest = commits.at(-1)!.row;
  const { data, error, isPending } = useCompare(repo, oldest.parents[0] ?? null, tip.hash);
  const base = data?.base;
  const onOpen = useCallback(
    (f: FileChange) =>
      useRepoUiStore
        .getState()
        .openDiff(repo, fileTarget({ kind: "commit", hash: tip.hash, base }, f)),
    [repo, tip.hash, base],
  );

  const additions = data?.files.reduce((n, f) => n + (f.additions ?? 0), 0) ?? 0;
  const deletions = data?.files.reduce((n, f) => n + (f.deletions ?? 0), 0) ?? 0;
  const selectedPath =
    diff?.kind === "commit" && diff.hash === tip.hash && diff.base === data?.base
      ? diff.path
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-center border-b px-3 text-xs font-medium tabular-nums">
        {commits.length} commits selected
      </div>

      <ul className="max-h-[40%] shrink-0 overflow-y-auto border-b py-1">
        {commits.map(({ row }) => (
          <li key={row.hash}>
            <button
              type="button"
              className="hover:bg-muted/60 flex w-full cursor-default items-center gap-2.5 px-3 py-1.5 text-left"
              title="Show this commit only"
              onClick={() => select(repo, { kind: "commit", hash: row.hash })}
            >
              <Avatar
                name={row.authorName}
                email={row.authorEmail}
                providers={avatarProviders}
                size={24}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-medium">{row.subject}</div>
                <div className="text-muted-foreground truncate text-[11px]">
                  <span title={absoluteTime(row.authorTime)}>
                    {listTime(row.authorTime, dates)}
                  </span>
                  {" · "}
                  {row.authorName}
                </div>
              </div>
              <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
                {shortHash(row.hash)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <div className="flex h-8 shrink-0 items-center gap-2 px-3 text-xs">
        <span className="font-medium tabular-nums">
          {data ? filesChanged(data.files.length, data.totalFiles) : "Changes"}
        </span>
        <span
          className="text-muted-foreground truncate"
          title={`Changes from the parent of ${shortHash(oldest.hash)} to ${shortHash(tip.hash)}`}
        >
          in {shortHash(oldest.hash)}…{shortHash(tip.hash)}
        </span>
        {data && (
          <span
            className="ml-auto font-mono text-[11px] tabular-nums"
            title={data.truncated ? "In the files listed" : undefined}
          >
            <span className="text-success">+{additions}</span>{" "}
            <span className="text-destructive">-{deletions}</span>
          </span>
        )}
      </div>
      <div
        ref={setScroller}
        className={cn("min-h-0 flex-1 overflow-y-auto", !data && "flex items-start")}
      >
        {data ? (
          <div>
            <FileList
              label="Changed files"
              files={data.files}
              selectedPath={selectedPath}
              onOpen={onOpen}
              scroller={scroller}
            />
            {data.truncated && <MoreFiles listed={data.files.length} total={data.totalFiles} />}
          </div>
        ) : error ? (
          <div className="text-destructive p-3 text-sm">{error.message}</div>
        ) : (
          isPending && (
            <div className="text-muted-foreground flex items-center gap-2 p-3 text-sm">
              <Spinner /> Loading changes…
            </div>
          )
        )}
      </div>
    </div>
  );
}
