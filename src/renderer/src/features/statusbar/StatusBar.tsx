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
import { keys, refreshRepo } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { type Busy, busyLabel, useBusy } from "@/stores/busy";
import { APP, type Notice, useActivity, useNotice } from "@/stores/status";
import { commands } from "../commands";

/**
 * The window's status bar: where the active tab's repository lives, what is happening in it
 * (the running operation, results, history still loading), and app-wide news such as an
 * update. Kept out of the toolbar, which then never changes size while operations run.
 */
export function StatusBar({ repo }: { repo: RepoId | null }) {
  const location = repo ? repoLocationOf(repo) : null;
  const { data: graph, error: graphFailure } = useCachedGraphInfo(repo);
  // A graph that loaded says why it is incomplete; one that never loaded has only the request's.
  const graphError = graph?.error ?? graphFailure?.message;
  const busy = useBusy(repo ?? "");
  const notice = useNotice(repo);
  const appNotice = useNotice(APP);
  const activity = useActivity();
  const update = useUpdateReady();

  return (
    <footer className="text-muted-foreground flex h-6 shrink-0 items-center gap-3 border-t px-3 text-[11px] [&_svg]:size-3.5 [&_svg]:shrink-0">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {location?.kind === "ssh" && (
          <CopyButton
            text={location.host}
            what="Host name copied"
            className="text-primary"
            title={`${location.host} (click to copy)`}
          >
            <IconServer />
            <span className="truncate">{location.host}</span>
          </CopyButton>
        )}
        {location?.kind === "local" && (
          <span className="flex shrink-0 items-center gap-1">
            <IconDeviceLaptop />
            Local
          </span>
        )}
        {location && (
          <CopyButton
            text={location.path}
            what="Path copied"
            title={`${location.path} (click to copy)`}
          >
            <span className="truncate">{location.path}</span>
          </CopyButton>
        )}
      </div>
      <div className="flex min-w-0 items-center justify-end gap-3">
        {graphError ? (
          <GraphError repo={repo!} graph={graph} error={graphError} />
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
          <span className="flex shrink-0 items-center gap-1.5 text-primary">
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

/** Status bar text that copies itself (or `text`) when clicked. */
function CopyButton({
  text,
  what,
  title,
  className,
  children,
}: {
  text: string;
  what: string;
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn(
        "hover:text-foreground flex min-w-0 cursor-pointer items-center gap-1 rounded",
        className,
      )}
      title={title}
      onClick={() => commands.copy(text, what)}
    >
      {children}
    </button>
  );
}

/**
 * Why the history is missing, cut off or outdated. The main process retries after a lost
 * connection on its own; Retry asks for the graph again right away.
 */
function GraphError({ repo, graph, error }: { repo: RepoId; graph?: GraphInfo; error: string }) {
  const client = useQueryClient();
  // The graph's info only (the graph view stays mounted, under a diff too): its pages never
  // change, and a reloaded graph comes with a new version and pages of its own.
  const retry = () => void refreshRepo(repo, ["graph"], client);
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-warning" title={error}>
      <IconAlertTriangle />
      <span className="truncate tabular-nums">
        {graphProblem(graph)}: {error}
      </span>
      <Button variant="outline" size="xs" className="-my-1 h-5 px-1.5 text-[11px]" onClick={retry}>
        Retry
      </Button>
    </span>
  );
}

const graphProblem = (graph: GraphInfo | undefined): string => {
  if (!graph) return "Couldn't load history";
  if (graph.complete) return "History may be outdated";
  return `History incomplete at ${graph.count.toLocaleString()} commits`;
};

/** How long a local operation runs before it can be cancelled (it may wait for input). */
export const LOCAL_CANCEL_MS = 3000;

/**
 * The running repository-changing operation, with a cancel button: at once for network
 * operations, after a while for local ones (e.g. a hook or a signing prompt that hangs).
 */
function BusyIndicator({ repo, busy }: { repo: RepoId; busy: Busy }) {
  const [late, setLate] = useState<Busy | null>(null);
  useEffect(() => {
    if (busy.cancellable || busy.refreshing) return;
    const id = setTimeout(
      () => setLate(busy),
      Math.max(0, busy.since + LOCAL_CANCEL_MS - Date.now()),
    );
    return () => clearTimeout(id);
  }, [busy]);
  // The refresh after the operation runs only queries: cancelling stops nothing.
  const cancellable = !busy.refreshing && (busy.cancellable || late === busy);
  const label = busyLabel(busy);
  return (
    <output className="flex min-w-0 items-center gap-1.5" title={label}>
      <Spinner className="size-3.5 shrink-0" role="presentation" aria-hidden />
      <span className="truncate">{label}</span>
      {cancellable && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Cancel"
          title={busy.cancellable ? "Cancel" : "Cancel (stops the running git command)"}
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
      {notice.kind === "success" ? <IconCheck className="text-success" /> : <IconInfoCircle />}
      <span className="truncate">{notice.text}</span>
    </output>
  );
}

/**
 * The graph's loading progress, from the cache only: the graph view requests it, and an
 * unopened repository must not be asked.
 */
const useCachedGraphInfo = (repo: RepoId | null) =>
  useQuery({
    queryKey: repo ? keys.graphInfo(repo) : ["no-repo"],
    queryFn: () => api("repo.graphInfo", repo!),
    enabled: false,
  });

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
