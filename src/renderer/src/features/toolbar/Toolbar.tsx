import type { RepoId } from "@shared/domain";
import {
  IconArrowDown,
  IconArrowUp,
  IconChevronDown,
  IconGitBranch,
  IconLayoutSidebar,
  IconLayoutSidebarRight,
  IconPackageExport,
  IconPackageImport,
  IconRefresh,
  IconServer,
  IconTerminal2,
  IconX,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { useRefs, useRepoInfo, useStatus } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { type Busy, busyReason, useBusy } from "@/stores/busy";
import { useLayout } from "@/stores/repo-ui";
import { commands } from "../commands";

/**
 * A button with a menu beside it: two halves that meet at a seam, each with its own hover, and
 * a lighter hover over both so they read as one control.
 */
const SPLIT = "hover:bg-muted/40 flex items-center rounded-lg";
const SPLIT_MENU =
  "text-muted-foreground hover:text-foreground hover:bg-muted data-[popup-open]:bg-muted flex h-11 w-4 items-center justify-center rounded-l-none rounded-r-lg";

function ToolButton({
  label,
  icon,
  onClick,
  disabled,
  badge,
  tooltip,
  className,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  badge?: number;
  tooltip?: string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            className={cn(
              "text-muted-foreground hover:text-foreground hover:bg-muted relative flex h-11 w-14 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] disabled:opacity-40 [&_svg]:size-[18px]",
              className,
            )}
          />
        }
      >
        {icon}
        <span>{label}</span>
        {badge ? (
          <span className="bg-primary text-primary-foreground absolute top-1 right-2 rounded-full px-1 text-[9px] leading-3.5 font-semibold tabular-nums">
            {badge}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipContent>{tooltip ?? label}</TooltipContent>
    </Tooltip>
  );
}

/** The running repository-changing operation, with a cancel button for network operations. */
function BusyIndicator({ repo, busy }: { repo: RepoId; busy: Busy }) {
  return (
    <div
      role="status"
      className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs"
      title={busy.label}
    >
      <Spinner className="size-3.5 shrink-0" />
      <span className="truncate">{busy.label}</span>
      {busy.cancellable && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Cancel"
          title="Cancel"
          onClick={() => commands.cancel(repo)}
        >
          <IconX />
        </Button>
      )}
    </div>
  );
}

export function Toolbar({ repo }: { repo: RepoId }) {
  const { data: info } = useRepoInfo(repo);
  const { data: refs } = useRefs(repo);
  const { data: status } = useStatus(repo);
  const layout = useLayout();
  const busy = useBusy(repo);
  // While an operation runs, the actions that change the repository wait for it.
  const reason = busy ? busyReason(busy) : undefined;

  const head = refs?.refs.find((r) => r.kind === "branch" && r.isHead);
  const dirty = status ? status.staged.length + status.unstaged.length > 0 : false;
  const remote = info?.location.kind === "ssh" ? info.location.host : null;

  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b px-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="min-w-0">
          <div className="text-muted-foreground flex items-center gap-1 text-[10px] tracking-wide uppercase">
            repository
            {remote && (
              <span className="flex items-center gap-0.5 rounded bg-sky-500/15 px-1 text-sky-400 normal-case">
                <IconServer className="size-3" />
                {remote}
              </span>
            )}
          </div>
          <div className="truncate text-sm font-semibold" title={info?.workTree}>
            {info?.name ?? "…"}
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-muted-foreground text-[10px] tracking-wide uppercase">branch</div>
          <div className="flex items-center gap-1 truncate text-sm">
            <IconGitBranch className="text-muted-foreground size-3.5 shrink-0" />
            <span className="truncate">
              {info?.head.branch ??
                (info?.head.hash ? `detached @ ${info.head.hash.slice(0, 7)}` : "—")}
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-0.5">
        <div className={SPLIT}>
          <ToolButton
            className="w-12 rounded-r-none"
            label="Pull"
            icon={<IconArrowDown />}
            badge={head?.behind}
            disabled={!!busy}
            tooltip={reason ?? "Pull (fast-forward if possible)"}
            onClick={() => void commands.pull(repo)}
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label="More options"
                  disabled={!!busy}
                  title={reason}
                  className={cn(SPLIT_MENU, "disabled:opacity-40")}
                />
              }
            >
              <IconChevronDown className="size-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-52">
              <DropdownMenuItem onClick={() => void commands.fetch(repo)}>
                Fetch all
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void commands.pull(repo, "ff-only")}>
                Pull (fast-forward only)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void commands.pull(repo, "merge")}>
                Pull (merge)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void commands.pull(repo, "rebase")}>
                Pull (rebase)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className={SPLIT}>
          <ToolButton
            className="w-12 rounded-r-none"
            label="Push"
            icon={<IconArrowUp />}
            badge={head?.ahead}
            disabled={!!busy}
            tooltip={reason}
            onClick={() => void commands.push(repo)}
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label="More options"
                  disabled={!!busy}
                  title={reason}
                  className={cn(SPLIT_MENU, "disabled:opacity-40")}
                />
              }
            >
              <IconChevronDown className="size-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-52">
              <DropdownMenuItem onClick={() => void commands.push(repo)}>Push</DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => void commands.push(repo, true)}
              >
                Force push (with lease)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <ToolButton
          label="Fetch"
          icon={<IconRefresh />}
          disabled={!!busy}
          tooltip={reason}
          onClick={() => void commands.fetch(repo)}
        />
        <ToolButton
          label="Branch"
          icon={<IconGitBranch />}
          disabled={!info?.head.hash || !!busy}
          tooltip={reason}
          onClick={() => void commands.createBranch(repo, "HEAD", info?.head.branch ?? "HEAD")}
        />
        <ToolButton
          label="Stash"
          icon={<IconPackageImport />}
          disabled={!dirty || !!busy}
          tooltip={reason}
          onClick={() => void commands.stash(repo)}
        />
        <ToolButton
          label="Pop"
          icon={<IconPackageExport />}
          disabled={(refs?.stashes.length ?? 0) === 0 || !!busy}
          tooltip={reason}
          onClick={() => void commands.pop(repo)}
        />
        <ToolButton
          label="Terminal"
          icon={<IconTerminal2 />}
          onClick={() => void api("shell.openTerminal", repo)}
        />
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
        {busy && <BusyIndicator repo={repo} busy={busy} />}
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(!layout.sidebar && "text-muted-foreground")}
          onClick={layout.toggleSidebar}
          title="Toggle sidebar"
        >
          <IconLayoutSidebar />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(!layout.details && "text-muted-foreground")}
          onClick={layout.toggleDetails}
          title="Toggle details panel"
        >
          <IconLayoutSidebarRight />
        </Button>
      </div>
    </div>
  );
}
