import type { GraphRow, Ref, RepoId } from "@shared/domain";
import { MAX_GRAPH_ROWS } from "@shared/ipc";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AvatarProvider } from "@shared/avatars";
import { Avatar, useAvatarProviders } from "@/components/Avatar";
import {
  ContextMenu,
  ContextMenuTrigger,
  isMenuKey,
  openActiveMenu,
  useContextMenuTarget,
} from "@/components/ui/context-menu";
import { Spinner } from "@/components/ui/spinner";
import { api, isMac } from "@/lib/api";
import { absoluteTime, nameAndEmail, relativeTime, shortHash } from "@/lib/format";
import {
  useGraphInfo,
  useGraphRows,
  useRefs,
  useRefsByHash,
  useRepoInfo,
  useStatus,
  useWipLane,
} from "@/lib/queries";
import { laneColor } from "@/lib/graph-colors";
import { cn } from "@/lib/utils";
import {
  type PickedCommit,
  type Selection,
  selectedHashes,
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
import { MAX_RANGE, rangeIndexes, selectionOf, toggled } from "./selection";

type Column = "refs" | "graph" | "author" | "date";

interface ColumnsState {
  readonly refs: number;
  readonly graph: number | null;
  readonly author: number;
  readonly date: number;
  /** Sets a column's width; `null` sizes the graph column to fit its lanes again. */
  readonly set: (col: Column, width: number | null) => void;
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

/** The branch column's minimum width: room for a short name and a `+1`. */
const MIN_REFS = 80;

const useColumns = create<ColumnsState>()(
  persist(
    (set) => ({
      refs: 170,
      graph: null,
      author: 140,
      date: 104,
      set: (col, width) => set({ [col]: width }),
    }),
    {
      name: "gitdove.graph-columns",
      // Widths saved before the minimum was raised.
      merge: (saved, current) => {
        const merged = { ...current, ...(saved as Partial<ColumnsState>) };
        return { ...merged, refs: Math.max(MIN_REFS, merged.refs) };
      },
    },
  ),
);

const EMPTY_REFS: readonly Ref[] = [];

/**
 * Where each repository's graph was, so that it comes back there after a diff replaced it:
 * the scroll offset, the fitted graph width and the reveal request it is handling.
 */
interface GraphView {
  scroll: number;
  /** The fitted graph width, for the graph version it was fitted to. */
  fit: { readonly width: number; readonly version: number | null };
  /** The last reveal request seen, and the commit it still has to scroll to (if any). */
  readonly reveal: { token: number; hash: string | null };
}
const views = new Map<RepoId, GraphView>();
const viewOf = (repo: RepoId): GraphView => {
  let v = views.get(repo);
  if (!v) {
    v = { scroll: 0, fit: { width: 0, version: null }, reveal: { token: 0, hash: null } };
    views.set(repo, v);
  }
  return v;
};
// A closed repository's graph starts afresh when reopened (its reveal requests count from 0).
useRepoUiStore.subscribe((s, prev) => {
  if (s.byRepo === prev.byRepo) return;
  for (const repo of views.keys()) if (prev.byRepo[repo] && !s.byRepo[repo]) views.delete(repo);
});

/** The commit last clicked in `selection`, where ranges and arrow keys start. */
const anchorOf = (selection: Selection | null) =>
  selection?.kind === "commit"
    ? selection.hash
    : selection?.kind === "commits"
      ? selection.anchor
      : null;

/** Seconds since the epoch, updated every minute so that relative dates move on. */
const useMinuteClock = () => {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
};

/** `then` for a value that may not be a promise yet, staying synchronous when it is not. */
const andThen = <T, U>(v: T | Promise<T>, f: (t: T) => U | Promise<U>): U | Promise<U> =>
  v instanceof Promise ? v.then(f) : f(v);

/** A change of the selection; `undefined` leaves it as it is. */
type Step = (base: Selection | null) => Selection | undefined | Promise<Selection | undefined>;

export const CommitGraph = memo(function CommitGraph({ repo }: { repo: RepoId }) {
  const { data: info, isPending, error } = useGraphInfo(repo);
  const { data: status } = useStatus(repo);
  const { data: repoInfo } = useRepoInfo(repo);
  const { data: refsData } = useRefs(repo);
  const refsByHash = useRefsByHash(repo);
  const selection = useRepoUiStore((s) => s.byRepo[repo]?.selection ?? null);
  const revealToken = useRepoUiStore((s) => s.byRepo[repo]?.revealToken ?? 0);
  const select = useRepoUiStore((s) => s.select);
  const columns = useColumns();
  // Widths being dragged, saved when the drag ends.
  const [draft, setDraft] = useState<Partial<Record<Column, number>>>({});
  const avatarProviders = useAvatarProviders(repo);
  const now = useMinuteClock();
  const listId = useId();
  /** The element id of the WIP row ("wip") or a commit's row. */
  const rowId = (key: string) => `${listId}-${key}`;

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
    initialOffset: () => views.get(repo)?.scroll ?? 0,
  });
  // The virtualizer starts where the graph was, but a history that is not loaded yet (or only
  // partly, while it streams in) may not reach there: the browser clamps the scroll. Go back
  // there once it can, unless the user scrolled meanwhile.
  const restore = useRef(views.get(repo)?.scroll ?? 0);
  useLayoutEffect(() => {
    const target = restore.current;
    if (target === 0 || !info) return;
    const reachable = virtualizer.getTotalSize() - (virtualizer.scrollRect?.height ?? 0) >= target;
    if (!reachable && !info.complete) return;
    virtualizer.scrollToOffset(target);
    restore.current = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.count, info?.complete]);
  const scrolledByUser = () => {
    restore.current = 0;
  };
  const items = virtualizer.getVirtualItems();
  const firstIndex = Math.max(0, (items[0]?.index ?? 0) - offset);
  const lastIndex = Math.max(0, (items.at(-1)?.index ?? 0) - offset + 1);
  const { rows, current } = useGraphRows(repo, info, firstIndex, lastIndex);
  // The WIP row's line runs down to HEAD, through the rows above it.
  const wipHead = offset > 0 ? headHash : null;
  const { data: wipData } = useWipLane(repo, info, wipHead);
  const wip = wipHead === null ? null : (wipData ?? null);
  const wipLaneAt = (index: number) => (wip && index <= wip.index ? wip.lane : null);

  // What callbacks and queued steps (below) see: the latest render's rows and graph version,
  // not those of the render that made them.
  const latest = useRef({ info, current, offset, total, refsByHash });
  latest.current = { info, current, offset, total, refsByHash };

  // Fit the lanes on screen. The width only grows while scrolling, so the columns don't jump
  // back and forth; double-clicking the column border, or a new graph (e.g. after hiding
  // branches), fits it to the rows on screen again. Only rows in the viewport count, not the
  // overscan rendered around it.
  const top = virtualizer.scrollOffset ?? 0;
  const bottom = top + (virtualizer.scrollRect?.height ?? Infinity);
  let widestRow = 0;
  for (const item of items) {
    if (item.end <= top || item.start >= bottom) continue;
    const row = rows.get(item.index - offset);
    if (row) widestRow = Math.max(widestRow, rowGraphWidth(row, wipLaneAt(item.index - offset)));
  }
  const visibleWidth = Math.max(widestRow, graphWidthFor(MIN_AUTO_LANES));
  // The fitted width belongs to one graph: a new one (e.g. after hiding branches) fits again.
  const [fit, setFit] = useState(() => views.get(repo)?.fit ?? { width: 0, version: null });
  const fitWidth = fit.version === (info?.version ?? null) ? fit.width : 0;
  useLayoutEffect(() => {
    if (visibleWidth > fitWidth) setFit({ width: visibleWidth, version: info?.version ?? null });
  }, [visibleWidth, fitWidth, info?.version]);
  const widths = {
    refs: draft.refs ?? columns.refs,
    graph:
      draft.graph ??
      columns.graph ??
      Math.min(Math.max(fitWidth, visibleWidth), graphWidthFor(MAX_AUTO_LANES)),
    author: draft.author ?? columns.author,
    date: draft.date ?? columns.date,
  };
  const clipped = widestRow > widths.graph;
  const onResize = useCallback((col: Column, width: number, done: boolean) => {
    if (done) {
      useColumns.getState().set(col, width);
      setDraft({});
    } else setDraft({ [col]: width });
  }, []);
  const refit = useCallback(() => {
    useColumns.getState().set("graph", null);
    setFit({ width: 0, version: null });
  }, []);

  useEffect(() => {
    viewOf(repo).fit = fit;
  }, [repo, fit]);

  // Scroll the selected commit into view when asked to (e.g. from the sidebar), once: coming
  // back from a diff keeps the place instead. A lookup cut short (e.g. by a diff replacing the
  // graph) runs again, and a commit that has not streamed in yet is looked for again as the
  // graph grows.
  useEffect(() => {
    const r = viewOf(repo).reveal;
    if (r.token !== revealToken) {
      r.token = revealToken;
      r.hash = selection?.kind === "commit" ? selection.hash : null;
    }
    const hash = r.hash;
    if (hash === null || !info) return;
    let cancelled = false;
    void api("repo.findCommit", repo, info.version, hash).then(
      (index) => {
        if (cancelled || r.hash !== hash) return;
        if (index >= 0) {
          r.hash = null;
          // Going to the commit replaces going back to where the graph was.
          restore.current = 0;
          virtualizer.scrollToIndex(index + latest.current.offset, { align: "center" });
        } else if (info.complete) r.hash = null;
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
    // A request made before the graph loaded waits for it, and one for a commit not loaded yet
    // looks again as more arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealToken, info]);

  const hashes = useMemo(() => selectedHashes(selection), [selection]);

  /** Where a commit was last seen, for when its row is not loaded any more. */
  const seenAt = useRef<{ hash: string; version: number; index: number } | null>(null);
  /** The moving end of a Shift+arrow range (its anchor stays), with the selection it made. */
  const cursor = useRef<{ selection: Selection; hash: string } | null>(null);
  const see = (row: GraphRow, index: number) => {
    const { info: i, current: loaded } = latest.current;
    if (i && loaded.get(index)?.hash === row.hash)
      seenAt.current = { hash: row.hash, version: i.version, index };
  };

  // Clicks with the platform key or Shift, and arrow keys, may have to fetch rows first, so
  // they run one after another, each from the selection the one before left; a selection made
  // any other way drops those still pending.
  const presses = useRef({
    tail: Promise.resolve(),
    epoch: 0,
    owned: null as Selection | null,
    pending: 0,
  });
  /** Runs `step` on the current selection: right away, unless steps are pending. */
  const enqueue = (step: Step) => {
    const selected = () => useRepoUiStore.getState().byRepo[repo]?.selection ?? null;
    const q = presses.current;
    if (selected() !== q.owned) {
      q.epoch++;
      q.owned = selected();
    }
    const epoch = q.epoch;
    const live = () => q.epoch === epoch && selected() === q.owned;
    const apply = (next: Selection | undefined) => {
      if (next === undefined || !live()) return;
      select(repo, next);
      q.owned = selected();
    };
    let result: Promise<void>;
    if (q.pending === 0) {
      const next = step(selected());
      if (!(next instanceof Promise)) return apply(next);
      result = next.then(apply);
    } else {
      result = q.tail.then(async () => {
        if (live()) apply(await step(selected()));
      });
    }
    q.pending++;
    q.tail = result.catch(() => {}).finally(() => q.pending--);
  };

  /**
   * The rows from `from` to `to` (inclusive) of graph `version`: those not loaded are fetched,
   * in runs of at most {@link MAX_GRAPH_ROWS}.
   */
  const rowsIn = async (version: number, from: number, to: number) => {
    const out = new Map<number, GraphRow>();
    const loaded = latest.current.info?.version === version ? latest.current.current : null;
    const missing: [number, number][] = [];
    for (let i = from; i <= to; i++) {
      const r = loaded?.get(i);
      if (r) out.set(i, r);
      else {
        const last = missing.at(-1);
        if (last?.[1] === i && last[1] - last[0] < MAX_GRAPH_ROWS) last[1] = i + 1;
        else missing.push([i, i + 1]);
      }
    }
    const fetched = await Promise.all(
      missing.map(([start, end]) => api("repo.graphRows", repo, version, start, end)),
    );
    fetched.forEach((run, k) => run.forEach((r, j) => out.set(missing[k]![0] + j, r)));
    return out;
  };
  /** Where a commit is in graph `version` (-1 when not in it), looked up when not loaded. */
  const indexOf = (version: number, hash: string): number | Promise<number> => {
    const { info: i, current: loaded } = latest.current;
    if (i?.version === version) for (const [index, r] of loaded) if (r.hash === hash) return index;
    const seen = seenAt.current;
    if (seen?.hash === hash && seen.version === version) return seen.index;
    return api("repo.findCommit", repo, version, hash);
  };
  /** Where several commits are in graph `version` (-1 when not), in one lookup at most. */
  const indexesOf = async (version: number, wanted: readonly string[]): Promise<number[]> => {
    const { info: i, current: loaded } = latest.current;
    const known = new Map<string, number>();
    if (i?.version === version) for (const [index, r] of loaded) known.set(r.hash, index);
    const unknown = wanted.filter((h) => !known.has(h));
    if (unknown.length > 0) {
      const found = await api("repo.findCommits", repo, version, unknown);
      unknown.forEach((h, k) => known.set(h, found[k] ?? -1));
    }
    return wanted.map((h) => known.get(h)!);
  };

  /** The selection `base` becomes with the commit at `index` toggled, or the range up to it. */
  const extend = async (
    base: Selection | null,
    row: GraphRow,
    index: number,
    toggle: boolean,
  ): Promise<Selection> => {
    const single = { kind: "commit", hash: row.hash } as const;
    const i = latest.current.info;
    const start = anchorOf(base);
    if (!i || start === null) return single;
    const v = i.version;
    // After a reload, commits picked before may have moved, or gone.
    const reindexed = async (picked: readonly PickedCommit[]) => {
      const indexes = await indexesOf(
        v,
        picked.map((p) => p.row.hash),
      );
      return picked.map((p, k) => ({ ...p, index: indexes[k]! })).filter((p) => p.index >= 0);
    };
    try {
      // Only rows loaded for this graph version are where they show: rows of a previous
      // version shown while the graph reloads, or commits far off screen, are asked for.
      const at =
        latest.current.current.get(index)?.hash === row.hash ? index : await indexOf(v, row.hash);
      if (at < 0) return single;
      if (toggle) {
        let picked: readonly PickedCommit[] = [];
        if (base?.kind === "commits")
          picked = base.version === v ? base.commits : await reindexed(base.commits);
        else if (base?.kind === "commit") {
          const b = await indexOf(v, base.hash);
          const r = b >= 0 ? (await rowsIn(v, b, b)).get(b) : undefined;
          if (r) picked = [{ index: b, row: r }];
        }
        return selectionOf(toggled(picked, { index: at, row }), row.hash, v) ?? single;
      }
      const a = await indexOf(v, start);
      if (a < 0) return single;
      const [from, to] = rangeIndexes(a, at);
      if (Math.abs(at - a) >= MAX_RANGE)
        toast.info(`Selected the ${MAX_RANGE.toLocaleString()} commits nearest the one clicked`);
      const range = [...(await rowsIn(v, from, to))].map(([j, r]) => ({ index: j, row: r }));
      return selectionOf(range, start, v) ?? single;
    } catch {
      return single;
    }
  };

  const press = (row: GraphRow, index: number, e: React.MouseEvent) => {
    const toggle = isMac ? e.metaKey : e.ctrlKey;
    see(row, index);
    if (!toggle && !e.shiftKey) return select(repo, { kind: "commit", hash: row.hash });
    enqueue((base) => extend(base, row, index, toggle));
  };
  const pressRef = useRef(press);
  pressRef.current = press;
  const onPress = useCallback(
    (row: GraphRow, index: number, e: React.MouseEvent) => pressRef.current(row, index, e),
    [],
  );

  /**
   * Moves the selection to the row `move` picks from where it is (a position in the list,
   * WIP row included, or -1 for none). With `range`, the end of a range moves instead.
   */
  const navigate = (move: (at: number) => number, range: boolean) =>
    enqueue((base) => {
      const { info: i, offset: off, total: count } = latest.current;
      if (!i || count === 0) return undefined;
      const v = i.version;
      const end = cursor.current?.selection === base ? cursor.current.hash : anchorOf(base);
      const at =
        base?.kind === "wip"
          ? off > 0
            ? 0
            : -1
          : end === null
            ? -1
            : andThen(indexOf(v, end), (g) => (g < 0 ? -1 : g + off));
      return andThen(at, (from) => {
        const next = Math.min(count - 1, Math.max(0, move(from)));
        virtualizer.scrollToIndex(next, { align: "auto" });
        if (next < off) return { kind: "wip" } as const;
        const index = next - off;
        const done = (row: GraphRow | undefined): Selection | undefined | Promise<Selection> => {
          if (!row) return undefined;
          seenAt.current = { hash: row.hash, version: v, index };
          if (!range || (base?.kind !== "commit" && base?.kind !== "commits"))
            return { kind: "commit", hash: row.hash };
          return extend(base, row, index, false).then((sel) => {
            cursor.current = { selection: sel, hash: row.hash };
            return sel;
          });
        };
        const loaded = latest.current.current.get(index);
        return loaded ? done(loaded) : rowsIn(v, index, index).then((r) => done(r.get(index)));
      });
    });

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isMenuKey(e)) {
      e.preventDefault();
      const key = selection?.kind === "wip" ? "wip" : anchorOf(selection);
      if (key === null) return;
      openActiveMenu(scrollRef.current, rowId(key), () => {
        const i = latest.current.info;
        if (key === "wip") virtualizer.scrollToIndex(0, { align: "auto" });
        else if (i) {
          void Promise.resolve(indexOf(i.version, key)).then(
            (index) => {
              if (index >= 0)
                virtualizer.scrollToIndex(index + latest.current.offset, { align: "auto" });
            },
            () => {},
          );
        }
      });
      return;
    }
    const page = Math.max(1, Math.floor((virtualizer.scrollRect?.height ?? 0) / ROW_HEIGHT) - 1);
    const moves: Partial<Record<string, (at: number) => number>> = {
      ArrowDown: (at) => at + 1,
      ArrowUp: (at) => at - 1,
      PageDown: (at) => at + page,
      PageUp: (at) => at - page,
      Home: () => 0,
      End: () => Infinity,
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    navigate(move, e.shiftKey);
  };

  const menu = useContextMenuTarget<MenuTarget>();
  const capture = menu.capture;
  const onRowContextMenu = useCallback(
    (row: GraphRow | null) => {
      if (!row) {
        select(repo, { kind: "wip" });
        return capture({ kind: "wip" });
      }
      // Right-clicking a commit of a multi-selection keeps it, for actions on all of them.
      const selected = useRepoUiStore.getState().byRepo[repo]?.selection;
      if (selected?.kind === "commits" && selected.commits.some((c) => c.row.hash === row.hash))
        return capture({ kind: "commits", commits: selected.commits });
      select(repo, { kind: "commit", hash: row.hash });
      capture({ kind: "commit", row, refs: latest.current.refsByHash.get(row.hash) ?? [] });
    },
    [repo, select, capture],
  );
  const onSelectWip = useCallback(() => select(repo, { kind: "wip" }), [repo, select]);
  const onRefDoubleClick = useCallback((r: Ref) => void commands.checkoutRef(repo, r), [repo]);

  if (error && !info) {
    return (
      <div className="text-destructive flex h-full items-center justify-center p-8 text-sm">
        {error.message}
      </div>
    );
  }

  const active = selection?.kind === "wip" ? "wip" : anchorOf(selection);
  let activeShown = false;
  const rendered = items.map((item) => {
    const index = item.index - offset;
    if (index < 0) {
      activeShown ||= active === "wip";
      return (
        <WipRow
          key="wip"
          id={rowId("wip")}
          top={item.start}
          changes={changes}
          lane={wip?.lane ?? 0}
          color={wip?.color ?? 0}
          clipped={clipped}
          selected={selection?.kind === "wip"}
          onSelect={onSelectWip}
          onContextMenu={onRowContextMenu}
        />
      );
    }
    const row = rows.get(index);
    if (!row) return <PlaceholderRow key={item.key} top={item.start} />;
    activeShown ||= active === row.hash;
    return (
      // Keyed by position: while the graph reloads, rows of two versions can show a commit
      // twice, and rows that moved only need moving.
      <CommitRow
        key={item.key}
        id={rowId(row.hash)}
        top={item.start}
        row={row}
        refs={refsByHash.get(row.hash) ?? EMPTY_REFS}
        clipped={clipped}
        isHead={row.hash === headHash}
        isStash={stashes.has(row.hash)}
        wipLane={wipLaneAt(index)}
        wipColor={wip?.color ?? 0}
        index={index}
        selected={hashes.has(row.hash)}
        now={now}
        onPress={onPress}
        onContextMenu={onRowContextMenu}
        onRefDoubleClick={onRefDoubleClick}
        avatarProviders={avatarProviders}
      />
    );
  });

  return (
    <div
      className="flex h-full min-w-0 flex-col"
      // Rows size their cells from these, so that resizing a column does not render them.
      style={
        {
          "--col-refs": `${widths.refs}px`,
          "--col-graph": `${widths.graph}px`,
          "--col-author": `${widths.author}px`,
          "--col-date": `${widths.date}px`,
        } as React.CSSProperties
      }
    >
      <Header widths={widths} onResize={onResize} onFitGraph={refit} />
      <ContextMenu {...menu.rootProps}>
        <ContextMenuTrigger
          render={
            <div
              ref={scrollRef}
              tabIndex={0}
              role="listbox"
              aria-label="Commits"
              aria-multiselectable
              aria-activedescendant={activeShown && active !== null ? rowId(active) : undefined}
              onKeyDown={(e) => {
                scrolledByUser();
                onKeyDown(e);
              }}
              onScroll={(e) => {
                // While going back is pending, the browser's clamping is not a place to keep.
                if (restore.current === 0) viewOf(repo).scroll = e.currentTarget.scrollTop;
              }}
              onWheel={scrolledByUser}
              onPointerDown={scrolledByUser}
              className="relative min-h-0 flex-1 overflow-auto outline-none [contain:strict]"
            />
          }
        >
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>{rendered}</div>
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
        {menu.target && (
          <CommitContextMenu repo={repo} target={menu.target} stashes={refsData?.stashes ?? []} />
        )}
      </ContextMenu>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Header with resizable columns
// ---------------------------------------------------------------------------

type Widths = Readonly<Record<Column, number>>;
type OnResize = (col: Column, width: number, done: boolean) => void;

function Header({
  widths,
  onResize,
  onFitGraph,
}: {
  widths: Widths;
  onResize: OnResize;
  onFitGraph: () => void;
}) {
  return (
    <div className="text-muted-foreground bg-background flex h-7 shrink-0 items-center border-b text-[10px] font-semibold tracking-wider uppercase select-none">
      <div className="relative shrink-0 truncate px-3" style={{ width: widths.refs }}>
        Branch / Tag
        <Resizer
          label="Branch / Tag"
          col="refs"
          width={widths.refs}
          min={MIN_REFS}
          onResize={onResize}
        />
      </div>
      <div className="relative shrink-0 truncate px-2" style={{ width: widths.graph }}>
        Graph
        <Resizer
          label="Graph"
          col="graph"
          width={widths.graph}
          min={LANE_WIDTH * 2}
          onResize={onResize}
          onReset={onFitGraph}
          title="Drag to resize, double-click to fit the lanes"
        />
      </div>
      <div className="min-w-0 flex-1 truncate px-2">Commit message</div>
      <div className="relative shrink-0 truncate px-2" style={{ width: widths.author }}>
        <Resizer
          left
          label="Author"
          col="author"
          width={widths.author}
          min={40}
          onResize={onResize}
        />
        Author
      </div>
      <div className="relative shrink-0 truncate px-2" style={{ width: widths.date }}>
        <Resizer left label="Date" col="date" width={widths.date} min={40} onResize={onResize} />
        Date
      </div>
      <div className="w-[76px] shrink-0 truncate px-2">SHA</div>
    </div>
  );
}

/** Pixels an arrow key resizes a column by. */
const KEY_STEP = 16;

/**
 * Drag handle on a column's edge; `left` handles grow the column when dragged left. The width
 * is reported while dragging, then once more with `done` when the drag ends.
 */
function Resizer({
  label,
  col,
  width,
  min,
  onResize,
  onReset,
  left,
  title,
}: {
  label: string;
  col: Column;
  width: number;
  min: number;
  onResize: OnResize;
  onReset?: () => void;
  left?: boolean;
  title?: string;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize the ${label} column`}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      tabIndex={0}
      className={cn(
        "hover:bg-primary/60 focus-visible:bg-primary/60 absolute top-0 z-10 h-full w-1 cursor-col-resize outline-none",
        left ? "left-0" : "right-0",
      )}
      title={title}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const grow = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (grow !== 0) {
          e.preventDefault();
          onResize(col, Math.max(min, width + (left ? -grow : grow) * KEY_STEP), true);
        } else if (e.key === "Enter" && onReset) {
          e.preventDefault();
          onReset();
        }
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const target = e.currentTarget;
        target.setPointerCapture(e.pointerId);
        // Measure from where the drag started: this handler outlives the render it came from.
        const start = width;
        const x0 = e.clientX;
        let last = start;
        const move = (ev: PointerEvent) => {
          const delta = ev.clientX - x0;
          last = Math.max(min, start + (left ? -delta : delta));
          onResize(col, last, false);
        };
        // A cancelled drag, or one that lost its capture, ends too: otherwise hovering over
        // the handle would go on resizing.
        const end = () => {
          target.removeEventListener("pointermove", move);
          target.removeEventListener("pointerup", end);
          target.removeEventListener("pointercancel", end);
          target.removeEventListener("lostpointercapture", end);
          onResize(col, last, true);
        };
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", end);
        target.addEventListener("pointercancel", end);
        target.addEventListener("lostpointercapture", end);
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
    selected ? "bg-selected" : "hover:bg-muted/60",
  );

const rowStyle = (top: number): React.CSSProperties => ({
  transform: `translateY(${top}px)`,
  height: ROW_HEIGHT,
});

interface CommitRowProps {
  readonly id: string;
  /** Where the row is in the list, in pixels. */
  readonly top: number;
  readonly row: GraphRow;
  readonly refs: readonly Ref[];
  /** The graph column cuts off rows on screen. */
  readonly clipped: boolean;
  readonly isHead: boolean;
  readonly isStash: boolean;
  /** The WIP line's column, if it runs through this row (see `GraphCell`), and its color. */
  readonly wipLane: number | null;
  readonly wipColor: number;
  readonly index: number;
  readonly selected: boolean;
  /** The time dates are relative to, in seconds. */
  readonly now: number;
  readonly onPress: (row: GraphRow, index: number, e: React.MouseEvent) => void;
  readonly onContextMenu: (row: GraphRow) => void;
  readonly onRefDoubleClick: (ref: Ref) => void;
  readonly avatarProviders: readonly AvatarProvider[];
}

/** A commit's row; its props stay the same from render to render, so scrolling skips it. */
const CommitRow = memo(function CommitRow(p: CommitRowProps) {
  const { row } = p;
  // Stashes have no pill.
  const hasPills = p.refs.some((r) => r.kind !== "stash");
  return (
    <div
      id={p.id}
      role="option"
      aria-selected={p.selected}
      className={rowClass(p.selected)}
      style={rowStyle(p.top)}
      onMouseDown={(e) => {
        if (e.button === 0) p.onPress(row, p.index, e);
      }}
      onContextMenu={() => p.onContextMenu(row)}
    >
      {/* A query container: pills drop their icons as the column narrows. */}
      <div className="@container flex w-(--col-refs) shrink-0 items-center overflow-hidden pl-2">
        <RefPills refs={p.refs} color={row.color} onDoubleClick={p.onRefDoubleClick} />
        {hasPills && (
          <div className="h-0.5 min-w-2 flex-1" style={{ backgroundColor: laneColor(row.color) }} />
        )}
      </div>
      <div
        className={cn("relative w-(--col-graph) shrink-0 overflow-hidden", p.clipped && CLIPPED)}
      >
        <GraphCell
          row={row}
          isHead={p.isHead}
          isStash={p.isStash}
          wipLane={p.wipLane}
          wipColor={p.wipColor}
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
      <div className="flex w-(--col-author) shrink-0 items-center gap-1.5 overflow-hidden px-2">
        <Avatar name={row.authorName} email={row.authorEmail} providers={p.avatarProviders} />
        <span
          className="text-muted-foreground truncate text-xs"
          title={nameAndEmail(row.authorName, row.authorEmail)}
        >
          {row.authorName}
        </span>
      </div>
      <div
        className="text-muted-foreground w-(--col-date) shrink-0 truncate px-2 text-xs tabular-nums"
        title={absoluteTime(row.authorTime)}
      >
        {relativeTime(row.authorTime, p.now)}
      </div>
      <div className="text-muted-foreground w-[76px] shrink-0 truncate px-2 font-mono text-[11px]">
        {shortHash(row.hash)}
      </div>
    </div>
  );
});

const WipRow = memo(function WipRow(p: {
  id: string;
  top: number;
  changes: number;
  lane: number;
  color: number;
  clipped: boolean;
  selected: boolean;
  onSelect: () => void;
  onContextMenu: (row: null) => void;
}) {
  return (
    <div
      id={p.id}
      role="option"
      aria-selected={p.selected}
      className={rowClass(p.selected)}
      style={rowStyle(p.top)}
      onMouseDown={(e) => e.button === 0 && p.onSelect()}
      onContextMenu={() => p.onContextMenu(null)}
    >
      <div className="w-(--col-refs) shrink-0" />
      <div
        className={cn("relative w-(--col-graph) shrink-0 overflow-hidden", p.clipped && CLIPPED)}
      >
        <WipGraphCell lane={p.lane} color={p.color} />
      </div>
      <div className="text-muted-foreground flex min-w-0 flex-1 items-center gap-2 px-2 italic">
        <span>{"// WIP"}</span>
        <span className="bg-muted rounded px-1.5 text-[11px] not-italic tabular-nums">
          {p.changes} {p.changes === 1 ? "change" : "changes"}
        </span>
      </div>
    </div>
  );
});

function PlaceholderRow({ top }: { top: number }) {
  return (
    <div
      className="absolute top-0 left-0 flex w-full items-center px-3"
      style={rowStyle(top)}
      aria-hidden
    >
      <div className="bg-muted/50 h-2.5 w-1/3 rounded" />
    </div>
  );
}
