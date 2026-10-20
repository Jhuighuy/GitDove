import type { GraphRow, Ref, RepoId } from "@shared/domain";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AvatarProvider } from "@shared/avatars";
import { Avatar, useAvatarProviders } from "@/components/Avatar";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { absoluteTime, relativeTime, shortHash } from "@/lib/format";
import {
  useGraphInfo,
  useGraphRows,
  useRefs,
  useRefsByHash,
  useRepoInfo,
  useStatus,
} from "@/lib/queries";
import { cn } from "@/lib/utils";
import { type Selection, useRepoUi, useRepoUiStore } from "@/stores/repo-ui";
import { commands } from "../commands";
import { CommitContextMenu, type MenuTarget } from "./CommitContextMenu";
import { GraphCell, graphWidthFor, LANE_WIDTH, ROW_HEIGHT, WipGraphCell } from "./GraphCell";
import { RefPills } from "./RefPills";

interface ColumnsState {
  readonly refs: number;
  readonly graph: number | null;
  readonly author: number;
  readonly date: number;
  set(col: "refs" | "graph" | "author" | "date", width: number): void;
}

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

  const graphWidth = columns.graph ?? graphWidthFor(Math.min(info?.maxLanes ?? 1, 6));

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

  const selectedIndex = useMemo(() => {
    if (selection?.kind === "wip") return 0;
    if (selection?.kind !== "commit") return -1;
    for (const [i, r] of rows) if (r.hash === selection.hash) return i + offset;
    return -1;
  }, [selection, rows, offset]);

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
      <Header graphWidth={graphWidth} />
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
                  isHead={row.hash === headHash}
                  isStash={stashes.has(row.hash)}
                  wipAbove={offset > 0 && index === 0 && row.hash === headHash}
                  selected={selection?.kind === "commit" && selection.hash === row.hash}
                  onSelect={select}
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
      {info && !info.complete && info.count > 0 && (
        <div className="text-muted-foreground border-t px-3 py-1 text-[11px] tabular-nums">
          Loading history… {info.count.toLocaleString()} commits
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header with resizable columns
// ---------------------------------------------------------------------------

function Header({ graphWidth }: { graphWidth: number }) {
  const columns = useColumns();
  return (
    <div className="text-muted-foreground bg-background flex h-7 shrink-0 items-center border-b text-[10px] font-semibold tracking-wider uppercase select-none">
      <div className="relative shrink-0 truncate px-3" style={{ width: columns.refs }}>
        Branch / Tag
        <Resizer onResize={(d) => columns.set("refs", Math.max(60, columns.refs + d))} />
      </div>
      <div className="relative shrink-0 truncate px-2" style={{ width: graphWidth }}>
        Graph
        <Resizer onResize={(d) => columns.set("graph", Math.max(LANE_WIDTH * 2, graphWidth + d))} />
      </div>
      <div className="min-w-0 flex-1 truncate px-2">Commit message</div>
      <div className="relative shrink-0 truncate px-2" style={{ width: columns.author }}>
        <Resizer left onResize={(d) => columns.set("author", Math.max(40, columns.author - d))} />
        Author
      </div>
      <div className="relative shrink-0 truncate px-2" style={{ width: columns.date }}>
        <Resizer left onResize={(d) => columns.set("date", Math.max(40, columns.date - d))} />
        Date
      </div>
      <div className="w-[76px] shrink-0 truncate px-2">SHA</div>
    </div>
  );
}

function Resizer({ onResize, left }: { onResize: (delta: number) => void; left?: boolean }) {
  return (
    <div
      className={cn(
        "hover:bg-primary/60 absolute top-0 z-10 h-full w-1 cursor-col-resize",
        left ? "left-0" : "right-0",
      )}
      onPointerDown={(e) => {
        e.preventDefault();
        const target = e.currentTarget;
        target.setPointerCapture(e.pointerId);
        let last = e.clientX;
        const move = (ev: PointerEvent) => {
          onResize(ev.clientX - last);
          last = ev.clientX;
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
  readonly isHead: boolean;
  readonly isStash: boolean;
  readonly wipAbove: boolean;
  readonly selected: boolean;
  readonly onSelect: (repo: RepoId, selection: Selection) => void;
  readonly onContextMenu: (row: GraphRow) => void;
  readonly avatarProviders: readonly AvatarProvider[];
}

const CommitRow = memo(function CommitRow(p: CommitRowProps) {
  const columns = useColumns();
  const { row } = p;
  return (
    <div
      className={rowClass(p.selected)}
      style={p.style}
      onMouseDown={(e) => {
        if (e.button === 0) p.onSelect(p.repo, { kind: "commit", hash: row.hash });
      }}
      onContextMenu={() => p.onContextMenu(row)}
    >
      <div
        className="flex shrink-0 items-center overflow-hidden px-2"
        style={{ width: columns.refs }}
      >
        <RefPills
          refs={p.refs}
          color={row.color}
          onDoubleClick={(r) => void commands.checkoutRef(p.repo, r)}
        />
      </div>
      <div className="shrink-0 overflow-hidden" style={{ width: p.graphWidth }}>
        <GraphCell
          row={row}
          width={p.graphWidth}
          isHead={p.isHead}
          isStash={p.isStash}
          wipAbove={p.wipAbove}
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
      <div className="shrink-0 overflow-hidden" style={{ width: p.graphWidth }}>
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
