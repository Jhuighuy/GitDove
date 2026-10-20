import { repoDisplayName, repoLocationOf } from "@shared/domain";
import { IconFolder, IconPlus, IconServer, IconX } from "@tabler/icons-react";
import { isMac } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useTabs } from "@/stores/tabs";

const drag = { WebkitAppRegion: "drag" } as React.CSSProperties;
const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

export function TabBar() {
  const { tabs, active, activate, closeTab, newTab } = useTabs();

  return (
    <div
      className={cn(
        "bg-sidebar flex h-10 shrink-0 items-end gap-0.5 border-b",
        isMac ? "pl-20" : "pl-2",
        !isMac && "pr-36",
      )}
      style={drag}
      onDoubleClick={(e) => {
        if (e.target === e.currentTarget) newTab();
      }}
    >
      {tabs.map((tab) => {
        const loc = tab.repo ? repoLocationOf(tab.repo) : null;
        const isActive = tab.key === active;
        return (
          <div
            key={tab.key}
            style={noDrag}
            role="tab"
            aria-selected={isActive}
            title={loc ? (loc.kind === "ssh" ? `${loc.host}:${loc.path}` : loc.path) : "New tab"}
            className={cn(
              "group relative flex h-8 max-w-56 min-w-28 cursor-default items-center gap-1.5 rounded-t-lg px-3 text-[12px] select-none",
              isActive
                ? "bg-background text-foreground"
                : "text-muted-foreground hover:bg-background/50 hover:text-foreground",
            )}
            onMouseDown={(e) => {
              if (e.button === 0) activate(tab.key);
              if (e.button === 1) {
                e.preventDefault();
                closeTab(tab.key);
              }
            }}
          >
            {loc?.kind === "ssh" ? (
              <IconServer className="size-3.5 shrink-0 text-sky-400" />
            ) : (
              <IconFolder className="size-3.5 shrink-0 opacity-70" />
            )}
            <span className="min-w-0 flex-1 truncate font-medium">
              {loc ? repoDisplayName(loc) : "New Tab"}
            </span>
            <button
              type="button"
              className={cn(
                "hover:bg-muted -mr-1 flex size-4 shrink-0 items-center justify-center rounded",
                isActive ? "opacity-70" : "opacity-0 group-hover:opacity-70",
              )}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => closeTab(tab.key)}
              aria-label="Close tab"
            >
              <IconX className="size-3" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        style={noDrag}
        className="text-muted-foreground hover:bg-background/50 hover:text-foreground mb-1 flex size-7 items-center justify-center rounded-md"
        onClick={newTab}
        aria-label="New tab"
      >
        <IconPlus className="size-4" />
      </button>
    </div>
  );
}
