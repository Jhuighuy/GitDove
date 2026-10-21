import type { RepoId } from "@shared/domain";
import { IconDeviceLaptop, IconServer, IconX } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useGraphInfo, useRepoInfo } from "@/lib/queries";
import { type Busy, useBusy } from "@/stores/busy";
import { commands } from "../commands";

/**
 * Where the repository lives, and what is happening in it: the running operation and history
 * still loading. Kept out of the toolbar, which then never changes size while operations run.
 */
export function StatusBar({ repo }: { repo: RepoId }) {
  const { data: info } = useRepoInfo(repo);
  const { data: graph } = useGraphInfo(repo);
  const busy = useBusy(repo);
  const location = info?.location;

  return (
    <footer className="text-muted-foreground flex h-6 shrink-0 items-center gap-3 border-t px-3 text-[11px] [&_svg]:size-3.5 [&_svg]:shrink-0">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {location?.kind === "ssh" ? (
          <span className="flex min-w-0 items-center gap-1 text-sky-500" title={location.host}>
            <IconServer />
            <span className="truncate">{location.host}</span>
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-1">
            <IconDeviceLaptop />
            Local
          </span>
        )}
        {info && (
          <span className="min-w-0 truncate" title={info.workTree}>
            {info.workTree}
          </span>
        )}
      </div>
      <div className="flex min-w-0 items-center justify-end gap-3">
        {graph && !graph.complete && graph.count > 0 && (
          <span className="shrink-0 tabular-nums">
            Loading history… {graph.count.toLocaleString()} commits
          </span>
        )}
        {busy && <BusyIndicator repo={repo} busy={busy} />}
      </div>
    </footer>
  );
}

/** The running repository-changing operation, with a cancel button for network operations. */
function BusyIndicator({ repo, busy }: { repo: RepoId; busy: Busy }) {
  return (
    <output className="flex min-w-0 items-center gap-1.5" title={busy.label}>
      <Spinner className="size-3.5 shrink-0" role="presentation" aria-hidden />
      <span className="truncate">{busy.label}</span>
      {busy.cancellable && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Cancel"
          title="Cancel"
          className="-my-1 size-5"
          onClick={() => commands.cancel(repo)}
        >
          <IconX />
        </Button>
      )}
    </output>
  );
}
