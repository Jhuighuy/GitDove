import { IconChevronDown } from "@tabler/icons-react";
import { type ReactNode, useRef } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { cn } from "@/lib/utils";

const HEADER = 28;
const MIN_BODY = 44;

interface StackState {
  /** Whether each section is expanded (default: expanded). */
  readonly open: Readonly<Record<string, boolean>>;
  /** Relative sizes of expanded sections (flex-grow weights). */
  readonly weights: Readonly<Record<string, number>>;
  /** Sections taken out of the sidebar (default: shown). */
  readonly hidden: Readonly<Record<string, true>>;
  setOpen(id: string, open: boolean): void;
  setHidden(id: string, hidden: boolean): void;
  setWeights(weights: Record<string, number>): void;
}

export const useSectionStack = create<StackState>()(
  persist(
    (set) => ({
      open: {},
      weights: {},
      hidden: {},
      setOpen: (id, open) => set((s) => ({ open: { ...s.open, [id]: open } })),
      setHidden: (id, hidden) =>
        set((s) => {
          const { [id]: _, ...rest } = s.hidden;
          return { hidden: hidden ? { ...rest, [id]: true } : rest };
        }),
      setWeights: (weights) => set((s) => ({ weights: { ...s.weights, ...weights } })),
    }),
    { name: "gitdove.sidebar-sections" },
  ),
);

export interface SectionDef {
  readonly id: string;
  readonly title: string;
  readonly icon: ReactNode;
  /** Right-aligned header content, e.g. a `2/8` count. */
  readonly count: ReactNode;
  readonly defaultOpen?: boolean;
  readonly onHeaderContextMenu?: () => void;
  readonly children: ReactNode;
}

/**
 * Vertically stacked, collapsible sidebar sections. Each expanded section
 * scrolls on its own, and the boundary between two expanded sections can be
 * dragged to resize them. Sections can be hidden altogether (`useSectionStack().hidden`).
 */
export function SectionStack({ sections: all }: { sections: readonly SectionDef[] }) {
  const { open, weights, hidden, setOpen, setWeights } = useSectionStack();
  const shown = all.filter((s) => !hidden[s.id]);
  // Hiding is global: a repository may lack every section left shown (e.g. Submodules).
  const sections = shown.length > 0 ? shown : all;
  const refs = useRef(new Map<string, HTMLDivElement>());
  const isOpen = (s: SectionDef) => open[s.id] ?? s.defaultOpen ?? true;

  const startResize = (e: React.PointerEvent, upperId: string, lowerId: string) => {
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    // Switch all expanded sections to pixel weights so the drag is exact.
    const px: Record<string, number> = {};
    for (const s of sections) {
      const el = refs.current.get(s.id);
      if (el && isOpen(s)) px[s.id] = el.getBoundingClientRect().height - HEADER;
    }
    const a0 = px[upperId] ?? 0;
    const b0 = px[lowerId] ?? 0;
    const startY = e.clientY;
    const move = (ev: PointerEvent) => {
      const total = a0 + b0;
      const a = Math.min(Math.max(a0 + ev.clientY - startY, MIN_BODY), total - MIN_BODY);
      setWeights({ ...px, [upperId]: a, [lowerId]: total - a });
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  // For each expanded section, the expanded section above it (resize partner).
  const partners = new Map<string, string>();
  sections.filter(isOpen).forEach((s, i, expanded) => {
    if (i > 0) partners.set(s.id, expanded[i - 1]!.id);
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {sections.map((s) => {
        const expanded = isOpen(s);
        const resizeWith = partners.get(s.id) ?? null;
        return (
          <div
            key={s.id}
            ref={(el) => {
              if (el) refs.current.set(s.id, el);
              else refs.current.delete(s.id);
            }}
            className="relative flex min-h-0 flex-col border-t first:border-t-0"
            style={
              expanded
                ? { flex: `${weights[s.id] ?? 1} 1 0px`, minHeight: HEADER + MIN_BODY }
                : { flex: "none" }
            }
          >
            {resizeWith && (
              <div
                role="separator"
                aria-orientation="horizontal"
                className="hover:bg-primary/50 active:bg-primary/70 absolute -top-[3px] right-0 left-0 z-20 h-[5px] cursor-row-resize transition-colors"
                onPointerDown={(e) => startResize(e, resizeWith, s.id)}
              />
            )}
            <button
              type="button"
              className="hover:bg-sidebar-accent text-muted-foreground flex h-7 w-full shrink-0 items-center gap-1.5 px-2 text-[11px] font-semibold tracking-wider uppercase select-none [&_svg]:size-3.5"
              onClick={() => setOpen(s.id, !expanded)}
              onContextMenu={s.onHeaderContextMenu}
            >
              <IconChevronDown className={cn("transition-transform", !expanded && "-rotate-90")} />
              {s.icon}
              <span className="truncate">{s.title}</span>
              <span className="ml-auto font-normal normal-case tabular-nums">{s.count}</span>
            </button>
            {expanded && <div className="min-h-0 flex-1 overflow-y-auto pb-1">{s.children}</div>}
          </div>
        );
      })}
    </div>
  );
}
