import { type FileChange, type RepoId, renameSource } from "@shared/domain";
import {
  IconChevronDown,
  IconMinus,
  IconPlus,
  IconArrowBackUp,
  IconAlertTriangle,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { runAction } from "@/lib/actions";
import { api, modKey, useEvent } from "@/lib/api";
import { useRepoInfo, useStatus } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useRepoUi, useRepoUiStore } from "@/stores/repo-ui";
import { commands } from "../commands";
import { FileList } from "./FileList";

const MAX_FILES = 3000;

interface Draft {
  readonly summary: string;
  readonly description: string;
  readonly amend: boolean;
}

const useDrafts = create<{
  drafts: Record<RepoId, Draft>;
  set(repo: RepoId, d: Partial<Draft>): void;
}>()((set) => ({
  drafts: {},
  set: (repo, d) =>
    set((s) => ({
      drafts: {
        ...s.drafts,
        [repo]: { ...(s.drafts[repo] ?? { summary: "", description: "", amend: false }), ...d },
      },
    })),
}));

export function WipPanel({ repo }: { repo: RepoId }) {
  const { data: status } = useStatus(repo);
  const { data: info } = useRepoInfo(repo);
  const { diff } = useRepoUi(repo);
  const openDiff = useRepoUiStore((s) => s.openDiff);

  const staged = status?.staged ?? [];
  const unstaged = status?.unstaged ?? [];
  const conflicted = status?.conflicted ?? [];
  const total = staged.length + unstaged.length + conflicted.length;
  const selected = (kind: "staged" | "unstaged") => (diff?.kind === kind ? diff.path : null);

  const openUnstaged = (f: FileChange) =>
    openDiff(repo, { kind: "unstaged", path: f.path, untracked: f.kind === "untracked" });

  const stage = (paths: string[]) => runAction(repo, "Stage", () => api("repo.stage", repo, paths));
  const unstage = (paths: string[]) =>
    runAction(repo, "Unstage", () => api("repo.unstage", repo, paths));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-center gap-1.5 border-b px-3 text-xs">
        <span className="font-medium tabular-nums">
          {total} file {total === 1 ? "change" : "changes"}
        </span>
        <span className="text-muted-foreground">on</span>
        <span className="bg-sidebar-primary/15 text-sidebar-primary rounded px-1.5 py-0.5 font-medium">
          {info?.head.branch ?? (info?.head.hash ? "detached HEAD" : "—")}
        </span>
      </div>

      {info && info.state !== "clean" && (
        <div className="flex items-center gap-2 border-b bg-amber-500/10 px-3 py-2 text-xs">
          <IconAlertTriangle className="size-4 shrink-0 text-amber-500" />
          <span className="flex-1 capitalize">{info.state.replace("-", " ")} in progress</span>
          <Button size="xs" variant="outline" onClick={() => void commands.abort(repo)}>
            Abort
          </Button>
          <Button
            size="xs"
            onClick={() => void commands.continue(repo)}
            disabled={conflicted.length > 0}
          >
            Continue
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {conflicted.length > 0 && (
          <Section title="Conflicts" count={conflicted.length}>
            <FileList
              files={conflicted}
              selectedPath={selected("unstaged")}
              onOpen={openUnstaged}
              actions={(f) => (
                <RowAction label="Mark resolved" onClick={() => void stage([f.path])}>
                  <IconPlus />
                </RowAction>
              )}
            />
          </Section>
        )}
        <Section
          title="Unstaged Files"
          count={unstaged.length}
          action={
            unstaged.length > 0 && (
              <Button
                size="xs"
                variant="secondary"
                className="h-5 rounded-md px-2 text-[11px]"
                onClick={() => void runAction(repo, "Stage all", () => api("repo.stageAll", repo))}
              >
                Stage All
              </Button>
            )
          }
        >
          <FileList
            files={unstaged.slice(0, MAX_FILES)}
            selectedPath={selected("unstaged")}
            onOpen={openUnstaged}
            actions={(f) => (
              <>
                <RowAction
                  label="Discard changes"
                  onClick={() =>
                    void commands.discard(
                      repo,
                      f.kind === "untracked" ? [] : [f.path],
                      f.kind === "untracked" ? [f.path] : [],
                    )
                  }
                >
                  <IconArrowBackUp />
                </RowAction>
                <RowAction label="Stage file" onClick={() => void stage([f.path])}>
                  <IconPlus />
                </RowAction>
              </>
            )}
          />
          <Overflow count={unstaged.length} truncated={status?.truncated ?? false} />
        </Section>
        <Section
          title="Staged Files"
          count={staged.length}
          action={
            staged.length > 0 && (
              <Button
                size="xs"
                variant="secondary"
                className="h-5 rounded-md px-2 text-[11px]"
                onClick={() =>
                  void runAction(repo, "Unstage all", () => api("repo.unstageAll", repo))
                }
              >
                Unstage All
              </Button>
            )
          }
        >
          <FileList
            files={staged.slice(0, MAX_FILES)}
            selectedPath={selected("staged")}
            onOpen={(f) => openDiff(repo, { kind: "staged", path: f.path, ...renameSource(f) })}
            actions={(f) => (
              <RowAction label="Unstage file" onClick={() => void unstage([f.path])}>
                <IconMinus />
              </RowAction>
            )}
          />
          <Overflow count={staged.length} truncated={false} />
        </Section>
      </div>

      <CommitBox repo={repo} stagedCount={staged.length} />
    </div>
  );
}

function Overflow({ count, truncated }: { count: number; truncated: boolean }) {
  if (count <= MAX_FILES && !truncated) return null;
  return (
    <p className="text-muted-foreground px-3 py-1 text-[11px]">
      {truncated ? "Too many changes to list them all." : `…and ${count - MAX_FILES} more`}
    </p>
  );
}

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Collapsible defaultOpen>
      <div className="bg-background/95 sticky top-0 z-10 flex h-7 items-center gap-1 px-2 backdrop-blur">
        <CollapsibleTrigger className="flex flex-1 items-center gap-1 text-[12px] font-medium [&[data-panel-open]>svg]:rotate-0">
          <IconChevronDown className="size-3.5 -rotate-90 transition-transform" />
          {title}
          <span className="text-muted-foreground tabular-nums">({count})</span>
        </CollapsibleTrigger>
        {action}
      </div>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

function RowAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-5 items-center justify-center rounded [&_svg]:size-3.5"
            onClick={(e) => {
              e.stopPropagation();
              onClick();
            }}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function CommitBox({ repo, stagedCount }: { repo: RepoId; stagedCount: number }) {
  const draft = useDrafts((s) => s.drafts[repo]) ?? { summary: "", description: "", amend: false };
  const setDraft = useDrafts((s) => s.set);
  const [busy, setBusy] = useState(false);
  const summaryRef = useRef<HTMLInputElement>(null);

  useEvent("menu.command", ({ command }) => {
    if (command === "commit-focus") summaryRef.current?.focus();
  });

  // Prefill the previous message when amending.
  useEffect(() => {
    if (!draft.amend || draft.summary || draft.description) return;
    void api("repo.lastCommitMessage", repo).then((msg) => {
      const [summary = "", ...rest] = msg.split("\n");
      setDraft(repo, { summary, description: rest.join("\n").replace(/^\n+/, "") });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.amend]);

  const canCommit = !busy && (draft.amend || (stagedCount > 0 && draft.summary.trim().length > 0));

  const commit = async () => {
    if (!canCommit) return;
    setBusy(true);
    const message = draft.description.trim()
      ? `${draft.summary.trim()}\n\n${draft.description.trim()}`
      : draft.summary.trim();
    const ok = await runAction(repo, "Commit", async () => {
      await api("repo.commit", repo, message, { amend: draft.amend });
      return true;
    });
    setBusy(false);
    if (ok) setDraft(repo, { summary: "", description: "", amend: false });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void commit();
    }
  };

  const over = draft.summary.length - 72;

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t p-3">
      <Label className="flex items-center gap-2 text-xs font-normal">
        <Checkbox
          checked={draft.amend}
          onCheckedChange={(c) => setDraft(repo, { amend: c === true })}
        />
        Amend previous commit
      </Label>
      <div className="relative">
        <Input
          ref={summaryRef}
          value={draft.summary}
          onChange={(e) => setDraft(repo, { summary: e.target.value })}
          onKeyDown={onKeyDown}
          placeholder="Commit summary"
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
        className="max-h-48 min-h-20 resize-none rounded-lg text-[13px]"
        spellCheck
      />
      <Button onClick={() => void commit()} disabled={!canCommit} className="h-9 rounded-lg">
        {draft.amend
          ? "Amend Previous Commit"
          : stagedCount === 0
            ? "Stage Changes to Commit"
            : `Commit Changes to ${stagedCount} ${stagedCount === 1 ? "File" : "Files"}`}
        <span className="text-[10px] opacity-60">{modKey}↵</span>
      </Button>
    </div>
  );
}
