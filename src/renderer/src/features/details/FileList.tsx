import type { ChangeKind, FileChange } from "@shared/domain";
import { memo, type ReactNode } from "react";
import { basename, dirname } from "@/lib/format";
import { cn } from "@/lib/utils";

const KIND: Record<ChangeKind, { letter: string; className: string; label: string }> = {
  added: { letter: "A", className: "text-emerald-500", label: "Added" },
  untracked: { letter: "U", className: "text-emerald-500", label: "Untracked" },
  modified: { letter: "M", className: "text-amber-500", label: "Modified" },
  deleted: { letter: "D", className: "text-red-500", label: "Deleted" },
  renamed: { letter: "R", className: "text-sky-500", label: "Renamed" },
  copied: { letter: "C", className: "text-sky-500", label: "Copied" },
  typechange: { letter: "T", className: "text-violet-500", label: "Type changed" },
  conflicted: { letter: "!", className: "text-red-500", label: "Conflicted" },
};

export function ChangeBadge({ kind }: { kind: ChangeKind }) {
  const k = KIND[kind];
  return (
    <span
      title={k.label}
      className={cn("w-3 shrink-0 text-center font-mono text-[11px] font-bold", k.className)}
    >
      {k.letter}
    </span>
  );
}

interface Props {
  readonly files: readonly FileChange[];
  readonly selectedPath: string | null;
  readonly onOpen: (file: FileChange) => void;
  /** Hover actions for a file, shown before its line counts. */
  readonly renderActions?: (file: FileChange) => ReactNode;
  readonly onContextMenu?: (file: FileChange) => void;
}

/** Flat list of changed files ("path" view). */
export const FileList = memo(function FileList({
  files,
  selectedPath,
  onOpen,
  renderActions,
  onContextMenu,
}: Props) {
  return (
    <ul className="flex flex-col py-0.5">
      {files.map((f) => {
        const dir = dirname(f.path);
        return (
          <li
            key={`${f.oldPath ?? ""}:${f.path}`}
            className={cn(
              "group flex h-6 cursor-default items-center gap-2 px-3 text-[12px] select-none",
              selectedPath === f.path ? "bg-primary/25" : "hover:bg-muted/60",
            )}
            title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
            onClick={(e) => {
              // Clicking an action (even a disabled one) doesn't open the file.
              if (!(e.target as Element).closest("[data-row-actions]")) onOpen(f);
            }}
            onContextMenu={() => onContextMenu?.(f)}
          >
            <ChangeBadge kind={f.kind} />
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
              <span className="shrink-0 truncate">{basename(f.path)}</span>
              {dir && (
                <span className="text-muted-foreground min-w-0 truncate text-[11px]">{dir}</span>
              )}
            </span>
            {renderActions && (
              <span
                data-row-actions
                className="hidden shrink-0 items-center gap-0.5 group-hover:flex"
              >
                {renderActions(f)}
              </span>
            )}
            {(f.additions !== null || f.deletions !== null) && (
              <span className="shrink-0 font-mono text-[10px] tabular-nums">
                {f.additions ? <span className="text-emerald-500">+{f.additions}</span> : null}{" "}
                {f.deletions ? <span className="text-red-500">-{f.deletions}</span> : null}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
});
