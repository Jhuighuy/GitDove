import { buildPatch, hunkPatch } from "@shared/diff/patch";
import { type Range, wordDiff, type WordDiff } from "@shared/diff/words";
import type { DiffTarget, RepoId } from "@shared/domain";
import { IconCode, IconLayoutColumns, IconLayoutRows, IconPhoto, IconX } from "@tabler/icons-react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { useTheme } from "next-themes";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { runAction } from "@/lib/actions";
import { api } from "@/lib/api";
import { basename, dirname, shortHash } from "@/lib/format";
import { useDiff } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { BusyHint } from "@/components/busy";
import { useBusy, writeProps } from "@/stores/busy";
import { type DiffMode, useLayout, useRepoUiStore } from "@/stores/repo-ui";
import type { ThemeKind } from "./highlight-protocol";
import { type DocHighlighter, tokenStyle, useHighlighter } from "./highlight";
import { copiedText, type TextPoint } from "./copy";
import { ImageDiff } from "./ImageDiff";
import { stepTarget, useSiblingFiles } from "./targets";
import { buildModel, type DiffModel, isChange, type Line } from "./model";
import { type DiffViewId, fileKind, viewFor } from "./views";

const LINE_HEIGHT = 20;
const HUNK_HEIGHT = 28;

interface PatchAction {
  readonly label: string;
  readonly reverse: boolean;
  readonly cached: boolean;
  readonly destructive: boolean;
}

/**
 * Hunk and line actions. A rename has none: its patch moves the file between
 * paths, so applying part of it in reverse would undo the whole rename.
 */
const actionsFor = (target: DiffTarget, what: "Hunk" | "Lines"): PatchAction[] => {
  if (target.kind !== "unstaged" && target.oldPath) return [];
  return target.kind === "unstaged" && !target.untracked
    ? [
        { label: `Discard ${what}`, reverse: true, cached: false, destructive: true },
        { label: `Stage ${what}`, reverse: false, cached: true, destructive: false },
      ]
    : target.kind === "staged"
      ? [{ label: `Unstage ${what}`, reverse: true, cached: true, destructive: false }]
      : [];
};

const EMPTY_SELECTION: ReadonlySet<number> = new Set();

/** Whether Escape belongs to a field being typed in (a slider does not count). */
const isTextEntry = (el: EventTarget | null) =>
  el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type !== "range");

/** Whether a key press belongs to a menu, dialog or other popup, which handles arrows itself. */
const inPopup = (el: EventTarget | null) =>
  el instanceof Element && el.closest("[role=menu],[role=dialog],[role=listbox]") !== null;

export function DiffView({ repo, target }: { repo: RepoId; target: DiffTarget }) {
  const kind = useMemo(() => fileKind(target.path), [target.path]);
  const view = useLayout((s) => viewFor(kind, s.diffViews));
  const setView = useLayout((s) => s.setDiffView);
  const textual = view === "diff";
  const { data, error, isPending, isPlaceholderData } = useDiff(repo, textual ? target : null);
  const model = useMemo(() => (data ? buildModel(data) : null), [data]);
  const mode = useLayout((s) => s.diffMode);
  const setMode = useLayout((s) => s.setDiffMode);
  const close = () => useRepoUiStore.getState().openDiff(repo, null);

  // Selected line ids, for line-level staging. A new diff, or another view, starts afresh.
  const [selection, setSelection] = useState(EMPTY_SELECTION);
  useEffect(() => setSelection(EMPTY_SELECTION), [model, textual]);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  // Up and down step through the files of the list this diff was opened from.
  const siblings = useSiblingFiles(repo, target);
  const step = (by: number) => {
    const next = stepTarget(siblings.files, siblings.source, target, by);
    if (next) useRepoUiStore.getState().openDiff(repo, next);
  };
  const stepRef = useRef(step);
  stepRef.current = step;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTextEntry(e.target)) return;
      if (e.key === "Escape") {
        if (selectionRef.current.size > 0) setSelection(EMPTY_SELECTION);
        else close();
      } else if (
        (e.key === "ArrowDown" || e.key === "ArrowUp") &&
        !e.defaultPrevented &&
        !(e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) &&
        !inPopup(e.target)
      ) {
        e.preventDefault();
        stepRef.current(e.key === "ArrowDown" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo]);

  // Staging and discarding wait while another operation runs.
  const write = writeProps(useBusy(repo));
  const hunkActions = actionsFor(target, "Hunk");
  const lineActions = actionsFor(target, "Lines");

  const applyHunk = (hunk: number, a: PatchAction) => {
    if (!data) return;
    void runAction(repo, a.label, () =>
      api("repo.applyPatch", repo, hunkPatch(data, hunk, a.reverse), {
        cached: a.cached,
        reverse: a.reverse,
      }),
    );
  };

  const applyLines = (a: PatchAction) => {
    if (!model) return;
    const patch = buildPatch(
      model.diff,
      (h, i) => selection.has(model.hunkStart[h]! + i),
      a.reverse,
    );
    if (!patch) return;
    setSelection(EMPTY_SELECTION);
    void runAction(repo, a.label, () =>
      api("repo.applyPatch", repo, patch, { cached: a.cached, reverse: a.reverse }),
    );
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="min-w-0 truncate text-[13px]">
          {dirname(target.path) && (
            <span className="text-muted-foreground">{dirname(target.path)}/</span>
          )}
          <span className="font-medium">{basename(target.path)}</span>
        </span>
        <span className="text-muted-foreground bg-muted shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase">
          {target.kind === "commit" ? shortHash(target.hash) : target.kind}
        </span>
        {textual && (isPending || isPlaceholderData) && <Spinner className="size-3.5" />}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {textual && selection.size > 0 && (
            <SelectionBar
              count={selection.size}
              actions={lineActions}
              onAction={applyLines}
              write={write}
            />
          )}
          {kind.views.length > 1 && (
            <ViewToggle views={kind.views} view={view} setView={(v) => setView(kind.id, v)} />
          )}
          <ModeToggle mode={mode} setMode={setMode} textual={textual} />
          <Button variant="ghost" size="icon-xs" onClick={close} title="Close (Esc)">
            <IconX />
          </Button>
        </span>
      </div>
      {textual ? (
        <TextDiff
          error={error}
          model={model}
          mode={mode}
          actions={hunkActions}
          onAction={applyHunk}
          write={write}
          selectable={lineActions.length > 0}
          selection={selection}
          setSelection={setSelection}
        />
      ) : (
        <ImageDiff repo={repo} target={target} mime={kind.mime!} mode={mode} />
      )}
    </div>
  );
}

type WriteProps = ReturnType<typeof writeProps>;

function SelectionBar({
  count,
  actions,
  onAction,
  write,
}: Readonly<{
  count: number;
  actions: PatchAction[];
  onAction: (a: PatchAction) => void;
  write: WriteProps;
}>) {
  return (
    <>
      <span className="text-muted-foreground mr-1 text-[11px]">
        {count} {count === 1 ? "line" : "lines"} selected
      </span>
      <BusyHint reason={write.title} className="gap-1">
        {actions.map((a) => (
          <Button
            key={a.label}
            size="xs"
            variant={a.destructive ? "destructive" : "secondary"}
            className="h-6 rounded-md px-2 text-[11px]"
            disabled={write.disabled}
            onClick={() => onAction(a)}
          >
            {a.label}
          </Button>
        ))}
      </BusyHint>
      <span className="bg-border mx-1 h-4 w-px" />
    </>
  );
}

type DiffBodyProps = Parameters<typeof DiffBody>[0];

function TextDiff({
  error,
  model,
  ...body
}: Readonly<Omit<DiffBodyProps, "model"> & { error: Error | null; model: DiffModel | null }>) {
  if (error) return <div className="text-destructive p-4 text-sm">{error.message}</div>;
  if (!model) return null;
  if (model.diff.binary)
    return <div className="text-muted-foreground p-6 text-sm">Binary file — no textual diff.</div>;
  if (model.diff.hunks.length === 0)
    return <div className="text-muted-foreground p-6 text-sm">No changes.</div>;
  return <DiffBody model={model} {...body} />;
}

const VIEWS: Record<DiffViewId, { title: string; icon: React.ReactNode }> = {
  diff: { title: "Text diff", icon: <IconCode /> },
  image: { title: "Image", icon: <IconPhoto /> },
};

function Segmented<T extends string>({
  items,
  value,
  onChange,
}: Readonly<{
  items: readonly { value: T; title: string; icon: React.ReactNode }[];
  value: T;
  onChange: (value: T) => void;
}>) {
  return (
    <span className="flex items-center rounded-md border p-px">
      {items.map((item) => (
        <Button
          key={item.value}
          variant="ghost"
          size="icon-xs"
          title={item.title}
          aria-label={item.title}
          aria-pressed={value === item.value}
          className={cn("rounded-sm", value === item.value && "bg-muted text-foreground")}
          onClick={() => onChange(item.value)}
        >
          {item.icon}
        </Button>
      ))}
    </span>
  );
}

function ViewToggle({
  views,
  view,
  setView,
}: Readonly<{
  views: readonly DiffViewId[];
  view: DiffViewId;
  setView: (v: DiffViewId) => void;
}>) {
  return (
    <Segmented
      items={views.map((v) => ({ value: v, ...VIEWS[v] }))}
      value={view}
      onChange={setView}
    />
  );
}

function ModeToggle({
  mode,
  setMode,
  textual,
}: Readonly<{
  mode: DiffMode;
  setMode: (m: DiffMode) => void;
  textual: boolean;
}>) {
  return (
    <Segmented
      items={[
        { value: "unified", title: textual ? "Unified view" : "Swipe", icon: <IconLayoutRows /> },
        {
          value: "split",
          title: textual ? "Split view" : "Side by side",
          icon: <IconLayoutColumns />,
        },
      ]}
      value={mode}
      onChange={setMode}
    />
  );
}

function DiffBody({
  model,
  mode,
  actions,
  onAction,
  write,
  selectable,
  selection,
  setSelection,
}: {
  model: DiffModel;
  mode: DiffMode;
  actions: PatchAction[];
  onAction: (hunk: number, a: PatchAction) => void;
  write: WriteProps;
  selectable: boolean;
  selection: ReadonlySet<number>;
  setSelection: (s: ReadonlySet<number>) => void;
}) {
  const rows = mode === "split" ? model.split : model.unified;
  const scrollRef = useRef<HTMLDivElement>(null);
  // The row a text selection started in stays mounted while it scrolls away: the selection
  // would collapse if its anchor were removed.
  const anchorRow = useRef<number | null>(null);
  useEffect(() => {
    anchorRow.current = null;
  }, [rows]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]!.type === "hunk" ? HUNK_HEIGHT : LINE_HEIGHT),
    overscan: 30,
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      const a = anchorRow.current;
      if (a === null || a >= range.count || indexes.includes(a)) return indexes;
      return [...indexes, a].toSorted((x, y) => x - y);
    },
  });
  const items = virtualizer.getVirtualItems();

  const { resolvedTheme } = useTheme();
  const theme: ThemeKind = resolvedTheme === "light" ? "light" : "dark";
  const hl = useHighlighter(model);

  // Highlight what is on screen (plus overscan), lazily.
  const first = items[0]?.index ?? 0;
  const last = items.at(-1)?.index ?? -1;
  useEffect(() => {
    if (!hl) return;
    const lo: [number, number] = [Infinity, Infinity];
    const hi: [number, number] = [-1, -1];
    const add = (id: number) => {
      const l = model.lines[id];
      if (!l || l.sideIndex < 0) return;
      lo[l.side] = Math.min(lo[l.side], l.sideIndex);
      hi[l.side] = Math.max(hi[l.side], l.sideIndex);
    };
    for (let i = first; i <= last; i++) {
      const row = rows[i]!;
      if (row.type === "line") add(row.id);
      else if (row.type === "split") {
        add(row.left);
        add(row.right);
      }
    }
    hl.ensure(theme, 0, lo[0], hi[0]);
    hl.ensure(theme, 1, lo[1], hi[1]);
  }, [hl, theme, model, rows, first, last]);

  // Word-level emphasis, computed for visible pairs on demand.
  const words = useMemo(() => {
    const cache = new Map<number, WordDiff | null>();
    return (l: Line): readonly Range[] | null => {
      if (l.pair < 0) return null;
      const del = l.kind === "del" ? l : model.lines[l.pair]!;
      let d = cache.get(del.id);
      if (d === undefined) {
        d = wordDiff(del.text, model.lines[del.pair]!.text);
        cache.set(del.id, d);
      }
      return d ? (l.kind === "del" ? d.del : d.add) : null;
    };
  }, [model]);

  const ctx: CellContext = { model, hl, theme, words, selection, selectable };
  const dragRef = useRef<{ anchor: number; base: ReadonlySet<number> } | null>(null);

  const lineAt = (e: React.MouseEvent): number | null => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-line]");
    return el ? Number(el.dataset.line) : null;
  };
  const rangeSelection = (anchor: number, id: number, base: ReadonlySet<number>) => {
    const next = new Set(base);
    const kind = model.lines[anchor]!.kind;
    for (let i = Math.min(anchor, id); i <= Math.max(anchor, id); i++) {
      const l = model.lines[i]!;
      // In split view a drag stays within its column.
      if (isChange(l) && (mode === "unified" || l.kind === kind)) next.add(i);
    }
    return next;
  };
  /** Line selection: a click selects a line, shift extends it, the platform key toggles. */
  const pressLine = (e: React.MouseEvent, id: number) => {
    const anchor = dragRef.current?.anchor;
    if (e.shiftKey && anchor !== undefined && model.lines[anchor]) {
      setSelection(rangeSelection(anchor, id, EMPTY_SELECTION));
      dragRef.current = { anchor, base: EMPTY_SELECTION };
    } else if (e.metaKey || e.ctrlKey) {
      const next = new Set(selection);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelection(next);
      dragRef.current = { anchor: id, base: next };
    } else {
      setSelection(selection.size === 1 && selection.has(id) ? EMPTY_SELECTION : new Set([id]));
      dragRef.current = { anchor: id, base: EMPTY_SELECTION };
    }
  };
  // A press on the text starts a text selection; a release on the same line without selecting
  // text (or a press with a modifier, or on the line numbers) selects lines.
  const pendingLine = useRef<number | null>(null);
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const row = target.closest<HTMLElement>("[data-row]");
    anchorRow.current = row ? Number(row.dataset.row) : null;
    // A text selection stays within the column it starts in.
    const side = target.closest<HTMLElement>("[data-side]")?.dataset.side;
    if (side) scrollRef.current?.setAttribute("data-select-side", side);
    else scrollRef.current?.removeAttribute("data-select-side");

    pendingLine.current = null;
    if (!selectable) return;
    const id = lineAt(e);
    if (id === null || !isChange(model.lines[id]!)) {
      if (id !== null) setSelection(EMPTY_SELECTION);
      return;
    }
    const modifier = e.shiftKey || e.metaKey || e.ctrlKey;
    if (!modifier && !target.closest("[data-gutter]")) {
      pendingLine.current = id;
      return;
    }
    e.preventDefault();
    pressLine(e, id);
    dragging.current = true;
  };
  const onMouseUp = (e: React.MouseEvent) => {
    const id = pendingLine.current;
    pendingLine.current = null;
    if (e.button !== 0 || id === null || lineAt(e) !== id) return;
    if (window.getSelection()?.isCollapsed !== false) pressLine(e, id);
  };
  const dragging = useRef(false);
  useEffect(() => {
    const up = () => (dragging.current = false);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);
  const onMouseMove = (e: React.MouseEvent) => {
    const drag = dragRef.current;
    if (!dragging.current || !drag || !(e.buttons & 1)) return;
    const id = lineAt(e);
    if (id === null || id === drag.anchor) return;
    setSelection(rangeSelection(drag.anchor, id, drag.base));
  };

  // Copying takes the selected text from the diff rather than the page: rows scrolled out of
  // view are not in the page, and line numbers and signs are not part of the text.
  const copyRef = useRef<(e: ClipboardEvent) => void>(null);
  copyRef.current = (e) => {
    const sel = window.getSelection();
    const scroller = scrollRef.current;
    if (!sel || sel.isCollapsed || !sel.rangeCount || !scroller) return;
    const range = sel.getRangeAt(0);
    if (!scroller.contains(range.commonAncestorContainer)) return;
    const start = textPoint(range.startContainer, range.startOffset, false);
    const end = textPoint(range.endContainer, range.endOffset, true);
    if (!start || !end) return;
    const side = scroller.dataset.selectSide === "1" ? 1 : 0;
    e.preventDefault();
    e.clipboardData?.setData("text/plain", copiedText(model, rows, start, end, side));
  };
  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => copyRef.current?.(e);
    document.addEventListener("copy", onCopy);
    return () => document.removeEventListener("copy", onCopy);
  }, []);

  // Split view: both columns scroll horizontally together, driven by the bars below.
  const barRefs = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];
  const syncBars = (from: number) => {
    const x = barRefs[from]!.current!.scrollLeft;
    const other = barRefs[1 - from]!.current!;
    if (other.scrollLeft !== x) other.scrollLeft = x;
    scrollRef.current?.style.setProperty("--sx", `${x}px`);
  };
  const onWheel = (e: React.WheelEvent) => {
    if (mode === "split" && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      barRefs[0]!.current!.scrollLeft += e.deltaX;
    }
  };

  const textWidth = `${model.width}ch`;
  const gutterWidth = `${model.gutter + 2}ch`;

  return (
    <>
      <div
        ref={scrollRef}
        className={cn(
          "min-h-0 flex-1 font-mono text-[12px] [contain:strict]",
          "data-[select-side=0]:**:data-[side=1]:select-none data-[select-side=1]:**:data-[side=0]:select-none",
          mode === "split" ? "overflow-x-hidden overflow-y-auto" : "overflow-auto",
        )}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onWheel={onWheel}
      >
        <div
          style={{
            height: virtualizer.getTotalSize(),
            minWidth:
              mode === "unified" ? `calc(${textWidth} + ${model.gutter * 2 + 6}ch + 2rem)` : 0,
            position: "relative",
          }}
        >
          {items.map((v) => {
            const row = rows[v.index]!;
            const style = { transform: `translateY(${v.start}px)`, height: v.size };
            if (row.type === "hunk") {
              return (
                <div
                  key={v.key}
                  data-row={v.index}
                  style={style}
                  className="bg-muted/40 text-muted-foreground absolute top-0 left-0 flex w-full items-center gap-2 border-y px-3"
                >
                  <span className="truncate">{model.diff.hunks[row.hunk]!.header}</span>
                  <span className="sticky right-2 ml-auto flex gap-1" title={write.title}>
                    {actions.map((a) => (
                      <Button
                        key={a.label}
                        size="xs"
                        variant={a.destructive ? "destructive" : "secondary"}
                        className="h-5 rounded-md px-2 font-sans text-[11px]"
                        disabled={write.disabled}
                        onClick={() => onAction(row.hunk, a)}
                      >
                        {a.label}
                      </Button>
                    ))}
                  </span>
                </div>
              );
            }
            if (row.type === "line") {
              return <UnifiedLine key={v.key} row={v.index} style={style} id={row.id} ctx={ctx} />;
            }
            return (
              <div
                key={v.key}
                data-row={v.index}
                style={style}
                className="absolute top-0 left-0 flex w-full"
              >
                <SplitCell id={row.left} side={0} ctx={ctx} />
                <div className="bg-border w-px shrink-0" />
                <SplitCell id={row.right} side={1} ctx={ctx} />
              </div>
            );
          })}
        </div>
      </div>
      {mode === "split" && (
        <div className="flex shrink-0 font-mono text-[12px]">
          {[0, 1].map((i) => (
            <div
              key={i}
              ref={barRefs[i]}
              className="h-2.5 flex-1 overflow-x-auto overflow-y-hidden"
              onScroll={() => syncBars(i)}
            >
              <div style={{ width: `calc(${textWidth} + ${gutterWidth} + 3rem)`, height: 1 }} />
            </div>
          ))}
        </div>
      )}
      {model.diff.truncated && (
        <div className="text-muted-foreground border-t p-3 font-sans text-xs">
          Diff truncated — file is too large.
        </div>
      )}
    </>
  );
}

interface CellContext {
  readonly model: DiffModel;
  readonly hl: DocHighlighter | null;
  readonly theme: ThemeKind;
  readonly words: (l: Line) => readonly Range[] | null;
  readonly selection: ReadonlySet<number>;
  readonly selectable: boolean;
}

const GUTTER = "text-muted-foreground/70 shrink-0 pr-2 text-right select-none";

/**
 * Where a DOM selection boundary falls in the diff's text. A boundary outside a line's text
 * (on its line numbers, say) counts as that line's start, or its end for the selection's end.
 */
const textPoint = (node: Node, offset: number, isEnd: boolean): TextPoint | null => {
  const el = node instanceof Element ? node : node.parentElement;
  const row = el?.closest<HTMLElement>("[data-row]");
  if (!el || !row) return null;
  const text = el.closest<HTMLElement>("[data-text]");
  if (!text) return { row: Number(row.dataset.row), offset: isEnd ? Infinity : 0 };
  const before = document.createRange();
  before.selectNodeContents(text);
  before.setEnd(node, offset);
  return { row: Number(row.dataset.row), offset: before.toString().length };
};

const lineBg = (l: Line, selected: boolean) =>
  selected
    ? "bg-sky-500/25"
    : l.kind === "add"
      ? "bg-emerald-500/12"
      : l.kind === "del"
        ? "bg-red-500/12"
        : undefined;

const emphasisClass = (l: Line) =>
  l.kind === "add" ? "rounded-[2px] bg-emerald-500/30" : "rounded-[2px] bg-red-500/30";

function Sign({ l, selected, selectable }: { l: Line; selected: boolean; selectable: boolean }) {
  return (
    <span
      data-gutter
      className={cn(
        "w-4 shrink-0 text-center select-none",
        l.kind === "add" && "text-emerald-500",
        l.kind === "del" && "text-red-500",
        selected && "bg-sky-500 text-white",
        selectable && isChange(l) && !selected && "group-hover/line:bg-sky-500/30",
      )}
    >
      {l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}
    </span>
  );
}

function Text({ l, ctx }: { l: Line; ctx: CellContext }) {
  if (l.kind === "meta") return <span className="text-muted-foreground italic">{l.text}</span>;
  const tokens = ctx.hl?.tokens(ctx.theme, l.side, l.sideIndex) ?? null;
  const emph = ctx.words(l);
  return <LineText text={l.text} tokens={tokens} emph={emph} emphClass={emphasisClass(l)} />;
}

function UnifiedLine({
  id,
  row,
  style,
  ctx,
}: {
  id: number;
  row: number;
  style: React.CSSProperties;
  ctx: CellContext;
}) {
  const l = ctx.model.lines[id]!;
  const selected = ctx.selection.has(id);
  const gutter = { width: `${ctx.model.gutter + 1}ch` };
  return (
    <div
      data-line={id}
      data-row={row}
      style={style}
      className={cn(
        "group/line absolute top-0 left-0 flex w-full items-center leading-5 whitespace-pre",
        lineBg(l, selected),
        ctx.selectable && isChange(l) && "cursor-pointer",
      )}
    >
      <span data-gutter className={GUTTER} style={gutter}>
        {l.oldNo ?? ""}
      </span>
      <span data-gutter className={GUTTER} style={gutter}>
        {l.newNo ?? ""}
      </span>
      <Sign l={l} selected={selected} selectable={ctx.selectable} />
      <span data-text className="pr-4 select-text">
        <Text l={l} ctx={ctx} />
      </span>
    </div>
  );
}

function SplitCell({ id, side, ctx }: { id: number; side: 0 | 1; ctx: CellContext }) {
  if (id < 0) return <div className="bg-muted/30 min-w-0 flex-1" />;
  const l = ctx.model.lines[id]!;
  const selected = ctx.selection.has(id);
  const no = side === 0 ? l.oldNo : l.newNo;
  return (
    <div
      data-line={id}
      data-side={side}
      className={cn(
        "group/line flex min-w-0 flex-1 items-center leading-5 whitespace-pre",
        lineBg(l, selected),
        ctx.selectable && isChange(l) && "cursor-pointer",
      )}
    >
      <span data-gutter className={GUTTER} style={{ width: `${ctx.model.gutter + 2}ch` }}>
        {no ?? ""}
      </span>
      <Sign l={l} selected={selected} selectable={ctx.selectable} />
      <span className="min-w-0 flex-1 overflow-hidden">
        <span
          data-text
          className="block pr-4 select-text [transform:translateX(calc(-1*var(--sx,0px)))]"
        >
          <Text l={l} ctx={ctx} />
        </span>
      </span>
    </div>
  );
}

const NO_TOKENS = new Uint32Array(0);

/** Line text split into syntax tokens and word-level emphasis. */
const LineText = memo(
  function LineText({
    text,
    tokens,
    emph,
    emphClass,
  }: {
    text: string;
    tokens: Uint32Array | null;
    emph: readonly Range[] | null;
    emphClass: string;
  }) {
    if (!tokens?.length && !emph?.length) return text;
    const tk = tokens ?? NO_TOKENS;
    const em = emph ?? [];
    const out: React.ReactNode[] = [];
    let t = 0;
    let e = 0;
    for (let pos = 0; pos < text.length;) {
      while (t < tk.length && tk[t]! <= pos) t += 2;
      while (e < em.length && em[e]![1] <= pos) e++;
      const inEmph = e < em.length && em[e]![0] <= pos;
      let end = text.length;
      if (t < tk.length) end = Math.min(end, tk[t]!);
      if (e < em.length) end = Math.min(end, inEmph ? em[e]![1] : em[e]![0]);
      out.push(
        <span
          key={pos}
          style={t < tk.length ? tokenStyle(tk[t + 1]!) : undefined}
          className={inEmph ? emphClass : undefined}
        >
          {text.slice(pos, end)}
        </span>,
      );
      pos = end;
    }
    return out;
  },
  (a, b) =>
    a.text === b.text &&
    a.emph === b.emph &&
    a.emphClass === b.emphClass &&
    a.tokens?.buffer === b.tokens?.buffer &&
    a.tokens?.byteOffset === b.tokens?.byteOffset &&
    a.tokens?.length === b.tokens?.length,
);
