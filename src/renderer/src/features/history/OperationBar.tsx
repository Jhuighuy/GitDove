import type { OperationInfo, RepoId, RepoInfo } from "@shared/domain";
import {
  IconAlertTriangle,
  IconGitCherryPick,
  IconGitMerge,
  IconPencil,
  IconPlayerPause,
  IconSearch,
} from "@tabler/icons-react";
import { BusyHint } from "@/components/busy";
import { Button } from "@/components/ui/button";
import { shortHash } from "@/lib/format";
import { useRepoInfo, useStatus } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { busyReason, useBusy } from "@/stores/busy";
import { commands } from "../commands";

const TITLES: Record<Exclude<RepoInfo["state"], "clean">, string> = {
  rebasing: "Rebasing",
  merging: "Merging",
  "cherry-picking": "Cherry-picking",
  reverting: "Reverting",
  applying: "Applying patches",
  bisecting: "Bisecting",
};

const titleOf = (info: RepoInfo, op: OperationInfo | null) => {
  if (info.state === "rebasing" && op) {
    const branch = op.branch ?? "HEAD";
    return op.onto ? `Rebasing ${branch} onto ${shortHash(op.onto)}` : `Rebasing ${branch}`;
  }
  if (info.state === "merging") return `Merging into ${info.head.branch ?? "HEAD"}`;
  return TITLES[info.state as keyof typeof TITLES];
};

/**
 * Where a rebase, merge, cherry-pick, revert or patch series stands while it is in progress,
 * what the user needs to do, and the buttons to go on. Shown above the graph.
 */
export function OperationBar({ repo }: { repo: RepoId }) {
  const { data: info } = useRepoInfo(repo);
  const { data: status } = useStatus(repo);
  const busy = useBusy(repo);
  if (!info || info.state === "clean") return null;

  const reason = busy ? busyReason(busy) : undefined;
  if (info.state === "bisecting") {
    return (
      <Bar
        tone="info"
        icon={<IconSearch />}
        title="Bisecting"
        detail="Mark commits as good or bad in a terminal, or stop bisecting to go back."
      >
        <BusyHint reason={reason}>
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy}
            onClick={() => void commands.abort(repo)}
          >
            Stop Bisecting
          </Button>
        </BusyHint>
      </Bar>
    );
  }

  const op = info.operation;
  const conflicts = status?.conflicted.length ?? 0;
  const merge = info.state === "merging";
  const editing = !!op?.editing && conflicts === 0;
  const what = conflicts === 1 ? "1 file" : `${conflicts} files`;
  const detail =
    conflicts > 0
      ? `Conflicts in ${what}: resolve them and mark them resolved, then continue.`
      : editing
        ? "Stopped to edit this commit: stage changes and continue to amend it."
        : merge
          ? "Conflicts are resolved: commit the merge to finish it."
          : info.state === "rebasing" && !op?.commit
            ? "Paused: continue when you are ready."
            : "Conflicts are resolved: continue to commit it and go on.";
  const progress =
    op?.step && op.total
      ? `${Math.min(op.step, op.total)} of ${op.total}`
      : op && op.remaining > 0
        ? `${op.remaining} more after this`
        : null;
  const icon =
    conflicts > 0 ? (
      <IconAlertTriangle />
    ) : editing ? (
      <IconPencil />
    ) : merge ? (
      <IconGitMerge />
    ) : info.state === "rebasing" ? (
      <IconPlayerPause />
    ) : (
      <IconGitCherryPick />
    );

  return (
    <Bar
      tone={conflicts > 0 ? "warning" : "info"}
      icon={icon}
      title={titleOf(info, op)}
      progress={progress}
      commit={op?.commit ?? null}
      subject={op?.subject ?? null}
      fraction={
        op?.step && op.total
          ? Math.min(1, (op.step - 1 + (conflicts > 0 ? 0.5 : 1)) / op.total)
          : null
      }
      detail={detail}
    >
      <BusyHint reason={reason} className="gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          disabled={!!busy}
          onClick={() => void commands.abort(repo)}
        >
          Abort
        </Button>
        {!merge && (
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy}
            onClick={() => void commands.skip(repo)}
            title="Leave out the commit it stopped at"
          >
            Skip
          </Button>
        )}
        <Button
          size="sm"
          disabled={!!busy || conflicts > 0}
          title={conflicts > 0 ? "Resolve the conflicts first" : undefined}
          onClick={() => void commands.continue(repo)}
        >
          {merge ? "Commit Merge" : "Continue"}
        </Button>
      </BusyHint>
    </Bar>
  );
}

function Bar({
  tone,
  icon,
  title,
  progress,
  commit,
  subject,
  fraction,
  detail,
  children,
}: {
  tone: "warning" | "info";
  icon: React.ReactNode;
  title: string;
  progress?: string | null;
  commit?: string | null;
  subject?: string | null;
  fraction?: number | null;
  detail: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="status"
      className={cn(
        "relative flex shrink-0 items-center gap-3 border-b px-3 py-2",
        tone === "warning" ? "bg-amber-500/10" : "bg-primary/10",
      )}
    >
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md [&_svg]:size-4",
          tone === "warning" ? "bg-amber-500/15 text-amber-500" : "bg-primary/15 text-primary",
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-[13px]">
          <span className="shrink-0 font-semibold">{title}</span>
          {progress && (
            <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
              {progress}
            </span>
          )}
          {(commit || subject) && (
            <span className="text-muted-foreground flex min-w-0 items-baseline gap-1.5 text-[12px]">
              <span aria-hidden>·</span>
              {commit && (
                <span className="shrink-0 font-mono text-[11px]">{shortHash(commit)}</span>
              )}
              {subject && <span className="truncate">{subject}</span>}
            </span>
          )}
        </div>
        <div className="text-muted-foreground truncate text-[12px]" title={detail}>
          {detail}
        </div>
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
      {fraction != null && (
        <div className="absolute inset-x-0 bottom-0 h-0.5">
          <div
            className={cn(
              "h-full transition-[width] duration-300",
              tone === "warning" ? "bg-amber-500/70" : "bg-primary/70",
            )}
            style={{ width: `${fraction * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}
