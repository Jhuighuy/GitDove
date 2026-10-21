import type { GraphInfo, RepoId, UpdaterStatus } from "@shared/domain";
import { repoLocationOf } from "@shared/domain";
import {
  IconAlertTriangle,
  IconCheck,
  IconDeviceLaptop,
  IconInfoCircle,
  IconServer,
  IconX,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api, useEvent } from "@/lib/api";
import { keys } from "@/lib/queries";
import { type Busy, useBusy } from "@/stores/busy";
import { APP, type Notice, useActivity, useNotice } from "@/stores/status";
import { commands } from "../commands";

/**
 * The window's status bar: where the active tab's repository lives, what is happening in it
 * (the running operation, results, history still loading), and app-wide news such as an
 * update. Kept out of the toolbar, which then never changes size while operations run.
 */
export function StatusBar({ repo }: { repo: RepoId | null }) {
  const location = repo ? repoLocationOf(repo) : null;
  const graph = useCachedGraphInfo(repo);
  const busy = useBusy(repo ?? "");
  const notice = useNotice(repo);
  const appNotice = useNotice(APP);
  const activity = useActivity();
  const update = useUpdateReady();

  return (
    <footer className="text-muted-foreground flex h-6 shrink-0 items-center gap-3 border-t px-3 text-[11px] [&_svg]:size-3.5 [&_svg]:shrink-0">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {location?.kind === "ssh" && (
          <span className="flex min-w-0 items-center gap-1 text-sky-500" title={location.host}>
            <IconServer />
            <span className="truncate">{location.host}</span>
          </span>
        )}
        {location?.kind === "local" && (
          <span className="flex shrink-0 items-center gap-1">
            <IconDeviceLaptop />
            Local
          </span>
        )}
        {location && (
          <span className="min-w-0 truncate" title={location.path}>
            {location.path}
          </span>
        )}
      </div>
      <div className="flex min-w-0 items-center justify-end gap-3">
        {graph?.error ? (
          <GraphError repo={repo!} graph={graph} error={graph.error} />
        ) : (
          graph &&
          !graph.complete &&
          graph.count > 0 && (
            <span className="shrink-0 tabular-nums">
              Loading history… {graph.count.toLocaleString()} commits
            </span>
          )
        )}
        {busy ? (
          <BusyIndicator repo={repo!} busy={busy} />
        ) : (
          notice && <NoticeView notice={notice} />
        )}
        {activity && (
          <output className="flex min-w-0 items-center gap-1.5" title={activity}>
            <Spinner className="size-3.5 shrink-0" role="presentation" aria-hidden />
            <span className="truncate">{activity}</span>
          </output>
        )}
        {appNotice && <NoticeView notice={appNotice} />}
        {update && (
          <span className="flex shrink-0 items-center gap-1.5 text-sky-500">
            GitDove {update} is ready
            <Button
              variant="outline"
              size="xs"
              className="-my-1 h-5 px-1.5 text-[11px]"
              title="Restart now, or it will be installed when you quit."
              onClick={() => void api("updater.install")}
            >
              Restart
            </Button>
          </span>
        )}
      </div>
    </footer>
  );
}

/**
 * Why the history is cut off or outdated. The main process retries after a lost connection on
 * its own; Retry asks for the graph again right away.
 */
function GraphError({ repo, graph, error }: { repo: RepoId; graph: GraphInfo; error: string }) {
  const client = useQueryClient();
  const retry = () => {
    void client.invalidateQueries({ queryKey: keys.repo(repo) });
    // Asked for explicitly: with the graph view closed (e.g. a diff is open), the only graph
    // query left is the disabled one above, which invalidating does not refetch.
    client
      .fetchQuery({ queryKey: keys.graphInfo(repo), queryFn: () => api("repo.graphInfo", repo) })
      .catch(() => {});
  };
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-amber-500" title={error}>
      <IconAlertTriangle />
      <span className="truncate tabular-nums">
        {graph.complete
          ? "History may be outdated"
          : `History incomplete at ${graph.count.toLocaleString()} commits`}
        : {error}
      </span>
      <Button variant="outline" size="xs" className="-my-1 h-5 px-1.5 text-[11px]" onClick={retry}>
        Retry
      </Button>
    </span>
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

function NoticeView({ notice }: { notice: Notice }) {
  return (
    <output className="flex min-w-0 items-center gap-1" title={notice.text}>
      {notice.kind === "success" ? <IconCheck className="text-emerald-500" /> : <IconInfoCircle />}
      <span className="truncate">{notice.text}</span>
    </output>
  );
}

/**
 * The graph's loading progress, from the cache only: the graph view requests it, and an
 * unopened repository must not be asked.
 */
const useCachedGraphInfo = (repo: RepoId | null): GraphInfo | undefined =>
  useQuery({
    queryKey: repo ? keys.graphInfo(repo) : ["no-repo"],
    queryFn: () => api("repo.graphInfo", repo!),
    enabled: false,
  }).data;

/** The version of a downloaded over-the-air update, once one is ready. */
const useUpdateReady = (): string | null => {
  const [version, setVersion] = useState<string | null>(null);
  const onStatus = useCallback((s: UpdaterStatus) => {
    if (s.kind === "ready") setVersion(s.version);
  }, []);
  useEvent("updater.status", onStatus);
  // The update may have been downloaded before this window loaded.
  useEffect(() => {
    void api("updater.status")
      .then(onStatus)
      .catch(() => {});
  }, [onStatus]);
  return version;
};
