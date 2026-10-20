import type { Ref } from "@shared/domain";
import { IconCheck, IconCloud, IconDeviceLaptop, IconTag } from "@tabler/icons-react";
import { memo } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { laneColor } from "@/lib/graph-colors";
import { cn } from "@/lib/utils";

interface Pill {
  readonly label: string;
  readonly local: Ref | null;
  readonly remotes: Ref[];
  readonly tag: Ref | null;
}

/** Merges `main` and `origin/main` (when they point at the same commit) into one pill. */
export const groupRefs = (refs: readonly Ref[]): Pill[] => {
  const pills: Pill[] = [];
  const byName = new Map<string, Pill>();
  const sorted = refs.toSorted((a, b) => rank(a) - rank(b));
  for (const ref of sorted) {
    if (ref.kind === "branch") {
      const p: Pill = { label: ref.short, local: ref, remotes: [], tag: null };
      byName.set(ref.short, p);
      pills.push(p);
    } else if (ref.kind === "remote") {
      const name = ref.short.slice((ref.remote?.length ?? 0) + 1);
      const p = byName.get(name);
      if (p?.local) p.remotes.push(ref);
      else pills.push({ label: ref.short, local: null, remotes: [ref], tag: null });
    } else if (ref.kind === "tag") {
      pills.push({ label: ref.short, local: null, remotes: [], tag: ref });
    }
  }
  return pills;
};

const rank = (r: Ref) => (r.isHead ? 0 : r.kind === "branch" ? 1 : r.kind === "remote" ? 2 : 3);

interface Props {
  readonly refs: readonly Ref[];
  readonly color: number;
  readonly onDoubleClick?: (ref: Ref) => void;
}

export const RefPills = memo(function RefPills({ refs, color, onDoubleClick }: Props) {
  const pills = groupRefs(refs);
  if (pills.length === 0) return null;
  const [first, ...rest] = pills;
  const c = laneColor(color);
  return (
    <div className="flex min-w-0 items-center gap-1">
      <PillView pill={first!} color={c} onDoubleClick={onDoubleClick} />
      {rest.length > 0 && (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="bg-muted text-muted-foreground shrink-0 rounded px-1 text-[10px] leading-4 font-medium tabular-nums" />
            }
          >
            +{rest.length}
          </TooltipTrigger>
          <TooltipContent side="right" className="flex flex-col items-start gap-1">
            {rest.map((p) => (
              <span key={p.label}>{p.label}</span>
            ))}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
});

function PillView({
  pill,
  color,
  onDoubleClick,
}: {
  pill: Pill;
  color: string;
  onDoubleClick?: (ref: Ref) => void;
}) {
  const head = pill.local?.isHead ?? false;
  const ref = pill.local ?? pill.remotes[0] ?? pill.tag!;
  return (
    <span
      className={cn(
        "flex h-5 min-w-0 items-center gap-1 rounded-md border px-1.5 text-[11px] leading-none",
        head ? "font-semibold" : "font-medium",
      )}
      style={{
        borderColor: `color-mix(in oklch, ${color} 60%, transparent)`,
        backgroundColor: `color-mix(in oklch, ${color} ${head ? 30 : 16}%, transparent)`,
      }}
      title={[pill.local?.short, ...pill.remotes.map((r) => r.short), pill.tag?.short]
        .filter(Boolean)
        .join(", ")}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onDoubleClick?.(ref);
      }}
    >
      {head && <IconCheck className="size-3 shrink-0" />}
      <span className="truncate">{pill.label}</span>
      {pill.local && <IconDeviceLaptop className="size-3 shrink-0 opacity-70" />}
      {pill.remotes.length > 0 && <IconCloud className="size-3 shrink-0 opacity-70" />}
      {pill.tag && <IconTag className="size-3 shrink-0 opacity-70" />}
    </span>
  );
}
