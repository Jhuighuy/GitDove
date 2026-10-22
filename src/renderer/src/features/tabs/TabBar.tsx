import { repoDisplayName, repoLocationOf } from "@shared/domain";
import { IconFolder, IconPlus, IconServer, IconX } from "@tabler/icons-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { isMac } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useTabs } from "@/stores/tabs";

const drag = { WebkitAppRegion: "drag" } as React.CSSProperties;
const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

/** How far the pointer moves before a press on a tab becomes a drag, in pixels. */
const DRAG_THRESHOLD = 4;

/**
 * The window's tab bar, which is also its title bar: the space around the tabs drags the
 * window (and gets no mouse events, so double-clicking it is the system's).
 */
export function TabBar() {
  const { tabs, active, activate, closeTab, newTab, moveTab } = useTabs(
    useShallow((s) => ({
      tabs: s.tabs,
      active: s.active,
      activate: s.activate,
      closeTab: s.closeTab,
      newTab: s.newTab,
      moveTab: s.moveTab,
    })),
  );
  const list = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const focusTab = (index: number) =>
    list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[index]?.focus();

  // A tab closed from the keyboard hands the focus on to the tab shown next.
  const refocus = useRef(false);
  useLayoutEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    list.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  });

  /**
   * Arrow keys, Home and End move between tabs (activating them); with Shift, the arrow keys
   * move the tab itself along the bar (as dragging it does). Delete (or Backspace, the delete
   * key of a Mac keyboard) closes one.
   */
  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    const key = tabs[index]!.key;
    if (e.shiftKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      e.preventDefault();
      const to = index + (e.key === "ArrowRight" ? 1 : -1);
      if (to < 0 || to >= tabs.length) return;
      moveTab(key, to);
      // The tab element is kept (tabs are keyed), and keeps focus.
      return;
    }
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
      focusTab(to);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate(key);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      refocus.current = true;
      closeTab(key);
    }
  };

  /** Drags a tab along the bar: it takes the place of the tabs whose middle it passes. */
  const startDrag = (e: React.PointerEvent<HTMLElement>, key: string) => {
    if (e.button !== 0) return;
    const bar = list.current;
    if (!bar) return;
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
      window.removeEventListener("blur", up);
      setDragging(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    // Released outside the window, the pointer may never come back up here.
    window.addEventListener("blur", up);
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
              data-key={tab.key}
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              title={loc ? (loc.kind === "ssh" ? `${loc.host}:${loc.path}` : loc.path) : "New tab"}
              className={cn(
                "group focus-visible:ring-ring/50 relative flex h-8 max-w-56 min-w-28 cursor-default items-center gap-1.5 rounded-t-lg px-3 text-[12px] outline-none select-none focus-visible:ring-2 focus-visible:ring-inset",
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
              onKeyDown={(e) => onKeyDown(e, index)}
            >
              {loc?.kind === "ssh" ? (
                <IconServer className="size-3.5 shrink-0 text-primary" />
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
                onPointerDown={(e) => e.stopPropagation()}
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
