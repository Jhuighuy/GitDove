import { Menu } from "@base-ui/react/menu";
import type { EditCommand } from "@shared/ipc";
import { useEffect, useRef, useState } from "react";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "@/components/ui/context-menu";
import { api, isMac, modKey } from "@/lib/api";
import { cn } from "@/lib/utils";

type Field = HTMLInputElement | HTMLTextAreaElement;

/** Inputs that hold text the user types; checkboxes, sliders and the like do not. */
const TEXT_INPUTS = new Set(["text", "search", "url", "email", "tel", "number", "password"]);

const isField = (el: Element): el is Field =>
  el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && TEXT_INPUTS.has(el.type));

interface Target {
  readonly x: number;
  readonly y: number;
  /** The field right-clicked, or null for selected text elsewhere. */
  readonly field: Field | null;
  readonly editable: boolean;
  readonly hasSelection: boolean;
  /** Where the selection was, to put it back after the menu took focus. */
  readonly restore: () => void;
}

/** What a right click on `el` offers, or null when it has no text to edit or copy. */
const targetOf = (el: Element, x: number, y: number): Target | null => {
  const field = el.closest("input, textarea");
  if (field && isField(field)) {
    if (field.disabled) return null;
    const { selectionStart: start, selectionEnd: end, selectionDirection: dir } = field;
    return {
      x,
      y,
      field,
      editable: !field.readOnly,
      // Number inputs have no selection API.
      hasSelection: start === null || start !== end,
      restore: () => {
        field.focus();
        if (start !== null && end !== null) field.setSelectionRange(start, end, dir ?? undefined);
      },
    };
  }
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  return {
    x,
    y,
    field: null,
    editable: false,
    hasSelection: true,
    restore: () => {
      sel.removeAllRanges();
      sel.addRange(range);
    },
  };
};

const SHORTCUTS: Record<EditCommand, string> = {
  undo: `${modKey}Z`,
  redo: isMac ? "⇧⌘Z" : "Ctrl+Y",
  cut: `${modKey}X`,
  copy: `${modKey}C`,
  paste: `${modKey}V`,
  selectAll: `${modKey}A`,
};

/**
 * The context menu of text fields (cut, copy, paste and the like) and of selected text, for the
 * whole window. Menus of their own (a commit's, say) take precedence.
 */
export function TextContextMenu() {
  const [target, setTarget] = useState<Target | null>(null);
  const [open, setOpen] = useState(false);
  const pending = useRef<EditCommand | null>(null);
  /** Whether the menu was dismissed by clicking or tabbing to something else. */
  const clickedAway = useRef(false);

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if (e.defaultPrevented || !(e.target instanceof Element)) return;
      const next = targetOf(e.target, e.clientX, e.clientY);
      if (!next) return;
      e.preventDefault();
      setTarget(next);
      setOpen(true);
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // A command runs once the menu has closed, on the field (or selection) it was opened for:
  // the menu held the focus meanwhile.
  const run = (command: EditCommand) => {
    pending.current = command;
    setOpen(false);
  };
  const onOpenChange = (isOpen: boolean, details: Menu.Root.ChangeEventDetails) => {
    clickedAway.current = details.reason === "outside-press" || details.reason === "focus-out";
    setOpen(isOpen);
  };
  // Dismissed with Escape, the field gets its focus back; clicked away, focus stays where it went.
  const onOpenChangeComplete = (isOpen: boolean) => {
    const command = pending.current;
    pending.current = null;
    if (isOpen || !target) return;
    if (command || (target.field && !clickedAway.current)) target.restore();
    if (command) void api("app.edit", command).catch(() => {});
  };

  const anchor = target && {
    getBoundingClientRect: () =>
      DOMRect.fromRect({ x: target.x, y: target.y, width: 0, height: 0 }),
  };
  const item = (command: EditCommand, label: string, disabled = false) => (
    <ContextMenuItem disabled={disabled} onClick={() => run(command)}>
      {label}
      <ContextMenuShortcut>{SHORTCUTS[command]}</ContextMenuShortcut>
    </ContextMenuItem>
  );

  return (
    <Menu.Root
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
      modal={false}
    >
      <Menu.Portal>
        <Menu.Positioner
          anchor={anchor}
          side="right"
          align="start"
          sideOffset={2}
          className="isolate z-50 outline-none"
        >
          <Menu.Popup
            finalFocus={false}
            aria-label="Edit"
            className={cn(
              "bg-popover text-popover-foreground ring-foreground/5 dark:ring-foreground/10 z-50 min-w-48 origin-(--transform-origin) rounded-3xl p-1.5 shadow-lg ring-1 outline-none",
              "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 duration-100",
            )}
          >
            {target?.editable && (
              <>
                {item("undo", "Undo")}
                {item("redo", "Redo")}
                <ContextMenuSeparator />
                {item("cut", "Cut", !target.hasSelection)}
              </>
            )}
            {item("copy", "Copy", !target?.hasSelection)}
            {target?.editable && item("paste", "Paste")}
            {target?.field && (
              <>
                <ContextMenuSeparator />
                {item("selectAll", "Select All")}
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
