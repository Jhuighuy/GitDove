import type { CSSProperties } from "react";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { HighlightRequest, HighlightResponse, ThemeKind } from "./highlight-protocol";
import { CHUNK } from "./highlight-protocol";
import type { DiffModel } from "./model";

/** Diffs with more lines than this are shown without highlighting. */
const MAX_LINES = 100_000;
/** How often the worker may crash before highlighting is given up. */
const MAX_RESTARTS = 3;
/** Most lines whose tokens a document keeps from its predecessor. */
const MAX_FALLBACK = 5000;

let worker: Worker | null = null;
let restarts = 0;
let nextDoc = 1;
const docs = new Map<number, DocHighlighter>();
/** Token styles, shared by all documents; indices come from the worker. */
const styles: CSSProperties[] = [];

const startWorker = () => {
  const w = new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" });
  w.addEventListener("message", (e: MessageEvent<HighlightResponse>) => {
    // A replaced worker's last messages use its own style numbering.
    if (worker !== w) return;
    const msg = e.data;
    if (msg.type === "tokens" && msg.palette) {
      msg.palette.forEach((s, i) => (styles[msg.paletteBase + i] = toStyle(s)));
    }
    docs.get(msg.doc)?.receive(msg);
  });
  // An uncaught error leaves the worker in an unknown state: start a new one and send it the open
  // documents again, unless it keeps failing. It numbers its styles from 0 again.
  w.addEventListener("error", (e: Event) => {
    e.preventDefault();
    if (worker !== w) return;
    w.terminate();
    worker = null;
    restarts++;
    styles.length = 0;
    for (const doc of docs.values()) doc.restart();
  });
  return w;
};

const send = (req: HighlightRequest) => {
  worker ??= startWorker();
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

interface Chunk {
  readonly starts: Uint32Array;
  readonly tokens: Uint32Array;
}

/**
 * Highlighting state of one diff. Chunks of lines are requested as they become
 * visible and cached per theme; subscribers are notified once per frame.
 *
 * Until its own tokens arrive, a line shows the tokens a line with the same
 * text had in the previous version of the same file's diff, so that a refresh
 * does not flash unhighlighted text.
 */
export class DocHighlighter {
  private id = 0;
  private readonly chunks = new Map<string, Chunk>();
  private readonly requested = new Set<string>();
  private readonly listeners = new Set<() => void>();
  /** Tokens by `theme\ntext`, from the previous version. */
  private fallback: Map<string, Uint32Array> | null = null;
  private plain = false;
  private frame = 0;
  version = 0;

  constructor(
    private readonly model: DiffModel,
    previous: DocHighlighter | null = null,
  ) {
    if (previous && previous.model.diff.path === model.diff.path) {
      this.fallback = previous.lineTokens();
    }
  }

  /** Tokens of the lines highlighted so far, by `theme\ntext`. */
  private lineTokens(): Map<string, Uint32Array> | null {
    const out = new Map<string, Uint32Array>();
    for (const [key, chunk] of this.chunks) {
      const [theme, side, c] = key.split(":");
      const lines = this.model.sides[Number(side)]!;
      for (let i = 0; i + 1 < chunk.starts.length && out.size < MAX_FALLBACK; i++) {
        const text = lines[Number(c) * CHUNK + i]!;
        out.set(`${theme}\n${text}`, chunk.tokens.subarray(chunk.starts[i], chunk.starts[i + 1]));
      }
    }
    for (const [key, tokens] of this.fallback ?? []) {
      if (out.size >= MAX_FALLBACK) break;
      if (!out.has(key)) out.set(key, tokens);
    }
    return out.size > 0 ? out : null;
  }

  /** Sends the document to the worker; undone by `dispose`. */
  open() {
    this.id = nextDoc++;
    docs.set(this.id, this);
    this.sendOpen();
  }

  private sendOpen() {
    if (restarts > MAX_RESTARTS) {
      this.plain = true;
      return;
    }
    send({
      type: "open",
      doc: this.id,
      path: this.model.diff.path,
      sides: this.model.sides as [string[], string[]],
      resets: this.model.resets as [number[], number[]],
    });
  }

  /**
   * Sends the document and its requests to a new worker. Tokens from the old one name its
   * styles, which the new one numbers afresh: they are dropped and asked for again.
   */
  restart() {
    if (!this.id || this.plain) return;
    this.chunks.clear();
    this.fallback = null;
    this.changed();
    this.sendOpen();
    for (const key of this.requested) {
      if (this.plain) break;
      const [theme, side, chunk] = key.split(":");
      send({
        type: "highlight",
        doc: this.id,
        theme: theme as ThemeKind,
        side: Number(side) as 0 | 1,
        chunk: Number(chunk),
      });
    }
  }

  dispose() {
    docs.delete(this.id);
    if (worker) send({ type: "close", doc: this.id });
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.chunks.clear();
    this.requested.clear();
    this.fallback = null;
    this.plain = false;
    this.id = 0;
  }

  /** Tokens of a line as (end column, style) pairs, or null if not highlighted yet. */
  tokens(theme: ThemeKind, side: 0 | 1, index: number): Uint32Array | null {
    if (index < 0) return null;
    const c = this.chunks.get(`${theme}:${side}:${Math.floor(index / CHUNK)}`);
    if (!c) return this.fallback?.get(`${theme}\n${this.model.sides[side][index]}`) ?? null;
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
    this.changed();
  }

  /** Notifies subscribers on the next frame. */
  private changed() {
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

const highlighterFor = (model: DiffModel, previous: DocHighlighter | null) =>
  model.sides[0].length + model.sides[1].length > MAX_LINES
    ? null
    : new DocHighlighter(model, previous);

/** A highlighter for the model, or null when the diff is too large to bother. */
export function useHighlighter(model: DiffModel): DocHighlighter | null {
  const [current, setCurrent] = useState(() => ({ model, hl: highlighterFor(model, null) }));
  let hl = current.hl;
  if (current.model !== model) {
    // A new version: the previous highlighter's tokens tide the new one over.
    hl = highlighterFor(model, current.hl);
    setCurrent({ model, hl });
  }
  useEffect(() => {
    if (!hl) return;
    hl.open();
    return () => hl.dispose();
  }, [hl]);
  useSyncExternalStore(hl?.subscribe ?? noopSubscribe, () => hl?.version ?? 0);
  return hl;
}

const noopSubscribe = () => () => {};
