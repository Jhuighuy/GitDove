import type { RebaseTodo, RepoId } from "@shared/domain";
import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconChevronDown,
  IconCornerLeftDown,
  IconGitCommit,
  IconGripVertical,
  IconListDetails,
  IconMessage2,
  IconX,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Avatar, useAvatarProviders } from "@/components/Avatar";
import { BusyHint } from "@/components/busy";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { reportOutcome, runAction } from "@/lib/actions";
import { api, isMac, modKey } from "@/lib/api";
import { relativeTime, shortHash } from "@/lib/format";
import { keys, useRepoInfo } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { busyReason, useBusy } from "@/stores/busy";
import { useRepoUiStore } from "@/stores/repo-ui";
import { MessageFields } from "./MessageFields";
import {
  combinedMessage,
  defaultMessage,
  type EditorAction,
  type EditorRow,
  editorSteps,
  editorSummary,
  folds,
  foldTargets,
  resultMessage,
  rowProblems,
} from "./plan";

interface ActionInfo {
  readonly label: string;
  readonly key: string;
  readonly hint: string;
  /** Text and background of its pill. */
  readonly tone: string;
}

const ACTIONS: Record<EditorAction, ActionInfo> = {
  pick: { label: "Pick", key: "P", hint: "Keep the commit", tone: "text-foreground/70 bg-muted" },
  reword: {
    label: "Reword",
    key: "R",
    hint: "Keep it, with a new message",
    tone: "text-sky-600 dark:text-sky-400 bg-sky-500/15",
  },
  edit: {
    label: "Edit",
    key: "E",
    hint: "Stop at it to change it",
    tone: "text-amber-600 dark:text-amber-400 bg-amber-500/15",
  },
  squash: {
    label: "Squash",
    key: "S",
    hint: "Meld into the commit below, keeping both messages",
    tone: "text-violet-600 dark:text-violet-400 bg-violet-500/15",
  },
  fixup: {
    label: "Fixup",
    key: "F",
    hint: "Meld into the commit below, dropping its message",
    tone: "text-violet-600 dark:text-violet-400 bg-violet-500/10",
  },
  drop: {
    label: "Drop",
    key: "D",
    hint: "Leave the commit out",
    tone: "text-red-600 dark:text-red-400 bg-red-500/15",
  },
};

const ORDER: EditorAction[] = ["pick", "reword", "edit", "squash", "fixup", "drop"];
const BY_KEY = new Map(ORDER.map((a) => [ACTIONS[a].key.toLowerCase(), a]));

/** The interactive rebase editor, shown in place of the graph. */
export function RebaseEditor({
  repo,
  base,
  selected,
}: {
  repo: RepoId;
  base: string | null;
  selected: readonly string[];
}) {
  const close = () => useRepoUiStore.getState().openRebase(repo, null);
  const todo = useQuery({
    queryKey: keys.rebaseTodo(repo, base),
    queryFn: () => api("repo.rebaseTodo", repo, base),
    staleTime: 0,
    gcTime: 0,
    // A branch that moves while planning makes the plan outdated: it is checked when it starts.
    refetchOnWindowFocus: false,
  });

  if (todo.isPending) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
        <Spinner /> Loading commits…
      </div>
    );
  }
  if (todo.error || todo.data.commits.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="text-muted-foreground text-sm">
          {todo.error ? todo.error.message : "There are no commits to rebase here."}
        </div>
        <Button variant="outline" onClick={close}>
          Close
        </Button>
      </div>
    );
  }
  return (
    <Editor
      key={todo.dataUpdatedAt}
      repo={repo}
      todo={todo.data}
      selected={selected}
      onClose={close}
    />
  );
}

function Editor({
  repo,
  todo,
  selected: initiallySelected,
  onClose,
}: {
  repo: RepoId;
  todo: RebaseTodo;
  selected: readonly string[];
  onClose: () => void;
}) {
  const initial = useMemo(
    (): EditorRow[] => todo.commits.map((commit) => ({ commit, action: "pick", message: null })),
    [todo],
  );
  // Oldest first, like git's todo list; shown newest first, like the graph.
  const [rows, setRows] = useState(initial);
  const n = rows.length;
  const [cursor, setCursor] = useState(() => {
    const i = rows.findIndex((r) => r.commit.hash === initiallySelected[0]);
    return i >= 0 ? i : n - 1;
  });
  const [editing, setEditing] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number | null } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { data: info } = useRepoInfo(repo);
  const busy = useBusy(repo);
  const avatarProviders = useAvatarProviders(repo);
  const select = useRepoUiStore((s) => s.select);

  const targets = foldTargets(rows);
  const problems = rowProblems(rows);
  const summary = editorSummary(todo.commits, rows);
  const pushed = rows.filter((r) => r.commit.pushed).length;
  const folded = (i: number) => targets.filter((t) => t === i).length;

  useEffect(() => listRef.current?.focus(), []);
  // The details panel follows the commit under the cursor.
  useEffect(() => {
    const hash = rows[cursor]?.commit.hash;
    if (hash) select(repo, { kind: "commit", hash });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, rows[cursor]?.commit.hash]);

  const update = (i: number, change: Partial<EditorRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...change } : r)));

  const setAction = (i: number, action: EditorAction) => {
    setRows((rs) => {
      const next = rs.map((r, j) => (j === i ? { ...r, action } : r));
      // Squashing into a commit with a message of its own adds to that message.
      if (action === "squash" && rs[i]!.action !== "squash") {
        const t = foldTargets(next)[i];
        const target = t == null ? null : next[t]!;
        if (t != null && target?.message != null)
          next[t] = {
            ...target,
            message: combinedMessage([target.message, rs[i]!.commit.message]),
          };
      }
      return next;
    });
    if (action === "reword") setEditing(i);
    else if (editing === i && (folds(action) || action === "drop")) setEditing(null);
  };

  /** Moves the row at `from` to sit at `to`, both in display order (newest first). */
  const moveDisplayed = (from: number, to: number) => {
    if (from === to) return;
    setRows((rs) => {
      const shown = rs.toReversed();
      const [row] = shown.splice(from, 1);
      shown.splice(to, 0, row!);
      return shown.toReversed();
    });
    setCursor(n - 1 - to);
    setEditing(null);
  };

  const start = async () => {
    if (!summary.changed || problems.size > 0 || busy) return;
    const label =
      summary.moved === 0 && summary.squashed === 0 && summary.dropped === 0 && summary.edited === 0
        ? summary.reworded === 1
          ? "Reword commit"
          : `Reword ${summary.reworded} commits`
        : `Rebase ${n} ${n === 1 ? "commit" : "commits"}`;
    const outcome = await runAction(
      repo,
      "Rebase",
      () => api("repo.rewrite", repo, { base: todo.base, steps: editorSteps(rows), label }),
      { status: "Rebasing…" },
    );
    if (outcome) {
      reportOutcome(repo, outcome, "Rebased");
      onClose();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing !== null || e.nativeEvent.isComposing) return;
    const shown = n - 1 - cursor;
    const mod = e.altKey || (isMac ? e.metaKey : e.ctrlKey);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const to = Math.min(n - 1, Math.max(0, shown + (e.key === "ArrowDown" ? 1 : -1)));
      if (mod) moveDisplayed(shown, to);
      else setCursor(n - 1 - to);
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void start();
    } else if (e.key === "Enter") {
      const row = rows[cursor];
      if (row && !folds(row.action) && row.action !== "drop") {
        e.preventDefault();
        setEditing(cursor);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      setAction(cursor, rows[cursor]?.action === "drop" ? "pick" : "drop");
    } else if (!e.metaKey && !e.ctrlKey && !e.altKey) {
      const action = BY_KEY.get(e.key.toLowerCase());
      if (action) {
        e.preventDefault();
        setAction(cursor, action);
      }
    }
  };

  const onDragOver = (e: React.DragEvent, shown: number) => {
    if (!drag) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const to = e.clientY < rect.top + rect.height / 2 ? shown : shown + 1;
    if (to !== drag.to) setDrag({ ...drag, to });
  };
  const onDrop = () => {
    if (drag?.to != null) moveDisplayed(drag.from, drag.to > drag.from ? drag.to - 1 : drag.to);
    setDrag(null);
  };

  const blocked = busy ? busyReason(busy) : undefined;
  const branch = info?.head.branch ?? "HEAD";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <IconListDetails className="text-primary size-4.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">Interactive rebase</div>
          <div className="text-muted-foreground truncate text-[11px]">
            {n} {n === 1 ? "commit" : "commits"} of{" "}
            <span className="text-foreground">{branch}</span>
            {todo.base ? (
              <>
                {" "}
                onto <span className="font-mono">{shortHash(todo.base)}</span> {todo.baseSubject}
              </>
            ) : (
              ", from the first commit"
            )}
          </div>
        </div>
        <div className="text-muted-foreground hidden items-center gap-1 text-[11px] lg:flex">
          {ORDER.map((a) => (
            <Kbd key={a} title={ACTIONS[a].label}>
              {ACTIONS[a].key}
            </Kbd>
          ))}
          <span className="mr-2 ml-0.5">actions</span>
          <Kbd>{isMac ? "⌥" : "Alt"}↑↓</Kbd>
          <span className="mr-2 ml-0.5">move</span>
          <Kbd>↵</Kbd>
          <span className="ml-0.5">message</span>
        </div>
        <Button variant="ghost" size="icon-sm" title="Close (Esc)" onClick={onClose}>
          <IconX />
        </Button>
      </div>

      <div
        ref={listRef}
        tabIndex={0}
        role="listbox"
        aria-label="Commits to rebase, newest first"
        aria-activedescendant={`rebase-row-${cursor}`}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto py-1 outline-none"
        onDragEnd={() => setDrag(null)}
      >
        {rows.toReversed().map((row, shown) => {
          const i = n - 1 - shown;
          const problem = problems.get(i);
          const melded = folded(i);
          const message =
            !folds(row.action) && row.action !== "drop" ? resultMessage(rows, i) : null;
          const subject = message?.split("\n", 1)[0] ?? row.commit.subject;
          const changedMessage = message !== null && message !== row.commit.message;
          return (
            <div key={row.commit.hash}>
              {drag && drag.to === shown && <DropLine />}
              <div
                id={`rebase-row-${i}`}
                role="option"
                aria-selected={cursor === i}
                draggable={editing !== i}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", row.commit.hash);
                  setDrag({ from: shown, to: null });
                  setCursor(i);
                }}
                onDragOver={(e) => onDragOver(e, shown)}
                onDrop={onDrop}
                onMouseDown={() => setCursor(i)}
                onDoubleClick={() => message !== null && setEditing(i)}
                className={cn(
                  "group mx-2 flex h-10 items-center gap-2 rounded-md pr-3 pl-1 text-[13px] select-none",
                  cursor === i ? "bg-primary/20" : "hover:bg-muted/60",
                  drag?.from === shown && "opacity-40",
                )}
              >
                <IconGripVertical className="text-muted-foreground/50 group-hover:text-muted-foreground size-4 shrink-0 cursor-grab" />
                <ActionPicker
                  action={row.action}
                  disabledFold={!hasOlder(rows, i)}
                  onChange={(a) => setAction(i, a)}
                />
                {folds(row.action) ? (
                  <span
                    className="flex shrink-0"
                    title={
                      targets[i] != null
                        ? `Melded into “${rows[targets[i]!]!.commit.subject}”`
                        : undefined
                    }
                  >
                    <IconCornerLeftDown
                      className={cn("size-4", problem ? "text-destructive" : "text-violet-500")}
                    />
                  </span>
                ) : (
                  <IconGitCommit
                    className={cn(
                      "size-4 shrink-0",
                      row.action === "drop" ? "text-muted-foreground/40" : "text-muted-foreground",
                    )}
                  />
                )}
                <div
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2",
                    row.action === "drop" &&
                      "text-muted-foreground line-through decoration-red-500/60",
                    row.action === "fixup" && "text-muted-foreground",
                  )}
                >
                  <span className="truncate" title={problem}>
                    {subject}
                  </span>
                  {changedMessage && row.message !== null && (
                    <span className="shrink-0 rounded bg-sky-500/15 px-1.5 text-[10px] font-medium text-sky-600 dark:text-sky-400">
                      new message
                    </span>
                  )}
                  {melded > 0 && (
                    <span className="shrink-0 rounded bg-violet-500/15 px-1.5 text-[10px] font-medium text-violet-600 tabular-nums dark:text-violet-400">
                      +{melded} melded
                    </span>
                  )}
                  {problem && (
                    <span className="text-destructive flex shrink-0 items-center gap-1 text-[11px]">
                      <IconAlertTriangle className="size-3.5" />
                      {problem}
                    </span>
                  )}
                </div>
                {message !== null && (
                  <button
                    type="button"
                    title="Edit message (↵)"
                    className="text-muted-foreground hover:text-foreground hover:bg-muted invisible flex size-6 shrink-0 items-center justify-center rounded group-hover:visible group-aria-selected:visible"
                    onClick={() => setEditing(i)}
                  >
                    <IconMessage2 className="size-3.5" />
                  </button>
                )}
                <div className="flex w-36 shrink-0 items-center gap-1.5 overflow-hidden">
                  <Avatar
                    name={row.commit.authorName}
                    email={row.commit.authorEmail}
                    providers={avatarProviders}
                  />
                  <span className="text-muted-foreground truncate text-xs">
                    {row.commit.authorName}
                  </span>
                </div>
                <span className="text-muted-foreground w-20 shrink-0 truncate text-xs tabular-nums">
                  {relativeTime(row.commit.authorTime)}
                </span>
                <span className="text-muted-foreground w-14 shrink-0 font-mono text-[11px]">
                  {shortHash(row.commit.hash)}
                </span>
              </div>
              {editing === i && message !== null && (
                <MessageEditor
                  initial={message}
                  hint={
                    melded > 0
                      ? `The message of this commit after ${melded} ${melded === 1 ? "commit is" : "commits are"} melded into it`
                      : undefined
                  }
                  onDone={(m) => {
                    if (m !== null) {
                      // What it would get anyway is no message of its own.
                      const custom = m === defaultMessage(rows, i) ? null : m;
                      update(i, {
                        message: custom,
                        ...(row.action === "pick" && custom !== null
                          ? { action: "reword" as const }
                          : {}),
                      });
                    }
                    setEditing(null);
                    listRef.current?.focus();
                  }}
                />
              )}
              {drag && shown === n - 1 && drag.to === n && <DropLine />}
            </div>
          );
        })}
        <div className="text-muted-foreground mx-2 mt-1 flex h-9 items-center gap-2 border-t border-dashed pl-7 text-[12px]">
          <span className="bg-muted-foreground/40 size-2 shrink-0 rounded-full" />
          {todo.base ? (
            <>
              <span className="font-mono text-[11px]">{shortHash(todo.base)}</span>
              <span className="truncate">{todo.baseSubject}</span>
              <span className="ml-auto shrink-0 text-[11px]">stays as it is</span>
            </>
          ) : (
            <span>The commits are rewritten from the very first one.</span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3 border-t px-4 py-2.5">
        <div className="min-w-0 flex-1 text-[12px]">
          <Summary summary={summary} />
          {(pushed > 0 || todo.merges > 0) && (
            <div className="text-muted-foreground mt-0.5 flex items-center gap-1.5 truncate text-[11px]">
              <IconAlertTriangle className="size-3.5 shrink-0 text-amber-500" />
              {[
                pushed > 0 &&
                  `${pushed} of these ${pushed === 1 ? "commit was" : "commits were"} pushed: you will need to force push.`,
                todo.merges > 0 &&
                  `${todo.merges} merge ${todo.merges === 1 ? "commit" : "commits"} in between will be flattened.`,
              ]
                .filter(Boolean)
                .join(" ")}
            </div>
          )}
        </div>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="outline"
          disabled={!summary.changed}
          onClick={() => {
            setRows(initial);
            setEditing(null);
          }}
        >
          <IconArrowBackUp />
          Reset
        </Button>
        <BusyHint reason={blocked}>
          <Button
            disabled={!summary.changed || problems.size > 0 || !!busy}
            title={problems.size > 0 ? [...problems.values()][0] : undefined}
            onClick={() => void start()}
          >
            Start Rebase
            <span className="text-[10px] opacity-60">{modKey}↵</span>
          </Button>
        </BusyHint>
      </div>
    </div>
  );
}

/** Whether a commit older than `i` is kept, which a commit at `i` could be folded into. */
const hasOlder = (rows: readonly EditorRow[], i: number) =>
  rows.slice(0, i).some((r) => r.action !== "drop");

function DropLine() {
  return <div className="bg-primary mx-3 h-0.5 rounded-full" />;
}

function Summary({ summary }: { summary: ReturnType<typeof editorSummary> }) {
  const parts = [
    summary.moved > 0 && `${summary.moved} moved`,
    summary.squashed > 0 && `${summary.squashed} melded`,
    summary.dropped > 0 && `${summary.dropped} dropped`,
    summary.reworded > 0 && `${summary.reworded} reworded`,
    summary.edited > 0 && `${summary.edited} to edit`,
  ].filter(Boolean);
  if (parts.length === 0)
    return (
      <span className="text-muted-foreground">
        Drag commits to reorder them, and choose what to do with each.
      </span>
    );
  return <span className="font-medium">{parts.join(" · ")}</span>;
}

function ActionPicker({
  action,
  disabledFold,
  onChange,
}: {
  action: EditorAction;
  /** Nothing older is left to fold into. */
  disabledFold: boolean;
  onChange: (action: EditorAction) => void;
}) {
  const info = ACTIONS[action];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            tabIndex={-1}
            className={cn(
              "flex h-6 w-20 shrink-0 items-center justify-between rounded-md pr-1 pl-2 text-[11px] font-semibold",
              info.tone,
            )}
          />
        }
      >
        {info.label}
        <IconChevronDown className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-72">
        {ORDER.map((a) => (
          <DropdownMenuItem
            key={a}
            disabled={disabledFold && folds(a)}
            onClick={() => onChange(a)}
            className="items-start gap-2.5 py-1.5"
          >
            <span
              className={cn(
                "mt-0.5 w-14 shrink-0 rounded px-1.5 text-center text-[10px] font-semibold",
                ACTIONS[a].tone,
              )}
            >
              {ACTIONS[a].label}
            </span>
            <span className="text-muted-foreground flex-1 text-[12px]">{ACTIONS[a].hint}</span>
            <DropdownMenuShortcut>{ACTIONS[a].key}</DropdownMenuShortcut>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MessageEditor({
  initial,
  hint,
  onDone,
}: {
  initial: string;
  hint?: string;
  onDone: (message: string | null) => void;
}) {
  const [message, setMessage] = useState(initial);
  const valid = message.trim().length > 0;
  return (
    <div className="bg-muted/30 mx-2 mt-1 mb-2 rounded-lg border p-3 pl-9">
      {hint && <div className="text-muted-foreground mb-2 text-[11px]">{hint}</div>}
      <MessageFields
        message={message}
        onChange={setMessage}
        onSubmit={() => valid && onDone(message.trim())}
        onCancel={() => onDone(null)}
        autoFocus
        rows={4}
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <span className="text-muted-foreground mr-auto text-[11px]">
          {modKey}↵ to keep it · Esc to cancel
        </span>
        <Button size="sm" variant="ghost" onClick={() => onDone(null)}>
          Cancel
        </Button>
        <Button size="sm" disabled={!valid} onClick={() => onDone(message.trim())}>
          Done
        </Button>
      </div>
    </div>
  );
}
