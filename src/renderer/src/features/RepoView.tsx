import type { RepoId, RepoInfo } from "@shared/domain";
import { repoLocationOf } from "@shared/domain";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useEffect, useId, useMemo, useState } from "react";
import type { Layout } from "react-resizable-panels";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Spinner } from "@/components/ui/spinner";
import { api, useEvent } from "@/lib/api";
import { keys, refreshRepo, WORKING_TREE } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { type PanelSizes, useLayout, useRepoUiStore } from "@/stores/repo-ui";
import { useTabs } from "@/stores/tabs";
import { commands } from "./commands";
import { DetailsPanel } from "./details/DetailsPanel";
import { DiffView } from "./diff/DiffView";
import { CommitGraph } from "./graph/CommitGraph";
import { Sidebar } from "./sidebar/Sidebar";
import { Toolbar } from "./toolbar/Toolbar";

// These take only the repository: a tab switch or a layout toggle need not render them again.
const MemoSidebar = memo(Sidebar);
const MemoCommitGraph = memo(CommitGraph);
const MemoDetailsPanel = memo(DetailsPanel);
const MemoToolbar = memo(Toolbar);

/** A repository tab: opens the repository, then shows it. */
export const RepoView = memo(function RepoView({
  repo,
  active,
}: {
  repo: RepoId;
  active: boolean;
}) {
  const location = useMemo(() => repoLocationOf(repo), [repo]);
  const client = useQueryClient();
  const opened = useQuery({
    queryKey: keys.open(repo),
    queryFn: async () => {
      const info = await api("repo.open", location);
      // Opening reads the repository's info: no need to ask again.
      client.setQueryData(keys.info(repo), info);
      return info;
    },
    retry: false,
  });

  // Once open, the repository stays on screen: later failures show where they happen.
  if (opened.data !== undefined) return <RepoLayout repo={repo} active={active} />;
  if (!opened.error) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
        <Spinner />
        {location.kind === "ssh" ? `Connecting to ${location.host}…` : "Opening repository…"}
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <IconAlertTriangle className="size-10 text-amber-500" />
      <div>
        <div className="font-semibold">Could not open {location.path}</div>
        <div className="text-muted-foreground mt-1 max-w-xl text-sm whitespace-pre-wrap select-text">
          {opened.error.message}
        </div>
      </div>
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={opened.isFetching}
          onClick={() => void opened.refetch()}
        >
          {opened.isFetching && <Spinner />}
          Retry
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            const tabs = useTabs.getState();
            tabs.removeRecent(repo);
            const tab = tabs.tabs.find((t) => t.repo === repo);
            if (tab) tabs.closeTab(tab.key);
          }}
        >
          Close
        </Button>
      </div>
    </div>
  );
});

function RepoLayout({ repo, active }: { repo: RepoId; active: boolean }) {
  const sidebar = useLayout((s) => s.sidebar);
  const details = useLayout((s) => s.details);
  const diff = useRepoUiStore((s) => s.byRepo[repo]?.diff ?? null);
  // The panel library keeps layout state per group id, and every tab has a group: a shared id
  // made a tab opened after a hidden one inherit its unmeasured layout (equal thirds).
  const id = useId();
  const client = useQueryClient();
  const panels = usePanelSizes(id, sidebar, details);

  // Menu commands target the active tab only.
  useEvent("menu.command", ({ command }) => {
    if (!active) return;
    switch (command) {
      case "refresh":
        void refreshRepo(repo);
        // Also history that changed without its refs changing (e.g. a deepened shallow clone);
        // the new graph arrives as progress events, and its errors show in the status bar.
        void api("repo.reloadGraph", repo).catch(() => {});
        break;
      case "fetch":
        void commands.fetch(repo);
        break;
      case "pull":
        void commands.pull(repo);
        break;
      case "push":
        void commands.push(repo);
        break;
      case "stash":
        void commands.stash(repo);
        break;
      case "pop":
        void commands.pop(repo);
        break;
      case "new-branch":
        void commands.createBranch(
          repo,
          "HEAD",
          client.getQueryData<RepoInfo>(keys.info(repo))?.head.branch ?? "HEAD",
        );
        break;
      case "commit-focus":
        // Works from anywhere: shows the working tree changes and the details panel first.
        useLayout.getState().showDetails();
        useRepoUiStore.getState().focusCommit(repo);
        break;
      case "toggle-sidebar":
        useLayout.getState().toggleSidebar();
        break;
      case "toggle-details":
        useLayout.getState().toggleDetails();
        break;
    }
  });

  // Coming back to the app, the working tree may have changed (e.g. in an editor). Refs
  // changes are reported by the watcher, and an explicit refresh refetches everything.
  useEffect(() => {
    if (!active) return;
    const onFocus = () => void refreshRepo(repo, WORKING_TREE);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [repo, active]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MemoToolbar repo={repo} />
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1"
        id={`${id}main`}
        defaultLayout={panels.defaultLayout}
        onLayoutChanged={panels.onLayoutChanged}
      >
        {sidebar && (
          <>
            <ResizablePanel id={`${id}sidebar`} defaultSize={230} minSize={160} maxSize={480}>
              <MemoSidebar repo={repo} />
            </ResizablePanel>
            <ResizableHandle />
          </>
        )}
        <ResizablePanel id={`${id}center`} minSize={320}>
          <div className="relative h-full">
            {/* The graph stays mounted (and keeps its scroll position) under a diff. */}
            <div className={cn("h-full", diff && "invisible")} inert={diff !== null}>
              <MemoCommitGraph repo={repo} />
            </div>
            {diff && (
              <div className="bg-background absolute inset-0">
                <DiffView repo={repo} target={diff} />
              </div>
            )}
          </div>
        </ResizablePanel>
        {details && (
          <>
            <ResizableHandle />
            <ResizablePanel id={`${id}details`} defaultSize={400} minSize={280} maxSize={720}>
              <MemoDetailsPanel repo={repo} />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  );
}

/**
 * The side panels' sizes as the user last left them (in any tab), for a panel group whose
 * panel ids start with `id`.
 */
function usePanelSizes(id: string, sidebar: boolean, details: boolean) {
  // Only the first layout counts: the library ignores later ones.
  const [defaultLayout] = useState((): Layout | undefined => {
    const saved = useLayout.getState().panels;
    const layout: Layout = {};
    let rest = 100;
    for (const [panel, shown] of [
      ["sidebar", sidebar],
      ["details", details],
    ] as const) {
      if (!shown) continue;
      const size = saved[panel];
      if (size === undefined) return undefined;
      layout[`${id}${panel}`] = size;
      rest -= size;
    }
    if (rest <= 0) return undefined;
    layout[`${id}center`] = rest;
    return layout;
  });
  const onLayoutChanged = (layout: Layout, meta: { isUserInteraction: boolean }) => {
    if (!meta.isUserInteraction) return;
    const sizes: { -readonly [K in keyof PanelSizes]: number } = {};
    const sidebarSize = layout[`${id}sidebar`];
    const detailsSize = layout[`${id}details`];
    if (sidebarSize !== undefined) sizes.sidebar = sidebarSize;
    if (detailsSize !== undefined) sizes.details = detailsSize;
    useLayout.getState().setPanels(sizes);
  };
  return { defaultLayout, onLayoutChanged };
}
