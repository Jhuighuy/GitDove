import type { Ref } from "@shared/domain";
import { IconCheck, IconCloud, IconDeviceLaptop, IconTag } from "@tabler/icons-react";
import { Popover } from "@base-ui/react/popover";
import { memo, useRef } from "react";
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

/** The ref a pill stands for (and checks out). */
const refOf = (pill: Pill): Ref => pill.local ?? pill.remotes[0] ?? pill.tag!;

const rank = (r: Ref) => (r.isHead ? 0 : r.kind === "branch" ? 1 : r.kind === "remote" ? 2 : 3);

interface Props {
  readonly refs: readonly Ref[];
  readonly color: number;
  readonly onDoubleClick?: (ref: Ref) => void;
}

export const RefPills = memo(function RefPills({ refs, color, onDoubleClick }: Props) {
  const anchor = useRef<HTMLDivElement>(null);
  const pills = groupRefs(refs);
  if (pills.length === 0) return null;
  const [first, ...rest] = pills;
  const c = laneColor(color);
  return (
    <div ref={anchor} className="flex min-w-0 items-center gap-1">
      <PillView pill={first!} color={c} onDoubleClick={onDoubleClick} />
      {rest.length > 0 && (
        <Popover.Root>
          <Popover.Trigger
            openOnHover
            delay={100}
            closeDelay={150}
            nativeButton={false}
            render={
              <span
                className="flex h-5 shrink-0 items-center rounded-md px-1 text-[10px] font-medium tabular-nums"
                style={{ backgroundColor: `color-mix(in oklch, ${c} 22%, transparent)` }}
              />
            }
          >
            +{rest.length}
          </Popover.Trigger>
          <Popover.Portal>
            {/* Expands in place: the first pill stays where it was, the others below it. */}
            <Popover.Positioner
              anchor={anchor}
              side="bottom"
              align="start"
              sideOffset={({ anchor: a }) => -a.height - POPUP_PAD}
              alignOffset={-POPUP_PAD}
              className="isolate z-50"
            >
              <Popover.Popup
                className="bg-popover ring-foreground/10 flex max-h-(--available-height) max-w-80 min-w-[calc(var(--anchor-width)+4px)] flex-col gap-0.5 overflow-y-auto overscroll-contain rounded-lg p-0.5 shadow-lg ring-1 outline-hidden *:shrink-0"
                aria-label="Branches and tags"
              >
                {pills.map((p) => (
                  // A branch and a tag can share a label.
                  <PillView key={refOf(p).name} pill={p} color={c} onDoubleClick={onDoubleClick} />
                ))}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      )}
    </div>
  );
});

const LOCATION_ICON = "size-3 shrink-0 opacity-70 @max-[130px]:hidden";

/** Padding around the expanded pills, in pixels (`p-0.5`). */
const POPUP_PAD = 2;

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
  const ref = refOf(pill);
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
      {head && <IconCheck className="size-3 shrink-0 @max-[80px]:hidden" />}
      <span className="min-w-0 truncate">{pill.label}</span>
      {/* In a narrow branch column, the name keeps the room (the tooltip still tells). */}
      {pill.local && <IconDeviceLaptop className={LOCATION_ICON} />}
      {pill.remotes.length > 0 && <IconCloud className={LOCATION_ICON} />}
      {pill.tag && <IconTag className={LOCATION_ICON} />}
    </span>
  );
}
