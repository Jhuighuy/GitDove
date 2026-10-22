import { useEffect } from "react";
import { TextContextMenu } from "@/components/TextContextMenu";
import { Spinner } from "@/components/ui/spinner";
import { useRepoEvents } from "@/lib/queries";
import { useTabs } from "@/stores/tabs";
import { DialogHost } from "./features/dialogs/dialogs";
import { CherryPickDialogHost } from "./features/history/CherryPickDialog";
import { MessageDialogHost } from "./features/history/MessageDialog";
import { PatchDialogHost } from "./features/history/PatchDialog";
import { OpenRepoPage, RemoteRepoDialog, useOpenCommands } from "./features/open/OpenRepo";
import { RepoView } from "./features/RepoView";
import { TabBar } from "./features/tabs/TabBar";
import { StatusBar } from "./features/statusbar/StatusBar";

export function App() {
  const { tabs, active, loaded, load } = useTabs();
  useRepoEvents();
  useOpenCommands();

  useEffect(() => {
    void load();
  }, [load]);

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
        {tabs.map((tab) => (
          <div key={tab.key} className="absolute inset-0" hidden={tab.key !== active}>
            {tab.repo ? (
              <RepoView repo={tab.repo} active={tab.key === active} />
            ) : (
              <OpenRepoPage tabKey={tab.key} />
            )}
          </div>
        ))}
      </main>
      <StatusBar repo={tabs.find((t) => t.key === active)?.repo ?? null} />
      <DialogHost />
      <MessageDialogHost />
      <CherryPickDialogHost />
      <PatchDialogHost />
      <RemoteRepoDialog />
      <TextContextMenu />
    </div>
  );
}
