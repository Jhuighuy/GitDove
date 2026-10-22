import type { RepoId, RepoLocation } from "@shared/domain";
import { repoDisplayName, repoLocationOf } from "@shared/domain";
import {
  IconArrowUp,
  IconFolder,
  IconFolderOpen,
  IconGitBranch,
  IconServer,
  IconX,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { create } from "zustand";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import logo from "@/assets/icon.svg";
import { api, ApiError, modKey, useEvent } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useStatusStore } from "@/stores/status";
import { useTabs } from "@/stores/tabs";

/** Opens a repository location in the active tab, reporting failures. */
export const openLocation = async (location: RepoLocation, tabKey?: string): Promise<boolean> => {
  // Opening first gives the tab the repository's own id (e.g. for a subdirectory).
  const done = useStatusStore
    .getState()
    .startActivity(
      location.kind === "ssh" ? `Connecting to ${location.host}…` : "Opening repository…",
    );
  try {
    const info = await api("repo.open", location);
    useTabs.getState().openRepo(info.id, tabKey);
    return true;
  } catch (e) {
    toast.error("Could not open repository", {
      description: e instanceof ApiError ? e.message : String(e),
    });
    return false;
  } finally {
    done();
  }
};

export const pickLocalRepository = async (tabKey?: string) => {
  const path = await api("dialog.pickDirectory");
  if (path) await openLocation({ kind: "local", path }, tabKey);
};

export const useRemoteDialog = create<{
  open: boolean;
  tabKey: string | undefined;
  show(tabKey?: string): void;
  hide(): void;
}>()((set) => ({
  open: false,
  tabKey: undefined,
  show: (tabKey) => set({ open: true, tabKey }),
  hide: () => set({ open: false }),
}));

/** Content of a tab that has no repository yet. */
export function OpenRepoPage({ tabKey }: { tabKey: string }) {
  const recent = useTabs((s) => s.recent);
  const removeRecent = useTabs((s) => s.removeRecent);
  const showRemote = useRemoteDialog((s) => s.show);

  return (
    <div className="flex h-full items-start justify-center overflow-y-auto p-10">
      <div className="flex w-full max-w-2xl flex-col gap-8">
        <div className="flex items-center gap-3">
          <img src={logo} alt="" className="size-12" draggable={false} />
          <div>
            <h1 className="text-xl font-semibold">GitDove</h1>
            <p className="text-muted-foreground text-sm">Open a repository to get started.</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <ActionCard
            icon={<IconFolderOpen />}
            title="Open local repository"
            hint={`${modKey}O`}
            onClick={() => void pickLocalRepository(tabKey)}
          />
          <ActionCard
            icon={<IconServer />}
            title="Open remote repository (SSH)"
            hint={`${modKey}⇧O`}
            onClick={() => showRemote(tabKey)}
          />
        </div>

        {recent.length > 0 && (
          <div>
            <h2 className="text-muted-foreground mb-2 text-[11px] font-semibold tracking-wider uppercase">
              Recent
            </h2>
            <ul className="flex flex-col">
              {recent.map((id) => (
                <RecentItem
                  key={id}
                  id={id}
                  onOpen={() => void openLocation(repoLocationOf(id), tabKey)}
                  onRemove={() => removeRecent(id)}
                />
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function ActionCard({
  icon,
  title,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="bg-card hover:bg-muted flex items-center gap-3 rounded-2xl border p-4 text-left transition-colors [&_svg]:size-6"
    >
      <span className="text-sidebar-primary">{icon}</span>
      <span className="flex-1 text-sm font-medium">{title}</span>
      <span className="text-muted-foreground text-xs">{hint}</span>
    </button>
  );
}

function RecentItem({
  id,
  onOpen,
  onRemove,
}: {
  id: RepoId;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const loc = repoLocationOf(id);
  return (
    <li
      className="group hover:bg-muted flex h-10 cursor-default items-center gap-3 rounded-lg px-3"
      onClick={onOpen}
    >
      {loc.kind === "ssh" ? (
        <IconServer className="size-4 shrink-0 text-primary" />
      ) : (
        <IconFolder className="text-muted-foreground size-4 shrink-0" />
      )}
      <span className="text-sm font-medium">{repoDisplayName(loc)}</span>
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
        {loc.kind === "ssh" ? `${loc.host}:${loc.path}` : loc.path}
      </span>
      <button
        type="button"
        className="hover:bg-background flex size-6 items-center justify-center rounded opacity-0 group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        aria-label="Remove from recent"
      >
        <IconX className="size-3.5" />
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Remote repository dialog
// ---------------------------------------------------------------------------

export function RemoteRepoDialog() {
  const { open, tabKey, hide } = useRemoteDialog();
  return (
    <Dialog open={open} onOpenChange={(o) => !o && hide()}>
      {open && <RemoteRepoBody tabKey={tabKey} onDone={hide} />}
    </Dialog>
  );
}

const LAST_HOST_KEY = "gitdove.lastSshHost";

function RemoteRepoBody({ tabKey, onDone }: { tabKey: string | undefined; onDone: () => void }) {
  const hosts = useQuery({ queryKey: ["ssh", "hosts"], queryFn: () => api("ssh.hosts") });
  const [hostDraft, setHostDraft] = useState(() => localStorage.getItem(LAST_HOST_KEY) ?? "");
  const [chosenHost, setChosenHost] = useState<string | null>(hostDraft || null);
  const [path, setPathValue] = useState<string | null>(null);
  const [pathDraft, setPathDraft] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  // Until the user picks a host, default to the first one from ~/.ssh/config.
  const host = hostDraft || hosts.data?.[0] || "";
  const browseHost = chosenHost ?? (hosts.data?.[0] || null);
  const setPath = (p: string | null) => {
    setPathValue(p);
    setPathDraft(null);
  };

  const listing = useQuery({
    queryKey: ["ssh", "listDir", browseHost, path],
    queryFn: () => api("ssh.listDir", browseHost!, path),
    enabled: browseHost !== null,
    retry: false,
    staleTime: 10_000,
  });

  const pathInput = pathDraft ?? listing.data?.path ?? "";

  const open = async (target: string) => {
    if (!browseHost) return;
    setOpening(true);
    localStorage.setItem(LAST_HOST_KEY, browseHost);
    const ok = await openLocation({ kind: "ssh", host: browseHost, path: target }, tabKey);
    setOpening(false);
    if (ok) onDone();
  };

  const cwd = listing.data?.path ?? "";
  const join = (name: string) => (cwd === "/" ? `/${name}` : `${cwd}/${name}`);
  const parent = cwd.replace(/\/[^/]+\/?$/, "") || "/";

  return (
    <DialogContent
      className="flex max-h-[80vh] flex-col gap-4 sm:max-w-2xl"
      showCloseButton={false}
    >
      <DialogHeader>
        <DialogTitle>Open remote repository</DialogTitle>
        <DialogDescription>
          Connects over SSH using your <code>~/.ssh/config</code> and agent. Git runs on the remote
          machine.
        </DialogDescription>
      </DialogHeader>

      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setPath(null);
          setChosenHost(host.trim() || null);
        }}
      >
        <div className="grid flex-1 gap-1.5">
          <Label htmlFor="ssh-host">Host</Label>
          <Input
            id="ssh-host"
            list="ssh-hosts"
            value={host}
            placeholder="user@hostname or ssh config alias"
            onChange={(e) => setHostDraft(e.target.value)}
            spellCheck={false}
          />
          <datalist id="ssh-hosts">
            {hosts.data?.map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>
        </div>
        <Button type="submit" variant="secondary">
          Connect
        </Button>
      </form>

      {browseHost && (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setPath(pathInput.trim() || null);
            }}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={!cwd || cwd === "/"}
              onClick={() => setPath(parent)}
              title="Parent directory"
            >
              <IconArrowUp />
            </Button>
            <Input
              value={pathInput}
              onChange={(e) => setPathDraft(e.target.value)}
              className="h-8 font-mono text-xs"
              spellCheck={false}
            />
          </form>
          <div className="bg-muted/30 h-72 min-h-0 overflow-y-auto rounded-xl border">
            {listing.isPending ? (
              <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
                <Spinner /> Connecting to {browseHost}…
              </div>
            ) : listing.error ? (
              <div className="text-destructive p-4 text-sm whitespace-pre-wrap">
                {listing.error.message}
              </div>
            ) : listing.data?.entries.length === 0 ? (
              <div className="text-muted-foreground p-4 text-sm">Empty directory</div>
            ) : (
              <ul className="py-1">
                {listing.data?.entries.map((e) => (
                  <li
                    key={e.name}
                    className={cn(
                      "hover:bg-muted flex h-7 cursor-default items-center gap-2 px-3 text-[13px] select-none",
                      e.name.startsWith(".") && "text-muted-foreground",
                    )}
                    onClick={() => (e.isRepo ? void open(join(e.name)) : setPath(join(e.name)))}
                  >
                    {e.isRepo ? (
                      <IconGitBranch className="text-primary size-4" />
                    ) : (
                      <IconFolder className="text-muted-foreground size-4" />
                    )}
                    <span className="flex-1 truncate">{e.name}</span>
                    {e.isRepo && (
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground text-[11px]"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          setPath(join(e.name));
                        }}
                      >
                        browse
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button disabled={!listing.data || opening} onClick={() => void open(cwd)}>
          {opening && <Spinner />}
          Open This Folder
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** Wires the global "open" menu commands. */
export function useOpenCommands() {
  const showRemote = useRemoteDialog((s) => s.show);
  useEvent("menu.command", ({ command }) => {
    const tabs = useTabs.getState();
    const blank = tabs.tabs.find((t) => t.key === tabs.active && t.repo === null)?.key;
    if (command === "open-repo") void pickLocalRepository(blank);
    else if (command === "open-remote-repo") showRemote(blank);
    else if (command === "close-tab" && tabs.active) tabs.closeTab(tabs.active);
    else if (command === "next-tab") tabs.cycle(1);
    else if (command === "prev-tab") tabs.cycle(-1);
  });
}
