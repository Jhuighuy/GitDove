import { repoDisplayName, repoLocationOf } from "@shared/domain";
import { IconFolder, IconPlus, IconServer, IconX } from "@tabler/icons-react";
import { useState } from "react";
import { isMac } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useTabs } from "@/stores/tabs";

const drag = { WebkitAppRegion: "drag" } as React.CSSProperties;
const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

/** How far the pointer moves before a press on a tab becomes a drag, in pixels. */
const DRAG_THRESHOLD = 4;

export function TabBar() {
  const { tabs, active, activate, closeTab, newTab, moveTab } = useTabs();
  const [dragging, setDragging] = useState<string | null>(null);

  /** Drags a tab along the bar: it takes the place of the tabs whose middle it passes. */
  const startDrag = (e: React.PointerEvent<HTMLElement>, key: string) => {
    if (e.button !== 0) return;
    const bar = e.currentTarget.parentElement!;
    const startX = e.clientX;
    let started = false;
    const move = (ev: PointerEvent) => {
      if (!started && Math.abs(ev.clientX - startX) < DRAG_THRESHOLD) return;
      started = true;
      setDragging(key);
      const others = [...bar.querySelectorAll<HTMLElement>('[role="tab"]')].filter(
        (el) => el.dataset.key !== key,
      );
      const index = others.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left + r.width / 2 < ev.clientX;
      }).length;
      moveTab(key, index);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setDragging(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

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
            data-key={tab.key}
            aria-selected={isActive}
            title={loc ? (loc.kind === "ssh" ? `${loc.host}:${loc.path}` : loc.path) : "New tab"}
            className={cn(
              "group relative flex h-8 max-w-56 min-w-28 cursor-default items-center gap-1.5 rounded-t-lg px-3 text-[12px] select-none",
              isActive
                ? "bg-background text-foreground"
                : "text-muted-foreground hover:bg-background/50 hover:text-foreground",
              dragging === tab.key && "z-10 shadow-md",
            )}
            onPointerDown={(e) => startDrag(e, tab.key)}
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
              onPointerDown={(e) => e.stopPropagation()}
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
