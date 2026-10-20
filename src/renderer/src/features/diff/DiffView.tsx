import { hunkPatch } from "@shared/diff/patch";
import type { DiffHunk, DiffTarget, FileDiff, RepoId } from "@shared/domain";
import { IconX } from "@tabler/icons-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { runAction } from "@/lib/actions";
import { api } from "@/lib/api";
import { basename, dirname, shortHash } from "@/lib/format";
import { useDiff } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useRepoUiStore } from "@/stores/repo-ui";

const LINE_HEIGHT = 20;

type Item =
  | { readonly type: "hunk"; readonly hunk: DiffHunk; readonly index: number }
  | {
      readonly type: "line";
      readonly kind: string;
      readonly oldNo: number | null;
      readonly newNo: number | null;
      readonly text: string;
    };

const flatten = (diff: FileDiff): { items: Item[]; width: number } => {
  const items: Item[] = [];
  let width = 0;
  diff.hunks.forEach((hunk, index) => {
    items.push({ type: "hunk", hunk, index });
    for (const l of hunk.lines) {
      items.push({ type: "line", ...l });
      if (l.text.length > width) width = l.text.length;
    }
  });
  return { items, width };
};

export function DiffView({ repo, target }: { repo: RepoId; target: DiffTarget }) {
  const { data, error, isPending, isPlaceholderData } = useDiff(repo, target);
  const close = () => useRepoUiStore.getState().openDiff(repo, null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
      )
        close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo]);

  const hunkActions =
    target.kind === "unstaged" && !target.untracked
      ? [
          { label: "Discard Hunk", reverse: true, cached: false, destructive: true },
          { label: "Stage Hunk", reverse: false, cached: true, destructive: false },
        ]
      : target.kind === "staged"
        ? [{ label: "Unstage Hunk", reverse: true, cached: true, destructive: false }]
        : [];

  const applyHunk = (hunk: DiffHunk, a: (typeof hunkActions)[number]) => {
    if (!data) return;
    void runAction(repo, a.label, () =>
      api("repo.applyPatch", repo, hunkPatch(data, data.hunks.indexOf(hunk), a.reverse), {
        cached: a.cached,
        reverse: a.reverse,
      }),
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
        {(isPending || isPlaceholderData) && <Spinner className="size-3.5" />}
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
          onClick={close}
          title="Close (Esc)"
        >
          <IconX />
        </Button>
      </div>
      {error ? (
        <div className="text-destructive p-4 text-sm">{error.message}</div>
      ) : data ? (
        data.binary ? (
          <div className="text-muted-foreground p-6 text-sm">Binary file — no textual diff.</div>
        ) : data.hunks.length === 0 ? (
          <div className="text-muted-foreground p-6 text-sm">No changes.</div>
        ) : (
          <DiffBody diff={data} actions={hunkActions} onAction={applyHunk} />
        )
      ) : null}
    </div>
  );
}

function DiffBody({
  diff,
  actions,
  onAction,
}: {
  diff: FileDiff;
  actions: { label: string; reverse: boolean; cached: boolean; destructive: boolean }[];
  onAction: (
    hunk: DiffHunk,
    a: { label: string; reverse: boolean; cached: boolean; destructive: boolean },
  ) => void;
}) {
  const { items, width } = useMemo(() => flatten(diff), [diff]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (items[i]!.type === "hunk" ? 28 : LINE_HEIGHT),
    overscan: 30,
  });
  const gutter = Math.max(
    3,
    String(Math.max(...diff.hunks.map((h) => h.newStart + h.newLines, 0))).length,
  );

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-auto font-mono text-[12px] [contain:strict]"
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          minWidth: `calc(${width + gutter * 2 + 6}ch + 2rem)`,
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((v) => {
          const item = items[v.index]!;
          const style = { transform: `translateY(${v.start}px)`, height: v.size };
          if (item.type === "hunk") {
            return (
              <div
                key={v.key}
                style={style}
                className="bg-muted/40 text-muted-foreground absolute top-0 left-0 flex w-full items-center gap-2 border-y px-3"
              >
                <span className="truncate">{item.hunk.header}</span>
                <span className="sticky right-2 ml-auto flex gap-1">
                  {actions.map((a) => (
                    <Button
                      key={a.label}
                      size="xs"
                      variant={a.destructive ? "destructive" : "secondary"}
                      className="h-5 rounded-md px-2 font-sans text-[11px]"
                      onClick={() => onAction(item.hunk, a)}
                    >
                      {a.label}
                    </Button>
                  ))}
                </span>
              </div>
            );
          }
          return (
            <div
              key={v.key}
              style={style}
              className={cn(
                "absolute top-0 left-0 flex w-full items-center leading-5 whitespace-pre",
                item.kind === "add" && "bg-emerald-500/12",
                item.kind === "del" && "bg-red-500/12",
                item.kind === "meta" && "text-muted-foreground italic",
              )}
            >
              <span
                className="text-muted-foreground/70 shrink-0 pr-2 text-right select-none"
                style={{ width: `${gutter + 1}ch` }}
              >
                {item.oldNo ?? ""}
              </span>
              <span
                className="text-muted-foreground/70 shrink-0 pr-2 text-right select-none"
                style={{ width: `${gutter + 1}ch` }}
              >
                {item.newNo ?? ""}
              </span>
              <span
                className={cn(
                  "w-4 shrink-0 text-center select-none",
                  item.kind === "add" && "text-emerald-500",
                  item.kind === "del" && "text-red-500",
                )}
              >
                {item.kind === "add" ? "+" : item.kind === "del" ? "-" : " "}
              </span>
              <span className="pr-4">{item.text}</span>
            </div>
          );
        })}
      </div>
      {diff.truncated && (
        <div className="text-muted-foreground p-3 font-sans text-xs">
          Diff truncated — file is too large.
        </div>
      )}
    </div>
  );
}
