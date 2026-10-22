import type { FileChange, RepoId } from "@shared/domain";
import { IconCopy } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { absoluteTime, relativeTime, shortHash } from "@/lib/format";
import { useCommitDetails, useRefs } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useRepoUiStore } from "@/stores/repo-ui";
import { commands } from "../commands";
import { fileTarget } from "../diff/targets";
import { Avatar, useAvatarProviders } from "@/components/Avatar";
import { FileList } from "./FileList";

/** How long a selection must stay before its details load, while moving through commits. */
const SETTLE_MS = 100;

/** `value`, once it stopped changing for `ms` (at once the first time). */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (Object.is(value, settled)) return;
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, settled, ms]);
  return settled;
}

export function CommitPanel({ repo, hash }: { repo: RepoId; hash: string }) {
  // Holding an arrow key in the graph must not ask for every commit passed (over SSH, these
  // queue up): the previous commit stays, dimmed, until the selection settles and loads.
  const settled = useSettled(hash, SETTLE_MS);
  const { data, error, isPending } = useCommitDetails(repo, settled, { keepPrevious: true });
  const { data: refs } = useRefs(repo);
  const avatarProviders = useAvatarProviders(repo);
  const diff = useRepoUiStore((s) => s.byRepo[repo]?.diff ?? null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const stash = refs?.stashes.find((s) => s.hash === hash);
  // (A commit that is not found has null details.)
  const stale = data != null && data.hash !== hash;
  const shown = data?.hash ?? hash;
  const onOpen = useCallback(
    (f: FileChange) =>
      useRepoUiStore.getState().openDiff(repo, fileTarget({ kind: "commit", hash: shown }, f)),
    [repo, shown],
  );

  if (isPending && !data) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
        <Spinner /> Loading commit…
      </div>
    );
  }
  if (!data) {
    return (
      <div className="text-destructive p-4 text-sm">{error?.message ?? "Commit not found"}</div>
    );
  }

  const sameCommitter =
    data.author.email === data.committer.email && data.author.name === data.committer.name;
  const additions = data.files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const deletions = data.files.reduce((n, f) => n + (f.deletions ?? 0), 0);

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col transition-opacity",
        // The previous commit, until this one loads.
        stale && "pointer-events-none opacity-60",
      )}
      aria-busy={stale}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-xs">
        <span className="text-muted-foreground">{stash ? stash.name : "commit:"}</span>
        <button
          type="button"
          className="hover:bg-muted flex items-center gap-1 rounded px-1 font-mono"
          title="Copy SHA"
          onClick={() => commands.copy(data.hash, "Commit SHA copied")}
        >
          {shortHash(data.hash)}
          <IconCopy className="size-3 opacity-60" />
        </button>
        {data.parents.length > 0 && (
          <span className="text-muted-foreground ml-auto flex items-center gap-1">
            {data.parents.length > 1 ? "parents:" : "parent:"}
            {data.parents.map((p) => (
              <button
                key={p}
                type="button"
                className="text-foreground hover:bg-muted rounded px-1 font-mono"
                onClick={() => commands.selectCommit(repo, p)}
              >
                {shortHash(p)}
              </button>
            ))}
          </span>
        )}
      </div>

      <div className="max-h-[45%] shrink-0 overflow-y-auto border-b px-3 py-3">
        <h2 className="text-[14px] leading-snug font-semibold break-words select-text">
          {data.subject}
        </h2>
        {data.body && (
          <pre className="text-muted-foreground mt-2 font-sans text-[12px] leading-relaxed break-words whitespace-pre-wrap select-text">
            {data.body}
          </pre>
        )}
        <div className="mt-3 flex items-center gap-2">
          <Avatar
            name={data.author.name}
            email={data.author.email}
            providers={avatarProviders}
            size={28}
          />
          <div className="min-w-0 text-xs">
            <div className="truncate font-medium">{data.author.name}</div>
            <div className="text-muted-foreground" title={absoluteTime(data.author.time)}>
              authored {relativeTime(data.author.time)} · {absoluteTime(data.author.time)}
            </div>
          </div>
        </div>
        {!sameCommitter && (
          <div className="text-muted-foreground mt-1.5 text-[11px]">
            committed by {data.committer.name} {relativeTime(data.committer.time)}
          </div>
        )}
      </div>

      <div className="flex h-8 shrink-0 items-center gap-2 px-3 text-xs">
        <span className="font-medium tabular-nums">
          {data.files.length} {data.files.length === 1 ? "file" : "files"} changed
        </span>
        <span className="ml-auto font-mono text-[11px] tabular-nums">
          <span className="text-emerald-500">+{additions}</span>{" "}
          <span className="text-red-500">-{deletions}</span>
        </span>
      </div>
      <div ref={setScroller} className="min-h-0 flex-1 overflow-y-auto">
        <FileList
          label="Changed files"
          files={data.files}
          selectedPath={diff?.kind === "commit" && diff.hash === shown ? diff.path : null}
          onOpen={onOpen}
          scroller={scroller}
        />
      </div>
    </div>
  );
}
