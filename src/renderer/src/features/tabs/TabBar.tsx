import { repoDisplayName, repoLocationOf } from "@shared/domain";
import { IconFolder, IconPlus, IconServer, IconX } from "@tabler/icons-react";
import { useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { isMac } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useTabs } from "@/stores/tabs";

const drag = { WebkitAppRegion: "drag" } as React.CSSProperties;
const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

/**
 * The window's tab bar, which is also its title bar: the space around the tabs drags the
 * window (and gets no mouse events, so double-clicking it is the system's).
 */
export function TabBar() {
  const { tabs, active, activate, closeTab, newTab } = useTabs(
    useShallow((s) => ({
      tabs: s.tabs,
      active: s.active,
      activate: s.activate,
      closeTab: s.closeTab,
      newTab: s.newTab,
    })),
  );
  const list = useRef<HTMLDivElement>(null);

  /** Arrow keys, Home and End move between tabs (activating them); Delete closes one. */
  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    const key = tabs[index]!.key;
    const to =
      e.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : e.key === "ArrowLeft"
          ? (index - 1 + tabs.length) % tabs.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? tabs.length - 1
              : null;
    if (to !== null) {
      e.preventDefault();
      activate(tabs[to]!.key);
      list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[to]?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate(key);
    } else if (e.key === "Delete") {
      e.preventDefault();
      closeTab(key);
    }
  };

  return (
    <div
      className={cn(
        "bg-sidebar flex h-10 shrink-0 items-end gap-0.5 border-b",
        isMac ? "pl-20" : "pl-2",
        !isMac && "pr-36",
      )}
      style={drag}
    >
      <div
        ref={list}
        role="tablist"
        aria-label="Open repositories"
        className="flex min-w-0 items-end gap-0.5"
      >
        {tabs.map((tab, index) => {
          const loc = tab.repo ? repoLocationOf(tab.repo) : null;
          const isActive = tab.key === active;
          return (
            <div
              key={tab.key}
              style={noDrag}
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              title={loc ? (loc.kind === "ssh" ? `${loc.host}:${loc.path}` : loc.path) : "New tab"}
              className={cn(
                "group focus-visible:ring-ring/50 relative flex h-8 max-w-56 min-w-28 cursor-default items-center gap-1.5 rounded-t-lg px-3 text-[12px] outline-none select-none focus-visible:ring-2 focus-visible:ring-inset",
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
              onKeyDown={(e) => onKeyDown(e, index)}
            >
              {loc?.kind === "ssh" ? (
                <IconServer className="size-3.5 shrink-0 text-sky-400" />
              ) : (
                <IconFolder className="size-3.5 shrink-0 opacity-70" />
              )}
              <span className="min-w-0 flex-1 truncate font-medium">
                {loc ? repoDisplayName(loc) : "New Tab"}
              </span>
              {/* Delete closes the focused tab, so the button stays out of the tab order. */}
              <button
                type="button"
                tabIndex={-1}
                className={cn(
                  "hover:bg-muted -mr-1 flex size-4 shrink-0 items-center justify-center rounded",
                  isActive
                    ? "opacity-70"
                    : "opacity-0 group-hover:opacity-70 group-focus-visible:opacity-70",
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
      </div>
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
