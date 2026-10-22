/**
 * Syntax highlighting off the UI thread. The renderer opens a document with
 * the old and new sides of a diff and asks for chunks of lines as they scroll
 * into view; the newest request is served first.
 */
import { createHighlighterCore, type GrammarState, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages } from "shiki/langs";
import type { HighlightRequest, HighlightResponse, ThemeKind } from "./highlight-protocol";
import { CHUNK, languageFor } from "./highlight-protocol";

const THEMES: Record<ThemeKind, string> = { light: "vitesse-light", dark: "vitesse-dark" };
/** Longer lines are left plain. */
const MAX_LINE = 1000;

let highlighter: Promise<HighlighterCore> | null = null;
const getHighlighter = () =>
  (highlighter ??= createHighlighterCore({
    themes: [import("shiki/themes/vitesse-light.mjs"), import("shiki/themes/vitesse-dark.mjs")],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  }));

const loaded = new Map<string, Promise<boolean>>();
const loadLanguage = (lang: string) => {
  let p = loaded.get(lang);
  if (!p) {
    p = getHighlighter()
      .then((hl) => hl.loadLanguage(bundledLanguages[lang as keyof typeof bundledLanguages]!))
      .then(
        () => true,
        () => false,
      );
    loaded.set(lang, p);
  }
  return p;
};

interface Doc {
  readonly lang: string | null;
  readonly ready: Promise<boolean>;
  readonly sides: readonly [string[], string[]];
  readonly resets: readonly [Set<number>, Set<number>];
  /** Grammar state after each highlighted chunk, by `theme:side:chunk`. */
  readonly states: Map<string, GrammarState | undefined>;
}

const docs = new Map<number, Doc>();
/** Pending chunk requests; served last-in first-out. */
const queue: { doc: number; theme: ThemeKind; side: 0 | 1; chunk: number }[] = [];
let scheduled = false;

/** Interned `color|fontStyle` styles; indices are sent with tokens. */
const styles = new Map<string, number>();
const palette: string[] = [];
let sentPalette = 0;

const post = (msg: HighlightResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

self.addEventListener("message", (e: MessageEvent<HighlightRequest>) => {
  const msg = e.data;
  switch (msg.type) {
    case "open": {
      const lang = languageFor(msg.path, Object.keys(bundledLanguages));
      const doc: Doc = {
        lang,
        ready: lang ? loadLanguage(lang) : Promise.resolve(false),
        sides: msg.sides,
        resets: [new Set(msg.resets[0]), new Set(msg.resets[1])],
        states: new Map(),
      };
      docs.set(msg.doc, doc);
      void doc.ready.then((ok) => {
        if (!ok && docs.get(msg.doc) === doc) post({ type: "plain", doc: msg.doc });
      });
      break;
    }
    case "close":
      docs.delete(msg.doc);
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i]!.doc === msg.doc) queue.splice(i, 1);
      break;
    case "highlight":
      queue.push({ doc: msg.doc, theme: msg.theme, side: msg.side, chunk: msg.chunk });
      schedule();
      break;
  }
});

const schedule = () => {
  if (scheduled) return;
  scheduled = true;
  // Yield between chunks so newer requests (the current viewport) jump ahead.
  setTimeout(() => {
    scheduled = false;
    void step();
  }, 0);
};

const step = async () => {
  const req = queue.pop();
  if (!req) return;
  const doc = docs.get(req.doc);
  // The chunk may have been highlighted meanwhile as a dependency of another.
  if (
    doc &&
    !doc.states.has(key(req, req.chunk)) &&
    (await doc.ready) &&
    docs.get(req.doc) === doc
  ) {
    const hl = await getHighlighter();
    // Highlight from the closest chunk with a known starting state.
    let first = req.chunk;
    while (first > 0 && !startsFresh(doc, req.side, first) && !doc.states.has(key(req, first - 1)))
      first--;
    for (let c = first; c <= req.chunk; c++) {
      if (!doc.states.has(key(req, c))) highlightChunk(hl, req.doc, doc, req.theme, req.side, c);
    }
  }
  if (queue.length > 0) schedule();
};

const key = (r: { theme: ThemeKind; side: 0 | 1 }, chunk: number) =>
  `${r.theme}:${r.side}:${chunk}`;

const startsFresh = (doc: Doc, side: 0 | 1, chunk: number) =>
  chunk === 0 || doc.resets[side].has(chunk * CHUNK);

const highlightChunk = (
  hl: HighlighterCore,
  id: number,
  doc: Doc,
  theme: ThemeKind,
  side: 0 | 1,
  chunk: number,
) => {
  const lines = doc.sides[side];
  const start = chunk * CHUNK;
  const end = Math.min(lines.length, start + CHUNK);
  let state = startsFresh(doc, side, chunk)
    ? undefined
    : doc.states.get(key({ theme, side }, chunk - 1));
  const starts = new Uint32Array(end - start + 1);
  const data: number[] = [];

  // Highlight runs of lines between hunk starts, resetting the state at each.
  for (let s = start; s < end;) {
    let e = s + 1;
    while (e < end && !doc.resets[side].has(e)) e++;
    if (s !== start && doc.resets[side].has(s)) state = undefined;
    const tokens = hl.codeToTokensBase(lines.slice(s, e).join("\n"), {
      lang: doc.lang!,
      theme: THEMES[theme],
      tokenizeMaxLineLength: MAX_LINE,
      ...(state ? { grammarState: state } : {}),
    });
    state = hl.getLastGrammarState(tokens);
    for (let i = s; i < e; i++) {
      starts[i - start] = data.length;
      let pos = 0;
      for (const t of tokens[i - s] ?? []) {
        pos += t.content.length;
        data.push(pos, intern(t.color, t.fontStyle));
      }
    }
    s = e;
  }
  starts[end - start] = data.length;
  doc.states.set(key({ theme, side }, chunk), state);

  const tokens = Uint32Array.from(data);
  const newPalette = palette.length > sentPalette ? palette.slice(sentPalette) : null;
  post(
    {
      type: "tokens",
      doc: id,
      theme,
      side,
      chunk,
      starts,
      tokens,
      paletteBase: sentPalette,
      palette: newPalette,
    },
    [starts.buffer, tokens.buffer],
  );
  sentPalette = palette.length;
};

const intern = (color: string | undefined, fontStyle: number | undefined) => {
  const k = `${color ?? ""}|${fontStyle ?? 0}`;
  let i = styles.get(k);
  if (i === undefined) {
    i = palette.push(k) - 1;
    styles.set(k, i);
  }
  return i;
};
