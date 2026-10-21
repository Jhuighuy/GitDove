import type { GraphRow, Ref, RepoId } from "@shared/domain";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AvatarProvider } from "@shared/avatars";
import { Avatar, useAvatarProviders } from "@/components/Avatar";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Spinner } from "@/components/ui/spinner";
import { api, isMac } from "@/lib/api";
import { absoluteTime, relativeTime, shortHash } from "@/lib/format";
import {
  useGraphInfo,
  useGraphRows,
  useRefs,
  useRefsByHash,
  useRepoInfo,
  useStatus,
} from "@/lib/queries";
import { laneColor } from "@/lib/graph-colors";
import { cn } from "@/lib/utils";
import {
  type PickedCommit,
  type Selection,
  selectedHashes,
  useRepoUi,
  useRepoUiStore,
} from "@/stores/repo-ui";
import { commands } from "../commands";
import { CommitContextMenu, type MenuTarget } from "./CommitContextMenu";
import {
  GraphCell,
  graphWidthFor,
  LANE_WIDTH,
  ROW_HEIGHT,
  rowGraphWidth,
  WipGraphCell,
} from "./GraphCell";
import { RefPills } from "./RefPills";
import { rangeIndexes, selectionOf, toggled } from "./selection";

interface ColumnsState {
  readonly refs: number;
  readonly graph: number | null;
  readonly author: number;
  readonly date: number;
  /** Sets a column's width; `null` sizes the graph column to fit its lanes again. */
  set(col: "refs" | "graph" | "author" | "date", width: number | null): void;
}

/**
 * Unless resized, the graph column fits the lanes of the rows on screen, between these many
 * lanes; wider rows are cut off (and shaded).
 */
const MIN_AUTO_LANES = 3;
const MAX_AUTO_LANES = 12;

/**
 * A shadow over the graph column's right edge (above the lanes) while it cuts off rows on
 * screen. Every row's cell gets it, so it reads as one edge rather than per-row marks.
 */
const CLIPPED =
  "after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-3 after:bg-linear-to-l after:from-black/10 after:to-transparent dark:after:from-black/80";

const useColumns = create<ColumnsState>()(
  persist(
    (set) => ({
      refs: 170,
      graph: null,
      author: 140,
      date: 104,
      set: (col, width) => set({ [col]: width }),
    }),
    { name: "gitdove.graph-columns" },
  ),
);

const EMPTY_REFS: readonly Ref[] = [];

export function CommitGraph({ repo }: { repo: RepoId }) {
  const { data: info, isPending, error } = useGraphInfo(repo);
  const { data: status } = useStatus(repo);
  const { data: repoInfo } = useRepoInfo(repo);
  const { data: refsData } = useRefs(repo);
  const refsByHash = useRefsByHash(repo);
  const { selection, revealToken } = useRepoUi(repo);
  const select = useRepoUiStore((s) => s.select);
  const columns = useColumns();
  const avatarProviders = useAvatarProviders(repo);

  const changes = status
    ? status.staged.length + status.unstaged.length + status.conflicted.length
    : 0;
  const offset = changes > 0 ? 1 : 0;
  const total = (info?.count ?? 0) + offset;
  const headHash = repoInfo?.head.hash ?? null;
  const stashes = useMemo(() => new Set(refsData?.stashes.map((s) => s.hash) ?? []), [refsData]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 24,
  });
  const items = virtualizer.getVirtualItems();
  const firstIndex = Math.max(0, (items[0]?.index ?? 0) - offset);
  const lastIndex = Math.max(0, (items.at(-1)?.index ?? 0) - offset + 1);
  const rows = useGraphRows(repo, info, firstIndex, lastIndex);
  const headRow = rows.get(0);

  // Fit the lanes on screen. The width only grows while scrolling, so the columns don't jump
  // back and forth; double-clicking the column border fits it to the rows on screen again.
  // Only rows in the viewport count, not the overscan rendered around it.
  const top = virtualizer.scrollOffset ?? 0;
  const bottom = top + (virtualizer.scrollRect?.height ?? Infinity);
  let widestRow = 0;
  for (const item of items) {
    if (item.end <= top || item.start >= bottom) continue;
    const row = rows.get(item.index - offset);
    if (row) widestRow = Math.max(widestRow, rowGraphWidth(row));
  }
  const visibleWidth = Math.max(widestRow, graphWidthFor(MIN_AUTO_LANES));
  const [fitWidth, setFitWidth] = useState(0);
  useLayoutEffect(() => {
    if (visibleWidth > fitWidth) setFitWidth(visibleWidth);
  }, [visibleWidth, fitWidth]);
  const graphWidth =
    columns.graph ?? Math.min(Math.max(fitWidth, visibleWidth), graphWidthFor(MAX_AUTO_LANES));
  const clipped = widestRow > graphWidth;
  const refit = () => {
    columns.set("graph", null);
    setFitWidth(0);
  };

  // Scroll the selected commit into view when asked to (e.g. from the sidebar).
  useEffect(() => {
    if (!revealToken || selection?.kind !== "commit" || !info) return;
    let cancelled = false;
    void api("repo.findCommit", repo, info.version, selection.hash).then(
      (index) => {
        if (!cancelled && index >= 0)
          virtualizer.scrollToIndex(index + offset, { align: "center" });
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealToken]);

  const hashes = useMemo(() => selectedHashes(selection), [selection]);
  // Arrows move on from the commit last clicked.
  const anchor =
    selection?.kind === "commit"
      ? selection.hash
      : selection?.kind === "commits"
        ? selection.anchor
        : null;
  const selectedIndex = useMemo(() => {
    if (selection?.kind === "wip") return 0;
    if (anchor === null) return -1;
    for (const [i, r] of rows) if (r.hash === anchor) return i + offset;
    return -1;
  }, [selection, anchor, rows, offset]);

  // The platform key adds or removes a commit, Shift selects a range from the last clicked.
  const pressCount = useRef(0);
  const press = async (row: GraphRow, index: number, e: React.MouseEvent) => {
    const single = { kind: "commit", hash: row.hash } as const;
    const toggle = isMac ? e.metaKey : e.ctrlKey;
    if (!info || !(toggle || e.shiftKey) || anchor === null) return select(repo, single);
    // Rows may have to be fetched first: drop the result if the selection changed meanwhile.
    const seq = ++pressCount.current;
    const current = () => useRepoUiStore.getState().byRepo[repo]?.selection ?? null;
    const before = current();
    const finish = (next: Selection) => {
      if (pressCount.current === seq && current() === before) select(repo, next);
    };
    // A commit far off screen may not be loaded: ask for it.
    const loaded = (i: number) => rows.get(i);
    const fetchRows = async (from: number, to: number) => {
      const out = new Map<number, GraphRow>();
      let missing = false;
      for (let i = from; i <= to; i++) {
        const r = loaded(i);
        if (r) out.set(i, r);
        else missing = true;
      }
      if (missing) {
        const fetched = await api("repo.graphRows", repo, info.version, from, to + 1);
        fetched.forEach((r, j) => out.set(from + j, r));
      }
      return out;
    };
    const indexOf = async (hash: string) => {
      for (const [i, r] of rows) if (r.hash === hash) return i;
      return api("repo.findCommit", repo, info.version, hash);
    };
    try {
      if (toggle) {
        let picked: readonly PickedCommit[] = [];
        if (selection?.kind === "commits") picked = selection.commits;
        else if (selection?.kind === "commit") {
          const i = await indexOf(selection.hash);
          const r = i >= 0 ? (await fetchRows(i, i)).get(i) : undefined;
          if (r) picked = [{ index: i, row: r }];
        }
        finish(selectionOf(toggled(picked, { index, row }), row.hash) ?? single);
      } else {
        const a = await indexOf(anchor);
        if (a < 0) return finish(single);
        const [from, to] = rangeIndexes(a, index);
        const range = [...(await fetchRows(from, to))].map(([i, r]) => ({ index: i, row: r }));
        finish(selectionOf(range, anchor) ?? single);
      }
    } catch {
      finish(single);
    }
  };
  const pressRef = useRef(press);
  pressRef.current = press;
  const onPress = useCallback(
    (row: GraphRow, index: number, e: React.MouseEvent) => void pressRef.current(row, index, e),
    [],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const base = selectedIndex < 0 ? -1 : selectedIndex;
    const next = Math.min(total - 1, Math.max(0, base + (e.key === "ArrowDown" ? 1 : -1)));
    if (next < offset) {
      select(repo, { kind: "wip" });
    } else {
      const row = rows.get(next - offset);
      if (row) select(repo, { kind: "commit", hash: row.hash });
    }
    virtualizer.scrollToIndex(next, { align: "auto" });
  };

  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const onRowContextMenu = useCallback(
    (row: GraphRow | null) => {
      if (row) {
        select(repo, { kind: "commit", hash: row.hash });
        setMenu({ kind: "commit", row, refs: refsByHash.get(row.hash) ?? [], stashIndex: null });
      } else {
        select(repo, { kind: "wip" });
        setMenu({ kind: "wip" });
      }
    },
    [repo, refsByHash, select],
  );

  if (error && !info) {
    return (
      <div className="text-destructive flex h-full items-center justify-center p-8 text-sm">
        {error.message}
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <Header graphWidth={graphWidth} onFitGraph={refit} />
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div
              ref={scrollRef}
              tabIndex={0}
              onKeyDown={onKeyDown}
              className="relative min-h-0 flex-1 overflow-auto outline-none [contain:strict]"
            />
          }
        >
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {items.map((item) => {
              const index = item.index - offset;
              const style = { transform: `translateY(${item.start}px)`, height: ROW_HEIGHT };
              if (index < 0) {
                return (
                  <WipRow
                    key="wip"
                    style={style}
                    changes={changes}
                    lane={headRow?.hash === headHash ? (headRow?.lane ?? 0) : 0}
                    color={headRow?.hash === headHash ? (headRow?.color ?? 0) : 0}
                    graphWidth={graphWidth}
                    clipped={clipped}
                    selected={selection?.kind === "wip"}
                    onSelect={() => select(repo, { kind: "wip" })}
                    onContextMenu={() => onRowContextMenu(null)}
                  />
                );
              }
              const row = rows.get(index);
              if (!row) return <PlaceholderRow key={item.key} style={style} />;
              return (
                <CommitRow
                  key={row.hash}
                  repo={repo}
                  style={style}
                  row={row}
                  refs={refsByHash.get(row.hash) ?? EMPTY_REFS}
                  graphWidth={graphWidth}
                  clipped={clipped}
                  isHead={row.hash === headHash}
                  isStash={stashes.has(row.hash)}
                  wipAbove={offset > 0 && index === 0 && row.hash === headHash}
                  index={index}
                  selected={hashes.has(row.hash)}
                  onPress={onPress}
                  onContextMenu={onRowContextMenu}
                  avatarProviders={avatarProviders}
                />
              );
            })}
          </div>
          {(isPending || (info && !info.complete && info.count === 0)) && (
            <div className="text-muted-foreground absolute inset-0 flex items-center justify-center gap-2 text-sm">
              <Spinner /> Loading history…
            </div>
          )}
          {info?.complete && info.count === 0 && offset === 0 && (
            <div className="text-muted-foreground absolute inset-0 flex items-center justify-center text-sm">
              No commits yet
            </div>
          )}
        </ContextMenuTrigger>
        <CommitContextMenu repo={repo} target={menu} stashes={refsData?.stashes ?? []} />
      </ContextMenu>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header with resizable columns
// ---------------------------------------------------------------------------

function Header({ graphWidth, onFitGraph }: { graphWidth: number; onFitGraph: () => void }) {
  const columns = useColumns();
  return (
    <div className="text-muted-foreground bg-background flex h-7 shrink-0 items-center border-b text-[10px] font-semibold tracking-wider uppercase select-none">
      <div className="relative shrink-0 truncate px-3" style={{ width: columns.refs }}>
        Branch / Tag
        <Resizer width={columns.refs} min={60} onResize={(w) => columns.set("refs", w)} />
      </div>
      <div className="relative shrink-0 truncate px-2" style={{ width: graphWidth }}>
        Graph
        <Resizer
          width={graphWidth}
          min={LANE_WIDTH * 2}
          onResize={(w) => columns.set("graph", w)}
          onReset={onFitGraph}
          title="Drag to resize, double-click to fit the lanes"
        />
      </div>
      <div className="min-w-0 flex-1 truncate px-2">Commit message</div>
      <div className="relative shrink-0 truncate px-2" style={{ width: columns.author }}>
        <Resizer left width={columns.author} min={40} onResize={(w) => columns.set("author", w)} />
        Author
      </div>
      <div className="relative shrink-0 truncate px-2" style={{ width: columns.date }}>
        <Resizer left width={columns.date} min={40} onResize={(w) => columns.set("date", w)} />
        Date
      </div>
      <div className="w-[76px] shrink-0 truncate px-2">SHA</div>
    </div>
  );
}

/** Drag handle on a column's edge; `left` handles grow the column when dragged left. */
function Resizer({
  width,
  min,
  onResize,
  onReset,
  left,
  title,
}: {
  width: number;
  min: number;
  onResize: (width: number) => void;
  onReset?: () => void;
  left?: boolean;
  title?: string;
}) {
  return (
    <div
      className={cn(
        "hover:bg-primary/60 absolute top-0 z-10 h-full w-1 cursor-col-resize",
        left ? "left-0" : "right-0",
      )}
      title={title}
      onDoubleClick={onReset}
      onPointerDown={(e) => {
        e.preventDefault();
        const target = e.currentTarget;
        target.setPointerCapture(e.pointerId);
        // Measure from where the drag started: this handler outlives the render it came from.
        const start = width;
        const x0 = e.clientX;
        const move = (ev: PointerEvent) => {
          const delta = ev.clientX - x0;
          onResize(Math.max(min, start + (left ? -delta : delta)));
        };
        const up = () => {
          target.removeEventListener("pointermove", move);
          target.removeEventListener("pointerup", up);
        };
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", up);
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const rowClass = (selected: boolean) =>
  cn(
    "absolute top-0 left-0 flex w-full items-center text-[13px] select-none",
    selected ? "bg-primary/25" : "hover:bg-muted/60",
  );

interface CommitRowProps {
  readonly repo: RepoId;
  readonly style: React.CSSProperties;
  readonly row: GraphRow;
  readonly refs: readonly Ref[];
  readonly graphWidth: number;
  /** The graph column cuts off rows on screen. */
  readonly clipped: boolean;
  readonly isHead: boolean;
  readonly isStash: boolean;
  readonly wipAbove: boolean;
  readonly index: number;
  readonly selected: boolean;
  readonly onPress: (row: GraphRow, index: number, e: React.MouseEvent) => void;
  readonly onContextMenu: (row: GraphRow) => void;
  readonly avatarProviders: readonly AvatarProvider[];
}

const CommitRow = memo(function CommitRow(p: CommitRowProps) {
  const columns = useColumns();
  const { row } = p;
  // Stashes have no pill.
  const hasPills = p.refs.some((r) => r.kind !== "stash");
  return (
    <div
      className={rowClass(p.selected)}
      style={p.style}
      onMouseDown={(e) => {
        if (e.button === 0) p.onPress(row, p.index, e);
      }}
      onContextMenu={() => p.onContextMenu(row)}
    >
      <div
        className="flex shrink-0 items-center overflow-hidden pl-2"
        style={{ width: columns.refs }}
      >
        <RefPills
          refs={p.refs}
          color={row.color}
          onDoubleClick={(r) => void commands.checkoutRef(p.repo, r)}
        />
        {hasPills && (
          <div className="h-0.5 min-w-2 flex-1" style={{ backgroundColor: laneColor(row.color) }} />
        )}
      </div>
      <div
        className={cn("relative shrink-0 overflow-hidden", p.clipped && CLIPPED)}
        style={{ width: p.graphWidth }}
      >
        <GraphCell
          row={row}
          width={p.graphWidth}
          isHead={p.isHead}
          isStash={p.isStash}
          wipAbove={p.wipAbove}
          refLine={hasPills}
        />
      </div>
      <div
        className={cn(
          "min-w-0 flex-1 truncate px-2",
          p.isStash && "text-muted-foreground italic",
          p.isHead && "font-medium",
        )}
      >
        {row.subject}
      </div>
      <div
        className="flex shrink-0 items-center gap-1.5 overflow-hidden px-2"
        style={{ width: columns.author }}
      >
        <Avatar name={row.authorName} email={row.authorEmail} providers={p.avatarProviders} />
        <span className="text-muted-foreground truncate text-xs">{row.authorName}</span>
      </div>
      <div
        className="text-muted-foreground shrink-0 truncate px-2 text-xs tabular-nums"
        style={{ width: columns.date }}
        title={absoluteTime(row.authorTime)}
      >
        {relativeTime(row.authorTime)}
      </div>
      <div className="text-muted-foreground w-[76px] shrink-0 truncate px-2 font-mono text-[11px]">
        {shortHash(row.hash)}
      </div>
    </div>
  );
});

function WipRow(p: {
  style: React.CSSProperties;
  changes: number;
  lane: number;
  color: number;
  graphWidth: number;
  clipped: boolean;
  selected: boolean;
  onSelect: () => void;
  onContextMenu: () => void;
}) {
  const columns = useColumns();
  return (
    <div
      className={rowClass(p.selected)}
      style={p.style}
      onMouseDown={(e) => e.button === 0 && p.onSelect()}
      onContextMenu={p.onContextMenu}
    >
      <div className="shrink-0" style={{ width: columns.refs }} />
      <div
        className={cn("relative shrink-0 overflow-hidden", p.clipped && CLIPPED)}
        style={{ width: p.graphWidth }}
      >
        <WipGraphCell lane={p.lane} color={p.color} width={p.graphWidth} />
      </div>
      <div className="text-muted-foreground flex min-w-0 flex-1 items-center gap-2 px-2 italic">
        <span>{"// WIP"}</span>
        <span className="bg-muted rounded px-1.5 text-[11px] not-italic tabular-nums">
          {p.changes} {p.changes === 1 ? "change" : "changes"}
        </span>
      </div>
    </div>
  );
}

function PlaceholderRow({ style }: { style: React.CSSProperties }) {
  return (
    <div className="absolute top-0 left-0 flex w-full items-center px-3" style={style}>
      <div className="bg-muted/50 h-2.5 w-1/3 rounded" />
    </div>
  );
}
