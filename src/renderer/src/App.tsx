import { IconAlertTriangle } from "@tabler/icons-react";
import { Component, type ErrorInfo, type ReactNode, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { TextContextMenu } from "@/components/TextContextMenu";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useRepoEvents } from "@/lib/queries";
import { useTabs } from "@/stores/tabs";
import { DialogHost } from "./features/dialogs/dialogs";
import { OpenRepoPage, RemoteRepoDialog, useOpenCommands } from "./features/open/OpenRepo";
import { RepoView } from "./features/RepoView";
import { TabBar } from "./features/tabs/TabBar";
import { StatusBar } from "./features/statusbar/StatusBar";

export function App() {
  const { tabs, active, loaded, load } = useTabs(
    useShallow((s) => ({ tabs: s.tabs, active: s.active, loaded: s.loaded, load: s.load })),
  );
  useRepoEvents();
  useOpenCommands();

  useEffect(() => {
    void load();
  }, [load]);

  // A tab is mounted when first shown, so that restoring many tabs opens (and connects to)
  // only the active one; once mounted it stays, to keep its state.
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set());
  if (active !== null && !shown.has(active)) {
    setShown(new Set([...shown].filter((k) => tabs.some((t) => t.key === k))).add(active));
  }

  if (!loaded) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TabBar />
      <main className="relative min-h-0 flex-1">
        {tabs.map(
          (tab) =>
            (tab.key === active || shown.has(tab.key)) && (
              <div key={tab.key} className="absolute inset-0" hidden={tab.key !== active}>
                <ErrorBoundary>
                  {tab.repo ? (
                    <RepoView repo={tab.repo} active={tab.key === active} />
                  ) : (
                    <OpenRepoPage tabKey={tab.key} />
                  )}
                </ErrorBoundary>
              </div>
            ),
        )}
      </main>
      <StatusBar repo={tabs.find((t) => t.key === active)?.repo ?? null} />
      <DialogHost />
      <RemoteRepoDialog />
      <TextContextMenu />
    </div>
  );
}

/**
 * Shows a failure to render instead of an empty window, and lets the user try again. Wraps the
 * app, and each tab so that one broken tab leaves the others usable.
 */
export class ErrorBoundary extends Component<
  { readonly children: ReactNode },
  { readonly error: Error | null }
> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Render failed", error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-4 p-8 text-center">
        <IconAlertTriangle className="size-10 text-warning" />
        <div>
          <div className="font-semibold">Something went wrong</div>
          <div className="text-muted-foreground mt-1 max-w-xl text-sm whitespace-pre-wrap select-text">
            {error.message}
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => this.setState({ error: null })}>
            Try Again
          </Button>
          <Button variant="ghost" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      </div>
    );
  }
}
