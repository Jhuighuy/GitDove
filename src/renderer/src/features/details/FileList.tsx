import type { ChangeKind, ConflictCode, FileChange } from "@shared/domain";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { basename, dirname } from "@/lib/format";
import { cn } from "@/lib/utils";

const KIND: Record<ChangeKind, { letter: string; className: string; label: string }> = {
  added: { letter: "A", className: "text-emerald-500", label: "Added" },
  untracked: { letter: "U", className: "text-emerald-500", label: "Untracked" },
  modified: { letter: "M", className: "text-amber-500", label: "Modified" },
  deleted: { letter: "D", className: "text-red-500", label: "Deleted" },
  renamed: { letter: "R", className: "text-sky-500", label: "Renamed" },
  copied: { letter: "C", className: "text-sky-500", label: "Copied" },
  typechange: { letter: "T", className: "text-violet-500", label: "Type changed" },
  conflicted: { letter: "!", className: "text-red-500", label: "Conflicted" },
};

/** How a conflicted file conflicts, in the words of `git status`. */
export const CONFLICT: Record<ConflictCode, string> = {
  UU: "both modified",
  AA: "both added",
  DD: "both deleted",
  AU: "added by us",
  UA: "added by them",
  DU: "deleted by us",
  UD: "deleted by them",
};

export function ChangeBadge({ kind, title }: { kind: ChangeKind; title?: string }) {
  const k = KIND[kind];
  return (
    <span
      title={title ?? k.label}
      className={cn("w-3 shrink-0 text-center font-mono text-[11px] font-bold", k.className)}
    >
      {k.letter}
    </span>
  );
}

/** An action on a file, shown on its row when hovered (or selected in a focused list). */
export interface FileAction {
  readonly label: string;
  readonly icon: ReactNode;
  /** Keys (`KeyboardEvent.key`, lowercase) that run it on the selected file of a focused list. */
  readonly keys?: readonly string[];
  readonly run: (file: FileChange) => void;
}

export const ROW_HEIGHT = 24;

interface Props {
  readonly files: readonly FileChange[];
  readonly selectedPath: string | null;
  readonly onOpen: (file: FileChange) => void;
  /** Keep this stable (e.g. `useMemo`): rows render again when it changes. */
  readonly actions?: readonly FileAction[];
  /** Why the actions are disabled, if they are (e.g. another operation runs). */
  readonly disabledReason?: string;
  /**
   * The element that scrolls the list; it may hold other content above and below the list.
   * Pass it through state (a callback ref): the list renders its rows once it is there.
   */
  readonly scroller: HTMLElement | null;
  /** Height of sticky headers at the top of the scroll element, kept clear when scrolling to a file. */
  readonly stickyTop?: number;
  /** Accessible name of the list. */
  readonly label: string;
}

const keyOf = (f: FileChange) => `${f.oldPath ?? ""}:${f.path}`;

/**
 * Flat list of changed files ("path" view). Only the rows on screen are rendered. A focused list
 * moves the selection with the arrow keys, opens a file with Enter and runs actions with their keys.
 */
export const FileList = memo(function FileList({
  files,
  selectedPath,
  onOpen,
  actions,
  disabledReason,
  scroller,
  stickyTop = 0,
  label,
}: Props) {
  const id = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const margin = useScrollMargin(scroller, listRef);
  // Stable while the files are: a new function makes the virtualizer measure every row again.
  const getItemKey = useCallback((i: number) => keyOf(files[i]!), [files]);
  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => scroller,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    scrollMargin: margin,
    scrollPaddingStart: stickyTop,
    getItemKey,
  });

  const selected = useMemo(
    () => (selectedPath === null ? -1 : files.findIndex((f) => f.path === selectedPath)),
    [files, selectedPath],
  );

  // Keeps the selected file on screen, e.g. as the arrow keys move it through a diff.
  useEffect(() => {
    if (selected >= 0) virtualizer.scrollToIndex(selected, { align: "auto" });
  }, [selected, virtualizer]);

  // Rows get stable callbacks, so that they render again only when their own props change.
  const latest = useRef({ files, onOpen });
  latest.current = { files, onOpen };
  const open = useCallback((index: number) => {
    const file = latest.current.files[index];
    if (file) latest.current.onOpen(file);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey || files.length === 0) return;
    const last = files.length - 1;
    const step: Record<string, number> = {
      ArrowDown: selected < 0 ? 0 : Math.min(selected + 1, last),
      ArrowUp: selected < 0 ? 0 : Math.max(selected - 1, 0),
      Home: 0,
      End: last,
      PageDown: Math.min(Math.max(selected, 0) + 10, last),
      PageUp: Math.max(selected - 10, 0),
      Enter: Math.max(selected, 0),
      " ": Math.max(selected, 0),
    };
    const to = e.shiftKey ? undefined : step[e.key];
    if (to !== undefined) {
      e.preventDefault();
      open(to);
      return;
    }
    const action = actions?.find((a) => a.keys?.includes(e.key.toLowerCase()));
    if (action && selected >= 0) {
      e.preventDefault();
      if (!disabledReason) action.run(files[selected]!);
    }
  };

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={label}
      tabIndex={files.length > 0 ? 0 : -1}
      aria-activedescendant={selected >= 0 ? `${id}-${selected}` : undefined}
      className="group/list relative outline-none"
      style={{ height: virtualizer.getTotalSize() }}
      onKeyDown={onKeyDown}
    >
      {virtualizer.getVirtualItems().map((item) => (
        <FileRow
          key={item.key}
          id={`${id}-${item.index}`}
          index={item.index}
          top={item.start - margin}
          file={files[item.index]!}
          selected={item.index === selected}
          actions={actions}
          disabledReason={disabledReason}
          onOpen={open}
        />
      ))}
    </div>
  );
});

const FileRow = memo(function FileRow({
  id,
  index,
  top,
  file: f,
  selected,
  actions,
  disabledReason,
  onOpen,
}: {
  id: string;
  index: number;
  top: number;
  file: FileChange;
  selected: boolean;
  actions: readonly FileAction[] | undefined;
  disabledReason: string | undefined;
  onOpen: (index: number) => void;
}) {
  const dir = dirname(f.path);
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      className={cn(
        "group absolute inset-x-0 top-0 flex cursor-default items-center gap-2 px-3 text-[12px] select-none",
        selected
          ? "bg-primary/25 group-focus-visible/list:ring-ring group-focus-visible/list:ring-1 group-focus-visible/list:ring-inset"
          : "hover:bg-muted/60",
      )}
      style={{ height: ROW_HEIGHT, transform: `translateY(${top}px)` }}
      title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
      onClick={(e) => {
        // Clicking an action (even a disabled one) doesn't open the file.
        if (!(e.target as Element).closest("[data-row-actions]")) onOpen(index);
      }}
    >
      <ChangeBadge
        kind={f.kind}
        title={f.conflict ? `Conflicted: ${CONFLICT[f.conflict]}` : undefined}
      />
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="shrink-0 truncate">{basename(f.path)}</span>
        {dir && <span className="text-muted-foreground min-w-0 truncate text-[11px]">{dir}</span>}
      </span>
      {f.conflict && (
        <span className="shrink-0 text-[11px] text-red-500">{CONFLICT[f.conflict]}</span>
      )}
      {actions && actions.length > 0 && (
        <span
          data-row-actions
          className={cn(
            "hidden shrink-0 items-center gap-0.5 group-hover:flex",
            selected && "group-focus-visible/list:flex",
          )}
        >
          {actions.map((a) => (
            // A wrapper shows the title: disabled buttons get no pointer events.
            <span
              key={a.label}
              className="flex"
              title={
                disabledReason ?? (a.keys?.[0] ? `${a.label} (${keyLabel(a.keys[0])})` : a.label)
              }
            >
              <button
                type="button"
                tabIndex={-1}
                aria-label={a.label}
                disabled={disabledReason !== undefined}
                className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-5 items-center justify-center rounded disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5"
                onClick={() => a.run(f)}
              >
                {a.icon}
              </button>
            </span>
          ))}
        </span>
      )}
      {(f.additions !== null || f.deletions !== null) && (
        <span className="shrink-0 font-mono text-[10px] tabular-nums">
          {f.additions ? <span className="text-emerald-500">+{f.additions}</span> : null}{" "}
          {f.deletions ? <span className="text-red-500">-{f.deletions}</span> : null}
        </span>
      )}
    </div>
  );
});

/** "N files changed", counting files left out of a truncated list. */
export const filesChanged = (listed: number, total = listed) =>
  `${total.toLocaleString()} ${total === 1 ? "file" : "files"} changed`;

/** Says how many changed files a truncated list leaves out. */
export function MoreFiles({ listed, total }: { listed: number; total: number | undefined }) {
  const more = total === undefined ? 0 : total - listed;
  return (
    <div className="text-muted-foreground px-3 py-1.5 text-[11px]" title="Too many files to list">
      {more > 0 ? `…and ${more.toLocaleString()} more files` : "…and more files"}
    </div>
  );
}

const keyLabel = (key: string) =>
  key === "delete" ? "Delete" : key === "backspace" ? "Backspace" : key.toUpperCase();

/**
 * Where the list starts in its scroll element's content: the list may follow other content
 * (e.g. another list), whose size changes move it.
 */
function useScrollMargin(
  scroller: HTMLElement | null,
  listRef: React.RefObject<HTMLElement | null>,
): number {
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!scroller || !list) return;
    const measure = () => {
      const top =
        list.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      setMargin((m) => (Math.abs(m - top) < 0.5 ? m : Math.round(top)));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    // Content above the list changing size changes the size of the whole content too.
    const observer = new ResizeObserver(measure);
    for (const child of scroller.children) observer.observe(child);
    observer.observe(list);
    return () => observer.disconnect();
  }, [scroller, listRef]);
  return margin;
}
