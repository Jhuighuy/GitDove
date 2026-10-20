import type { CSSProperties } from "react";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { HighlightRequest, HighlightResponse, ThemeKind } from "./highlight-protocol";
import { CHUNK } from "./highlight-protocol";
import type { DiffModel } from "./model";

/** Diffs with more lines than this are shown without highlighting. */
const MAX_LINES = 100_000;

let worker: Worker | null = null;
let nextDoc = 1;
const docs = new Map<number, DocHighlighter>();
/** Token styles, shared by all documents; indices come from the worker. */
const styles: CSSProperties[] = [];

const send = (req: HighlightRequest) => {
  if (!worker) {
    worker = new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (e: MessageEvent<HighlightResponse>) => {
      const msg = e.data;
      if (msg.type === "tokens" && msg.palette) {
        msg.palette.forEach((s, i) => (styles[msg.paletteBase + i] = toStyle(s)));
      }
      docs.get(msg.doc)?.receive(msg);
    });
  }
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  worker.postMessage(req);
};

const toStyle = (s: string): CSSProperties => {
  const [color, font] = s.split("|");
  const f = Number(font);
  return {
    color: color || undefined,
    fontStyle: f & 1 ? "italic" : undefined,
    fontWeight: f & 2 ? 600 : undefined,
    textDecoration: f & 4 ? "underline" : undefined,
  };
};

export const tokenStyle = (index: number): CSSProperties | undefined => styles[index];

/**
 * Highlighting state of one diff. Chunks of lines are requested as they become
 * visible and cached per theme; subscribers are notified once per frame.
 */
export class DocHighlighter {
  private id = 0;
  private readonly chunks = new Map<string, { starts: Uint32Array; tokens: Uint32Array }>();
  private readonly requested = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private plain = false;
  private frame = 0;
  version = 0;

  constructor(private readonly model: DiffModel) {}

  /** Sends the document to the worker; undone by `dispose`. */
  open() {
    this.id = nextDoc++;
    docs.set(this.id, this);
    send({
      type: "open",
      doc: this.id,
      path: this.model.diff.path,
      sides: this.model.sides as [string[], string[]],
      resets: this.model.resets as [number[], number[]],
    });
  }

  dispose() {
    docs.delete(this.id);
    send({ type: "close", doc: this.id });
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.chunks.clear();
    this.requested.clear();
    this.plain = false;
    this.id = 0;
  }

  /** Tokens of a line as (end column, style) pairs, or null if not highlighted yet. */
  tokens(theme: ThemeKind, side: 0 | 1, index: number): Uint32Array | null {
    if (index < 0) return null;
    const c = this.chunks.get(`${theme}:${side}:${Math.floor(index / CHUNK)}`);
    if (!c) return null;
    const i = index % CHUNK;
    return c.tokens.subarray(c.starts[i], c.starts[i + 1]);
  }

  /** Requests highlighting of side lines `[from, to]`. */
  ensure(theme: ThemeKind, side: 0 | 1, from: number, to: number) {
    if (!this.id || this.plain || from < 0 || to < from) return;
    for (let c = Math.floor(from / CHUNK); c <= Math.floor(to / CHUNK); c++) {
      const key = `${theme}:${side}:${c}`;
      if (this.requested.has(key)) continue;
      this.requested.add(key);
      send({ type: "highlight", doc: this.id, theme, side, chunk: c });
    }
  }

  receive(msg: HighlightResponse) {
    if (msg.type === "plain") {
      this.plain = true;
      return;
    }
    const key = `${msg.theme}:${msg.side}:${msg.chunk}`;
    // Chunks highlighted as dependencies arrive without being requested.
    this.requested.add(key);
    this.chunks.set(key, { starts: msg.starts, tokens: msg.tokens });
    if (!this.frame) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.version++;
        for (const l of this.listeners) l();
      });
    }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
}

/** A highlighter for the model, or null when the diff is too large to bother. */
export function useHighlighter(model: DiffModel): DocHighlighter | null {
  const hl = useMemo(
    () =>
      model.sides[0].length + model.sides[1].length > MAX_LINES ? null : new DocHighlighter(model),
    [model],
  );
  useEffect(() => {
    if (!hl) return;
    hl.open();
    return () => hl.dispose();
  }, [hl]);
  useSyncExternalStore(hl?.subscribe ?? noopSubscribe, () => hl?.version ?? 0);
  return hl;
}

const noopSubscribe = () => () => {};
