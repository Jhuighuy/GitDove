import type { RepoId } from "@shared/domain";
import { repoLocationOf } from "@shared/domain";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId } from "react";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Spinner } from "@/components/ui/spinner";
import { api, useEvent } from "@/lib/api";
import { keys, refreshRepo } from "@/lib/queries";
import { useLayout, useRepoUi } from "@/stores/repo-ui";
import { useTabs } from "@/stores/tabs";
import { commands } from "./commands";
import { DetailsPanel } from "./details/DetailsPanel";
import { DiffView } from "./diff/DiffView";
import { CommitGraph } from "./graph/CommitGraph";
import { historyCommands } from "./history/commands";
import { OperationBar } from "./history/OperationBar";
import { RebaseEditor } from "./history/RebaseEditor";
import { Sidebar } from "./sidebar/Sidebar";
import { Toolbar } from "./toolbar/Toolbar";

export function RepoView({ repo, active }: { repo: RepoId; active: boolean }) {
  const location = repoLocationOf(repo);
  const opened = useQuery({
    queryKey: [...keys.repo(repo), "open"],
    queryFn: () => api("repo.open", location),
    retry: false,
  });

  if (opened.isPending) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
        <Spinner />
        {location.kind === "ssh" ? `Connecting to ${location.host}…` : "Opening repository…"}
      </div>
    );
  }
  if (opened.error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <IconAlertTriangle className="size-10 text-amber-500" />
        <div>
          <div className="font-semibold">Could not open {location.path}</div>
          <div className="text-muted-foreground mt-1 max-w-xl text-sm whitespace-pre-wrap">
            {opened.error.message}
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void opened.refetch()}>
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
  }
  return <RepoLayout repo={repo} active={active} />;
}

function RepoLayout({ repo, active }: { repo: RepoId; active: boolean }) {
  const layout = useLayout();
  const { diff, rebase } = useRepoUi(repo);
  // The panel library keeps layout state per group id, and every tab has a group: a shared id
  // made a tab opened after a hidden one inherit its unmeasured layout (equal thirds).
  const id = useId();

  // Menu commands target the active tab only.
  useEvent("menu.command", ({ command }) => {
    if (!active) return;
    switch (command) {
      case "refresh":
        void refreshRepo(repo);
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
        void commands.createBranch(repo, "HEAD");
        break;
      case "toggle-sidebar":
        layout.toggleSidebar();
        break;
      case "toggle-details":
        layout.toggleDetails();
        break;
      case "undo":
      case "redo":
        // In a text field, the menu edits its text instead.
        if (isEditable(document.activeElement)) void commands.edit(command);
        else void historyCommands[command](repo);
        break;
      case "apply-patch":
        void historyCommands.applyPatch(repo);
        break;
    }
  });

  // Refresh working tree status when the window regains focus.
  useEffect(() => {
    if (!active) return;
    const onFocus = () => void refreshRepo(repo);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [repo, active]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar repo={repo} />
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1" id={`${id}main`}>
        {layout.sidebar && (
          <>
            <ResizablePanel id={`${id}sidebar`} defaultSize={230} minSize={160} maxSize={480}>
              <Sidebar repo={repo} />
            </ResizablePanel>
            <ResizableHandle />
          </>
        )}
        <ResizablePanel id={`${id}center`} minSize={320}>
          <div className="flex h-full min-h-0 flex-col">
            <OperationBar repo={repo} />
            <div className="min-h-0 flex-1">
              {rebase ? (
                <RebaseEditor repo={repo} base={rebase.base} selected={rebase.selected} />
              ) : diff ? (
                <DiffView repo={repo} target={diff} />
              ) : (
                <CommitGraph repo={repo} />
              )}
            </div>
          </div>
        </ResizablePanel>
        {layout.details && (
          <>
            <ResizableHandle />
            <ResizablePanel id={`${id}details`} defaultSize={400} minSize={280} maxSize={720}>
              <DetailsPanel repo={repo} />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  );
}

/** Whether `el` takes text: Undo and Redo then edit its text rather than the repository. */
const isEditable = (el: Element | null): boolean =>
  el instanceof HTMLElement &&
  (el.isContentEditable ||
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && !["checkbox", "radio", "button"].includes(el.type)));
