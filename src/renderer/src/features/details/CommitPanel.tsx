import { type RepoId, renameSource } from "@shared/domain";
import { IconCopy } from "@tabler/icons-react";
import { Spinner } from "@/components/ui/spinner";
import { absoluteTime, relativeTime, shortHash } from "@/lib/format";
import { useCommitDetails, useRefs } from "@/lib/queries";
import { useRepoUi, useRepoUiStore } from "@/stores/repo-ui";
import { commands } from "../commands";
import { Avatar, useAvatarProviders } from "@/components/Avatar";
import { FileList } from "./FileList";

export function CommitPanel({ repo, hash }: { repo: RepoId; hash: string }) {
  const { data, error, isPending } = useCommitDetails(repo, hash);
  const { data: refs } = useRefs(repo);
  const avatarProviders = useAvatarProviders(repo);
  const { diff } = useRepoUi(repo);
  const openDiff = useRepoUiStore((s) => s.openDiff);
  const stash = refs?.stashes.find((s) => s.hash === hash);

  if (isPending) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
        <Spinner /> Loading commit…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="text-destructive p-4 text-sm">{error?.message ?? "Commit not found"}</div>
    );
  }

  const sameCommitter =
    data.author.email === data.committer.email && data.author.name === data.committer.name;
  const additions = data.files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const deletions = data.files.reduce((n, f) => n + (f.deletions ?? 0), 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
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
      <div className="min-h-0 flex-1 overflow-y-auto">
        <FileList
          files={data.files}
          selectedPath={diff?.kind === "commit" && diff.hash === hash ? diff.path : null}
          onOpen={(f) => openDiff(repo, { kind: "commit", hash, path: f.path, ...renameSource(f) })}
        />
      </div>
    </div>
  );
}
