import type { DiffTarget, FileContent, RepoId } from "@shared/domain";
import { type RefObject, useEffect, useRef, useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { formatBytes } from "@/lib/format";
import { useFileVersions } from "@/lib/queries";
import { cn } from "@/lib/utils";
import type { DiffMode } from "@/stores/repo-ui";

/** One side of the comparison, decoded. */
export type ImageSide =
  | { readonly kind: "missing" }
  | { readonly kind: "large"; readonly size: number }
  | { readonly kind: "loading"; readonly size: number }
  | { readonly kind: "error"; readonly size: number }
  | {
      readonly kind: "ready";
      readonly size: number;
      readonly url: string;
      readonly width: number;
      readonly height: number;
    };

type ReadyImage = Extract<ImageSide, { kind: "ready" }>;

/** Space taken by a caption above the images (px). */
const CAPTION = 24;
const GAP = 16;

/** Decodes `content` through an object URL that lives as long as the component. */
export function useImage(content: FileContent, mime: string): ImageSide {
  const [decoded, setDecoded] = useState<{
    content: FileContent;
    mime: string;
    side: ImageSide;
  } | null>(null);
  useEffect(() => {
    if (content.kind !== "blob") return;
    const size = content.bytes.length;
    const blob = new Blob([content.bytes as Uint8Array<ArrayBuffer>], { type: mime });
    const url = URL.createObjectURL(blob);
    let live = true;
    const done = (side: ImageSide) => {
      if (live) setDecoded({ content, mime, side });
    };
    const img = new Image();
    img.addEventListener("load", () =>
      done({ kind: "ready", size, url, width: img.naturalWidth, height: img.naturalHeight }),
    );
    img.addEventListener("error", () => done({ kind: "error", size }));
    img.src = url;
    return () => {
      live = false;
      URL.revokeObjectURL(url);
    };
  }, [content, mime]);
  if (decoded?.content === content && decoded.mime === mime) return decoded.side;
  return content.kind === "blob" ? { kind: "loading", size: content.bytes.length } : content;
}

/** Scale that fits a `width`×`height` box into the available space. */
export const fitScale = (
  width: number,
  height: number,
  availWidth: number,
  availHeight: number,
  upscale: boolean,
): number => {
  if (width <= 0 || height <= 0) return 1;
  const scale = Math.max(0, Math.min(availWidth / width, availHeight / height));
  return upscale ? scale : Math.min(1, scale);
};

function useSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

export function ImageDiff({
  repo,
  target,
  mime,
  mode,
}: Readonly<{
  repo: RepoId;
  target: DiffTarget;
  mime: string;
  mode: DiffMode;
}>) {
  const { data, error } = useFileVersions(repo, target);
  if (error) return <Notice className="text-destructive">{error.message}</Notice>;
  if (!data)
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  return <ImageCompare old={data.old} next={data.new} mime={mime} mode={mode} />;
}

function ImageCompare({
  old,
  next,
  mime,
  mode,
}: Readonly<{
  old: FileContent;
  next: FileContent;
  mime: string;
  mode: DiffMode;
}>) {
  const before = useImage(old, mime);
  const after = useImage(next, mime);
  const areaRef = useRef<HTMLDivElement>(null);
  const area = useSize(areaRef);

  const sides = labelSides(before, after);
  const swipe = mode === "unified" && before.kind === "ready" && after.kind === "ready";
  // Both sides share one scale, so that a change in size stays visible.
  const ready = [before, after].filter((s): s is ReadyImage => s.kind === "ready");
  const width = Math.max(0, ...ready.map((s) => s.width));
  const height = Math.max(0, ...ready.map((s) => s.height));
  const columns = swipe ? 1 : sides.length;
  const scale = fitScale(
    width,
    height,
    (area.width - GAP * (columns - 1)) / Math.max(1, columns),
    area.height - CAPTION,
    // Vector images scale up without losing detail.
    mime === "image/svg+xml",
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 p-4">
        <div
          ref={areaRef}
          className="flex h-full w-full items-center justify-center overflow-hidden"
          style={{ gap: GAP }}
        >
          {sides.length === 0 && <Notice>No content.</Notice>}
          {swipe && (
            <Swipe before={before} after={after} width={width} height={height} scale={scale} />
          )}
          {!swipe &&
            sides.map(([label, side]) => (
              <Panel key={label} label={label} side={side} scale={scale} />
            ))}
        </div>
      </div>
      <div className="text-muted-foreground flex h-7 shrink-0 items-center gap-4 border-t px-3 text-[11px]">
        {sides.map(([label, side]) => (
          <span key={label}>
            <span className="text-foreground font-medium">{label}</span> {describe(side)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The sides to show, labelled; an added or deleted image has only one. */
const labelSides = (before: ImageSide, after: ImageSide): (readonly [string, ImageSide])[] => {
  if (before.kind === "missing") return after.kind === "missing" ? [] : [["Added", after]];
  if (after.kind === "missing") return [["Deleted", before]];
  return [
    ["Before", before],
    ["After", after],
  ];
};

const describe = (side: ImageSide): string => {
  switch (side.kind) {
    case "missing":
      return "";
    case "ready":
      return `${side.width}×${side.height} · ${formatBytes(side.size)}`;
    default:
      return formatBytes(side.size);
  }
};

const placeholder = (side: ImageSide): React.ReactNode => {
  switch (side.kind) {
    case "loading":
      return <Spinner />;
    case "large":
      return `Too large to display (${formatBytes(side.size)}).`;
    default:
      return "Cannot display this image.";
  }
};

function Panel({
  label,
  side,
  scale,
}: Readonly<{ label: string; side: ImageSide; scale: number }>) {
  return (
    <figure className="flex min-w-0 flex-col items-center gap-1.5">
      <figcaption className="text-muted-foreground text-[11px]">{label}</figcaption>
      {side.kind === "ready" ? (
        <img
          src={side.url}
          alt={label}
          draggable={false}
          className="bg-checker max-w-none"
          style={{ width: side.width * scale, height: side.height * scale }}
        />
      ) : (
        <div className="text-muted-foreground flex min-h-24 min-w-48 items-center justify-center rounded border p-6 text-sm">
          {placeholder(side)}
        </div>
      )}
    </figure>
  );
}

function Swipe({
  before,
  after,
  width,
  height,
  scale,
}: Readonly<{
  before: ReadyImage;
  after: ReadyImage;
  width: number;
  height: number;
  scale: number;
}>) {
  // Percentage of the width, from the left, where "after" starts. Each side is
  // clipped at the divider, so that a smaller "after" does not show "before" around it.
  const [split, setSplit] = useState(50);
  const frame = { width: width * scale, height: height * scale };
  const place = (s: ReadyImage) => ({
    width: s.width * scale,
    height: s.height * scale,
    left: (frame.width - s.width * scale) / 2,
    top: (frame.height - s.height * scale) / 2,
  });
  return (
    <figure className="flex flex-col gap-1.5">
      <figcaption className="text-muted-foreground flex justify-between text-[11px]">
        <span>Before</span>
        <span>After</span>
      </figcaption>
      <div className="relative" style={frame}>
        <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>
          <img
            src={before.url}
            alt="Before"
            draggable={false}
            className="bg-checker absolute max-w-none"
            style={place(before)}
          />
        </div>
        <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${split}%)` }}>
          <img
            src={after.url}
            alt="After"
            draggable={false}
            className="bg-checker absolute max-w-none"
            style={place(after)}
          />
        </div>
        <div
          className="bg-primary pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2"
          style={{ left: `${split}%` }}
        />
        <input
          type="range"
          min={0}
          max={100}
          step={0.1}
          value={split}
          onChange={(e) => setSplit(Number(e.target.value))}
          aria-label="Before and after split"
          className="swipe-range absolute inset-0 h-full w-full"
        />
      </div>
    </figure>
  );
}

function Notice({
  className,
  children,
}: Readonly<{ className?: string; children: React.ReactNode }>) {
  return <div className={cn("text-muted-foreground p-6 text-sm", className)}>{children}</div>;
}
