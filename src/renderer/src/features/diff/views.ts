/**
 * How a changed file can be shown. Text files have a line diff; other formats
 * add (or only have) views that render the whole file.
 */

export type DiffViewId = "diff" | "image";

export interface FileKind {
  /** Key under which the user's preferred view is remembered. */
  readonly id: string;
  /** Available views, the default first. */
  readonly views: readonly DiffViewId[];
  /** Media type for rendered views. */
  readonly mime?: string;
}

const RASTER_IMAGES: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const TEXT: FileKind = { id: "text", views: ["diff"] };
const SVG: FileKind = { id: "svg", views: ["diff", "image"], mime: "image/svg+xml" };

const extension = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

export const fileKind = (path: string): FileKind => {
  const ext = extension(path);
  if (ext === "svg") return SVG;
  const mime = RASTER_IMAGES[ext];
  return mime ? { id: "image", views: ["image"], mime } : TEXT;
};

/** The remembered view for this kind of file, or its default. */
export const viewFor = (
  kind: FileKind,
  preferred: Readonly<Record<string, DiffViewId>>,
): DiffViewId => {
  const view = preferred[kind.id];
  return view && kind.views.includes(view) ? view : kind.views[0]!;
};
