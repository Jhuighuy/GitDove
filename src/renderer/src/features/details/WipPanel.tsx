import type { FileChange, RepoId, WorkingStatus } from "@shared/domain";
import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconChevronDown,
  IconMinus,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { BusyHint } from "@/components/busy";
import { runAction } from "@/lib/actions";
import { api, modKey } from "@/lib/api";
import { keys, useRepoInfo, useStatus, WORKING_TREE } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { busyReason, useBusy } from "@/stores/busy";
import { draftMessage, useDraft, useDrafts } from "@/stores/drafts";
import { useLayout, useRepoUiStore } from "@/stores/repo-ui";
import { commands } from "../commands";
import { fileTarget, MAX_LISTED_FILES } from "../diff/targets";
import { type FileAction, FileList } from "./FileList";

const EMPTY: readonly FileChange[] = [];

/** Height of a section header, which sticks to the top while its files scroll. */
const SECTION_HEADER = 28;

/**
 * Moves files between the staged and unstaged lists in the cached status, so that staging shows
 * at once; the refresh after the action brings the real status.
 */
const moveFiles = async (
  client: QueryClient,
  repo: RepoId,
  paths: ReadonlySet<string> | "all",
  to: "staged" | "unstaged",
) => {
  // A status fetch already running would bring back the old lists.
  await client.cancelQueries({ queryKey: keys.status(repo) });
  client.setQueryData<WorkingStatus>(keys.status(repo), (s) => {
    if (!s) return s;
    const moves = (f: FileChange) => paths === "all" || paths.has(f.path);
    const from = to === "staged" ? [...s.unstaged, ...s.conflicted] : s.staged;
    const moving = from.filter(moves).map((f): FileChange =>
      to === "staged"
        ? {
            ...f,
            kind: f.kind === "untracked" ? "added" : f.kind === "conflicted" ? "modified" : f.kind,
          }
        : { ...f, kind: f.kind === "added" ? "untracked" : f.kind },
    );
    const target = to === "staged" ? s.staged : s.unstaged;
    const kept = target.filter((f) => !moving.some((m) => m.path === f.path));
    const merged = [...kept, ...moving].toSorted((a, b) => (a.path < b.path ? -1 : 1));
    return to === "staged"
      ? {
          ...s,
          staged: merged,
          unstaged: s.unstaged.filter((f) => !moves(f)),
          conflicted: s.conflicted.filter((f) => !moves(f)),
        }
      : { ...s, staged: s.staged.filter((f) => !moves(f)), unstaged: merged };
  });
};

export function WipPanel({ repo }: { repo: RepoId }) {
  const { data: status } = useStatus(repo);
  const { data: info } = useRepoInfo(repo);
  const diff = useRepoUiStore((s) => s.byRepo[repo]?.diff ?? null);
  const busy = useBusy(repo);
  const blocked = busy ? busyReason(busy) : undefined;
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);

  const conflicted = status?.conflicted ?? EMPTY;
  const staged = useMemo(() => (status?.staged ?? EMPTY).slice(0, MAX_LISTED_FILES), [status]);
  // A conflicted file is listed once, under Conflicts (as the diff view steps through them).
  const unstaged = useMemo(() => {
    const seen = new Set(conflicted.map((f) => f.path));
    return (status?.unstaged ?? EMPTY).slice(0, MAX_LISTED_FILES).filter((f) => !seen.has(f.path));
  }, [status, conflicted]);
  const truncated = status?.truncated ?? false;
  // A file with both staged and unstaged changes is one changed file.
  const total = useMemo(
    () =>
      new Set(
        [...(status?.staged ?? []), ...(status?.unstaged ?? []), ...conflicted].map((f) => f.path),
      ).size,
    [status, conflicted],
  );
  // Resetting in the middle of a merge or rebase would leave it half done.
  const inProgress = !!info && info.state !== "clean";
  const selected = (kind: "staged" | "unstaged") => (diff?.kind === kind ? diff.path : null);

  const client = useQueryClient();
  const handlers = useMemo(() => {
    const stage = (paths: string[]) =>
      runAction(repo, "Stage", () => api("repo.stage", repo, paths), {
        invalidates: WORKING_TREE,
        optimistic: () => moveFiles(client, repo, new Set(paths), "staged"),
      });
    const unstage = (paths: string[]) =>
      runAction(repo, "Unstage", () => api("repo.unstage", repo, paths), {
        invalidates: WORKING_TREE,
        optimistic: () => moveFiles(client, repo, new Set(paths), "unstaged"),
      });
    const open = (kind: "staged" | "unstaged") => (f: FileChange) =>
      useRepoUiStore.getState().openDiff(repo, fileTarget({ kind }, f));
    const conflictActions: FileAction[] = [
      {
        label: "Mark resolved",
        icon: <IconPlus />,
        keys: ["s"],
        run: (f) => void stage([f.path]),
      },
    ];
    const unstagedActions: FileAction[] = [
      {
        label: "Discard changes",
        icon: <IconArrowBackUp />,
        keys: ["delete", "backspace"],
        run: (f) =>
          void commands.discard(
            repo,
            f.kind === "untracked" ? [] : [f.path],
            f.kind === "untracked" ? [f.path] : [],
          ),
      },
      { label: "Stage file", icon: <IconPlus />, keys: ["s"], run: (f) => void stage([f.path]) },
    ];
    const stagedActions: FileAction[] = [
      {
        label: "Unstage file",
        icon: <IconMinus />,
        keys: ["u"],
        run: (f) => void unstage([f.path]),
      },
    ];
    return {
      openUnstaged: open("unstaged"),
      openStaged: open("staged"),
      conflictActions,
      unstagedActions,
      stagedActions,
      stageAll: () =>
        void runAction(repo, "Stage all", () => api("repo.stageAll", repo), {
          invalidates: WORKING_TREE,
          optimistic: () => moveFiles(client, repo, "all", "staged"),
        }),
      unstageAll: () =>
        void runAction(repo, "Unstage all", () => api("repo.unstageAll", repo), {
          invalidates: WORKING_TREE,
          optimistic: () => moveFiles(client, repo, "all", "unstaged"),
        }),
    };
  }, [client, repo]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative flex h-10 shrink-0 items-center justify-center gap-1.5 border-b px-3 text-xs">
        {total > 0 && (
          <BusyHint
            reason={
              blocked ??
              (inProgress
                ? `Abort or finish the ${info?.state.replaceAll("-", " ")} first`
                : "Discard all changes")
            }
            className="absolute left-2"
          >
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Discard all changes"
              className="hover:bg-destructive/15 hover:text-destructive text-muted-foreground size-6"
              disabled={!!busy || inProgress}
              onClick={() => void commands.discardAll(repo)}
            >
              <IconTrash className="size-3.5" />
            </Button>
          </BusyHint>
        )}
        <span className="font-medium tabular-nums">
          {total}
          {truncated && "+"} file {total === 1 && !truncated ? "change" : "changes"}
        </span>
        <span className="text-muted-foreground">on</span>
        <span className="bg-sidebar-primary/15 text-sidebar-primary rounded px-1.5 py-0.5 font-medium">
          {info?.head.branch ?? (info?.head.hash ? "detached HEAD" : "—")}
        </span>
      </div>

      {info && info.state !== "clean" && (
        <div className="flex items-center gap-2 border-b bg-amber-500/10 px-3 py-2 text-xs">
          <IconAlertTriangle className="size-4 shrink-0 text-amber-500" />
          <span className="flex-1 capitalize">{info.state.replaceAll("-", " ")} in progress</span>
          <BusyHint reason={blocked} className="gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={!!busy}
              onClick={() => void commands.abort(repo)}
            >
              Abort
            </Button>
            <Button
              size="xs"
              onClick={() => void commands.continue(repo)}
              disabled={!!busy || conflicted.length > 0}
            >
              Continue
            </Button>
          </BusyHint>
        </div>
      )}

      <div ref={setScroller} className="min-h-0 flex-1 overflow-y-auto">
        {/* One child: file lists watch its size to learn when the content above them moves. */}
        <div>
          {conflicted.length > 0 && (
            <Section title="Conflicts" count={conflicted.length}>
              <FileList
                label="Conflicts"
                files={conflicted}
                selectedPath={selected("unstaged")}
                onOpen={handlers.openUnstaged}
                actions={handlers.conflictActions}
                disabledReason={blocked}
                scroller={scroller}
                stickyTop={SECTION_HEADER}
              />
            </Section>
          )}
          <Section
            title="Unstaged Files"
            count={unstaged.length}
            truncated={truncated}
            action={
              unstaged.length > 0 && (
                <BusyHint reason={blocked}>
                  <Button
                    size="xs"
                    variant="secondary"
                    className="h-5 rounded-md px-2 text-[11px]"
                    disabled={!!busy}
                    onClick={handlers.stageAll}
                  >
                    Stage All
                  </Button>
                </BusyHint>
              )
            }
          >
            <FileList
              label="Unstaged files"
              files={unstaged}
              selectedPath={selected("unstaged")}
              onOpen={handlers.openUnstaged}
              actions={handlers.unstagedActions}
              disabledReason={blocked}
              scroller={scroller}
              stickyTop={SECTION_HEADER}
            />
            <Overflow count={status?.unstaged.length ?? 0} truncated={truncated} />
          </Section>
          <Section
            title="Staged Files"
            count={staged.length}
            truncated={truncated}
            action={
              staged.length > 0 && (
                <BusyHint reason={blocked}>
                  <Button
                    size="xs"
                    variant="secondary"
                    className="h-5 rounded-md px-2 text-[11px]"
                    disabled={!!busy}
                    onClick={handlers.unstageAll}
                  >
                    Unstage All
                  </Button>
                </BusyHint>
              )
            }
          >
            <FileList
              label="Staged files"
              files={staged}
              selectedPath={selected("staged")}
              onOpen={handlers.openStaged}
              actions={handlers.stagedActions}
              disabledReason={blocked}
              scroller={scroller}
              stickyTop={SECTION_HEADER}
            />
            <Overflow count={status?.staged.length ?? 0} truncated={truncated} />
          </Section>
        </div>
      </div>

      <CommitBox
        repo={repo}
        stagedCount={status?.staged.length ?? 0}
        truncated={truncated}
        conflicts={conflicted.length}
        unborn={info !== undefined && info.head.hash === null}
      />
    </div>
  );
}

function Overflow({ count, truncated }: { count: number; truncated: boolean }) {
  if (count <= MAX_LISTED_FILES && !truncated) return null;
  return (
    <p className="text-muted-foreground px-3 py-1 text-[11px]">
      {truncated ? "Too many changes to list them all." : `…and ${count - MAX_LISTED_FILES} more`}
    </p>
  );
}

function Section({
  title,
  count,
  truncated = false,
  action,
  children,
}: {
  title: string;
  count: number;
  truncated?: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  // Remembered across selections and restarts, like the other panel layout.
  const collapsed = useLayout((s) => s.collapsed[title] ?? false);
  return (
    <Collapsible
      open={!collapsed}
      onOpenChange={(open) => useLayout.getState().setCollapsed(title, !open)}
    >
      <div
        className="bg-background/95 sticky top-0 z-10 flex items-center gap-1 px-2 backdrop-blur"
        style={{ height: SECTION_HEADER }}
      >
        <CollapsibleTrigger className="flex flex-1 items-center gap-1 text-[12px] font-medium [&[data-panel-open]>svg]:rotate-0">
          <IconChevronDown className="size-3.5 -rotate-90 transition-transform" />
          {title}
          <span className="text-muted-foreground tabular-nums">
            ({count}
            {truncated && "+"})
          </span>
        </CollapsibleTrigger>
        {action}
      </div>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

/** Commit focus requests already handled, per repository (see `RepoUi.commitFocusToken`). */
const focusHandled = new Map<RepoId, number>();

function CommitBox({
  repo,
  stagedCount,
  truncated,
  conflicts,
  unborn,
}: {
  repo: RepoId;
  stagedCount: number;
  truncated: boolean;
  conflicts: number;
  /** No commit yet: nothing to amend. */
  unborn: boolean;
}) {
  const draft = useDraft(repo);
  const setDraft = useDrafts((s) => s.set);
  const busy = useBusy(repo);
  const summaryRef = useRef<HTMLInputElement>(null);

  // "Commit…" from the menu, wherever the focus was (see `RepoLayout`).
  const focusToken = useRepoUiStore((s) => s.byRepo[repo]?.commitFocusToken ?? 0);
  useEffect(() => {
    if (focusToken <= (focusHandled.get(repo) ?? 0)) return;
    focusHandled.set(repo, focusToken);
    summaryRef.current?.focus();
  }, [repo, focusToken]);

  // Prefill the previous message when amending.
  useEffect(() => {
    if (!draft.amend || draft.summary || draft.description) return;
    api("repo.lastCommitMessage", repo).then(
      (msg) => {
        // Keep what the user typed (or unchecked) while the message was loading.
        const now = useDrafts.getState().drafts[repo];
        if (!now?.amend || now.summary || now.description) return;
        const [summary = "", ...rest] = msg.split("\n");
        const description = rest.join("\n").replace(/^\n+/, "");
        setDraft(repo, { summary, description, prefill: draftMessage({ summary, description }) });
      },
      // Without a previous message (e.g. no commits yet) the user types one.
      () => {},
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.amend]);

  const setAmend = (amend: boolean) => {
    if (amend) setDraft(repo, { amend });
    else useDrafts.getState().stopAmending(repo);
  };

  const blocked = busy
    ? busyReason(busy)
    : conflicts > 0
      ? "Resolve the conflicts first."
      : undefined;
  // Amending may change only the message, but git rejects an empty one either way.
  const canCommit = !blocked && draft.summary.trim().length > 0 && (draft.amend || stagedCount > 0);

  const commit = async () => {
    if (!canCommit) return;
    const result = await runAction(
      repo,
      "Commit",
      () => api("repo.commit", repo, draftMessage(draft), { amend: draft.amend }),
      { status: draft.amend ? "Amending commit…" : "Committing…" },
    );
    if (result.ok) useDrafts.getState().clear(repo);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Not while an input method is composing text (its keystrokes report key "Process").
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void commit();
    }
  };

  // A pasted multi-line message fills the description too.
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text/plain");
    if (!/[\r\n]/.test(text)) return;
    e.preventDefault();
    const [first = "", ...rest] = text.split(/\r?\n/);
    const input = e.currentTarget;
    const start = input.selectionStart ?? draft.summary.length;
    const end = input.selectionEnd ?? start;
    const more = rest.join("\n").replace(/^\n+/, "").trimEnd();
    setDraft(repo, {
      summary: draft.summary.slice(0, start) + first + draft.summary.slice(end),
      description: more
        ? draft.description
          ? `${more}\n${draft.description}`
          : more
        : draft.description,
    });
  };

  const over = draft.summary.length - 72;
  const files = `${stagedCount}${truncated ? "+" : ""} ${stagedCount === 1 && !truncated ? "File" : "Files"}`;

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t p-3">
      <Label
        className="flex items-center gap-2 text-xs font-normal"
        title={unborn ? "There is no commit to amend yet." : undefined}
      >
        <Checkbox
          checked={draft.amend}
          disabled={unborn && !draft.amend}
          onCheckedChange={(c) => setAmend(c)}
        />
        Amend previous commit
      </Label>
      <div className="relative">
        <Input
          ref={summaryRef}
          value={draft.summary}
          onChange={(e) => setDraft(repo, { summary: e.target.value })}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder="Commit summary"
          aria-label="Commit summary"
          className="h-8 rounded-lg pr-10 text-[13px]"
          spellCheck
        />
        <span
          className={cn(
            "absolute top-1/2 right-3 -translate-y-1/2 text-[11px] tabular-nums",
            over > 0 ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {72 - draft.summary.length}
        </span>
      </div>
      <Textarea
        value={draft.description}
        onChange={(e) => setDraft(repo, { description: e.target.value })}
        onKeyDown={onKeyDown}
        placeholder="Description"
        aria-label="Commit description"
        className="max-h-48 min-h-20 resize-none rounded-lg text-[13px]"
        spellCheck
      />
      <BusyHint reason={blocked} className="flex-col">
        <Button onClick={() => void commit()} disabled={!canCommit} className="h-9 rounded-lg">
          {draft.amend
            ? "Amend Previous Commit"
            : stagedCount === 0
              ? "Stage Changes to Commit"
              : `Commit Changes to ${files}`}
          <span className="text-[10px] opacity-60">{modKey}↵</span>
        </Button>
      </BusyHint>
    </div>
  );
}
