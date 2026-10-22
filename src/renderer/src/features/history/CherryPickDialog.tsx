import type { CherryPickOptions, RepoId } from "@shared/domain";
import { IconChevronDown, IconGitBranch, IconGitCherryPick } from "@tabler/icons-react";
import { useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { shortHash } from "@/lib/format";
import { useRefs } from "@/lib/queries";
import { cn } from "@/lib/utils";

interface PickRequest {
  readonly repo: RepoId;
  /** Oldest first, the order they are picked in. */
  readonly commits: readonly { readonly hash: string; readonly subject: string }[];
  readonly resolve: (options: CherryPickOptions | null) => void;
}

const useCherryPickDialog = create<{ request: PickRequest | null }>()(() => ({ request: null }));

/** Remembers whether to record where picked commits came from (`-x`). */
const usePickPrefs = create<{ recordOrigin: boolean; set(recordOrigin: boolean): void }>()(
  persist((set) => ({ recordOrigin: false, set: (recordOrigin) => set({ recordOrigin }) }), {
    name: "gitdove.cherry-pick",
  }),
);

/** Asks where and how to pick `commits`; resolves to null when cancelled. */
export const chooseCherryPick = (repo: RepoId, commits: PickRequest["commits"]) =>
  new Promise<CherryPickOptions | null>((resolve) => {
    useCherryPickDialog.getState().request?.resolve(null);
    useCherryPickDialog.setState({ request: { repo, commits, resolve } });
  });

export function CherryPickDialogHost() {
  const request = useCherryPickDialog((s) => s.request);
  const close = (options: CherryPickOptions | null) => {
    request?.resolve(options);
    useCherryPickDialog.setState({ request: null });
  };
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && close(null)}>
      {request && <CherryPickBody request={request} onDone={close} />}
    </Dialog>
  );
}

function CherryPickBody({
  request,
  onDone,
}: {
  request: PickRequest;
  onDone: (options: CherryPickOptions | null) => void;
}) {
  const { data: refs } = useRefs(request.repo);
  const branches = (refs?.refs ?? []).filter((r) => r.kind === "branch");
  const head = branches.find((r) => r.isHead) ?? null;
  const [target, setTarget] = useState<string | null>(head?.short ?? null);
  const prefs = usePickPrefs();
  const [noCommit, setNoCommit] = useState(false);
  const [open, setOpen] = useState(false);
  const onHead = target === null || target === head?.short;
  const count = request.commits.length;

  const submit = () =>
    onDone({
      branch: onHead ? null : target,
      recordOrigin: prefs.recordOrigin,
      noCommit: onHead && noCommit,
    });

  return (
    <DialogContent className="gap-4 sm:max-w-lg" showCloseButton={false}>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <IconGitCherryPick className="text-primary size-4" />
          {count === 1 ? "Cherry-pick commit" : `Cherry-pick ${count} commits`}
        </DialogTitle>
        <DialogDescription>
          {count === 1
            ? "Applies the commit's changes as a new commit on a branch."
            : "Applies the commits' changes as new commits on a branch, oldest first."}
        </DialogDescription>
      </DialogHeader>

      <ol className="bg-muted/40 max-h-40 overflow-y-auto rounded-lg border py-1 text-[12px]">
        {request.commits.map((c) => (
          <li key={c.hash} className="flex items-center gap-2 px-2.5 py-1">
            <span className="text-muted-foreground font-mono text-[11px]">{shortHash(c.hash)}</span>
            <span className="truncate">{c.subject}</span>
          </li>
        ))}
      </ol>

      <div className="grid gap-1.5">
        <Label className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          Onto branch
        </Label>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <Button
                variant="outline"
                className="h-8 justify-start gap-2 rounded-lg px-2.5 text-[13px] font-normal"
              />
            }
          >
            <IconGitBranch className="text-muted-foreground" />
            <span className="truncate">{target ?? "Detached HEAD"}</span>
            {onHead && <span className="text-muted-foreground text-[11px]">checked out</span>}
            <IconChevronDown className="text-muted-foreground ml-auto" />
          </PopoverTrigger>
          <PopoverContent className="w-(--anchor-width) p-0" align="start">
            <Command>
              <CommandInput placeholder="Find a branch…" />
              <CommandList className="max-h-64">
                <CommandEmpty>No branches found.</CommandEmpty>
                <CommandGroup>
                  {branches.map((b) => (
                    <CommandItem
                      key={b.name}
                      value={b.short}
                      data-checked={b.short === target}
                      onSelect={() => {
                        setTarget(b.short);
                        setOpen(false);
                      }}
                    >
                      <IconGitBranch className="text-muted-foreground" />
                      <span className="truncate">{b.short}</span>
                      {b.isHead && (
                        <span className="text-muted-foreground text-[11px]">checked out</span>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <p className="text-muted-foreground text-[11px]">
          {onHead
            ? "Conflicts, if any, stop the cherry-pick for you to resolve them."
            : `${target} is not checked out: the commits are applied without touching your working tree.`}
        </p>
      </div>

      <div className="grid gap-2.5">
        <Option
          checked={prefs.recordOrigin}
          onChange={prefs.set}
          label="Record where the commits came from"
          hint="Adds “(cherry picked from commit …)” to the messages, like git cherry-pick -x."
        />
        <Option
          checked={onHead && noCommit}
          disabled={!onHead}
          onChange={setNoCommit}
          label="Apply the changes without committing"
          hint={
            onHead
              ? "Stages the changes so that you can review them and commit yourself."
              : "Only for the checked out branch."
          }
        />
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onDone(null)}>
          Cancel
        </Button>
        <Button autoFocus onClick={submit} disabled={target === null && head !== null}>
          {count === 1 ? "Cherry-pick" : `Cherry-pick ${count} Commits`}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function Option({
  checked,
  disabled,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <Label
      className={cn(
        "flex items-start gap-2.5 font-normal",
        disabled && "cursor-default opacity-50",
      )}
    >
      <Checkbox
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(c) => onChange(c === true)}
      />
      <span className="grid gap-0.5">
        <span className="text-[13px]">{label}</span>
        <span className="text-muted-foreground text-[11px]">{hint}</span>
      </span>
    </Label>
  );
}
