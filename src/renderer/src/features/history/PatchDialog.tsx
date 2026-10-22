import type { PatchInfo, PatchMode, RepoId } from "@shared/domain";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleX,
  IconFileDiff,
  IconUpload,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useDeferredValue, useRef, useState } from "react";
import { create } from "zustand";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { keys } from "@/lib/queries";
import { cn } from "@/lib/utils";

interface PatchRequest {
  readonly repo: RepoId;
  readonly resolve: (choice: { patch: string; mode: PatchMode } | null) => void;
}

const usePatchDialog = create<{ request: PatchRequest | null }>()(() => ({ request: null }));

/** Asks for a patch and how to apply it; resolves to null when cancelled. */
export const choosePatch = (repo: RepoId) =>
  new Promise<{ patch: string; mode: PatchMode } | null>((resolve) => {
    usePatchDialog.getState().request?.resolve(null);
    usePatchDialog.setState({ request: { repo, resolve } });
  });

export function PatchDialogHost() {
  const request = usePatchDialog((s) => s.request);
  const close = (choice: { patch: string; mode: PatchMode } | null) => {
    request?.resolve(choice);
    usePatchDialog.setState({ request: null });
  };
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && close(null)}>
      {request && <PatchBody repo={request.repo} onDone={close} />}
    </Dialog>
  );
}

const MODES: { mode: PatchMode; label: string; hint: string }[] = [
  { mode: "commit", label: "Commit", hint: "Creates its commits (git am)" },
  { mode: "worktree", label: "Working tree", hint: "Changes the files only (git apply)" },
  { mode: "index", label: "Stage", hint: "Changes the files and stages them" },
];

function PatchBody({
  repo,
  onDone,
}: {
  repo: RepoId;
  onDone: (choice: { patch: string; mode: PatchMode } | null) => void;
}) {
  const [patch, setPatch] = useState("");
  const [name, setName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [mode, setMode] = useState<PatchMode | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const checked = useDeferredValue(patch);
  const check = useQuery({
    queryKey: [...keys.repo(repo), "check-patch", checked],
    queryFn: () => api("repo.checkPatch", repo, checked),
    enabled: checked.trim().length > 0,
    staleTime: 0,
    gcTime: 0,
  });
  const info = checked === patch ? check.data : undefined;
  const mailbox = (info?.commits.length ?? 0) > 0;
  const chosen = mode ?? (mailbox ? "commit" : "worktree");

  const load = async (file: File) => {
    setPatch(await file.text());
    setName(file.name);
  };

  return (
    <DialogContent className="gap-4 sm:max-w-2xl" showCloseButton={false}>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <IconFileDiff className="text-primary size-4" />
          Apply patch
        </DialogTitle>
        <DialogDescription>
          A patch made with git format-patch, or a diff. Drop a file here, choose one, or paste it.
        </DialogDescription>
      </DialogHeader>

      <div
        className={cn(
          "relative rounded-lg border border-dashed transition-colors",
          dragging ? "border-primary bg-primary/5" : "border-border",
        )}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files[0];
          if (file) void load(file);
        }}
      >
        <Textarea
          value={patch}
          onChange={(e) => {
            setPatch(e.target.value);
            setName(null);
          }}
          placeholder={
            "From 1a2b3c4… Mon Sep 17 00:00:00 2001\nSubject: [PATCH] …\n\ndiff --git a/… b/…"
          }
          spellCheck={false}
          className="h-40 resize-none rounded-lg border-0 bg-transparent font-mono text-[11px] leading-relaxed whitespace-pre shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <div className="absolute right-2 bottom-2 flex items-center gap-2">
          {name && <span className="text-muted-foreground text-[11px]">{name}</span>}
          <Button size="sm" variant="secondary" onClick={() => fileInput.current?.click()}>
            <IconUpload />
            Choose File…
          </Button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".patch,.diff,.mbox,.eml,text/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void load(file);
            e.target.value = "";
          }}
        />
      </div>

      {patch.trim() && <CheckResult info={info} pending={!info} />}

      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Apply as">
        {MODES.map((m) => {
          const disabled = m.mode === "commit" && !mailbox;
          return (
            <button
              key={m.mode}
              type="button"
              role="radio"
              aria-checked={chosen === m.mode}
              disabled={disabled}
              onClick={() => setMode(m.mode)}
              className={cn(
                "flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-40",
                chosen === m.mode && !disabled
                  ? "border-primary bg-primary/10"
                  : "hover:bg-muted/60",
              )}
            >
              <span className="text-[13px] font-medium">{m.label}</span>
              <span className="text-muted-foreground text-[11px]">
                {disabled ? "Only for patches with commits" : m.hint}
              </span>
            </button>
          );
        })}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onDone(null)}>
          Cancel
        </Button>
        <Button
          disabled={!info || info.applies === "no" || (chosen === "commit" && !mailbox)}
          onClick={() =>
            onDone({ patch, mode: chosen === "commit" && !mailbox ? "worktree" : chosen })
          }
        >
          {chosen === "commit" && info
            ? info.commits.length === 1
              ? "Apply Commit"
              : `Apply ${info.commits.length} Commits`
            : "Apply Patch"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function CheckResult({ info, pending }: { info: PatchInfo | undefined; pending: boolean }) {
  if (pending || !info) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 text-[12px]">
        <Spinner /> Checking the patch…
      </div>
    );
  }
  const additions = info.files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const deletions = info.files.reduce((n, f) => n + (f.deletions ?? 0), 0);
  return (
    <div className="grid gap-2 text-[12px]">
      <div className="flex items-center gap-2">
        {info.applies === "clean" ? (
          <IconCircleCheck className="size-4 text-emerald-500" />
        ) : info.applies === "three-way" ? (
          <IconAlertTriangle className="size-4 text-amber-500" />
        ) : (
          <IconCircleX className="text-destructive size-4" />
        )}
        <span className="font-medium">
          {info.applies === "clean"
            ? "Applies cleanly"
            : info.applies === "three-way"
              ? "Applies with a three-way merge, which may leave conflicts"
              : "Does not apply"}
        </span>
        {info.files.length > 0 && (
          <span className="text-muted-foreground ml-auto tabular-nums">
            {info.commits.length > 0 &&
              `${info.commits.length} ${info.commits.length === 1 ? "commit" : "commits"} · `}
            {info.files.length} {info.files.length === 1 ? "file" : "files"}{" "}
            <span className="font-mono text-[11px] text-emerald-500">+{additions}</span>{" "}
            <span className="font-mono text-[11px] text-red-500">-{deletions}</span>
          </span>
        )}
      </div>
      {info.error && info.applies !== "clean" && (
        <pre className="bg-muted/50 text-muted-foreground max-h-20 overflow-auto rounded-md px-2.5 py-1.5 font-mono text-[11px] whitespace-pre-wrap">
          {info.error}
        </pre>
      )}
      {info.commits.length > 0 && (
        <ol className="text-muted-foreground max-h-24 list-inside list-decimal overflow-y-auto">
          {info.commits.map((s, i) => (
            <li key={i} className="truncate">
              {s}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
