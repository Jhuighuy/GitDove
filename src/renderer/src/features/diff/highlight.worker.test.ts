import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { HighlightRequest, HighlightResponse } from "./highlight-protocol";
import { CHUNK } from "./highlight-protocol";

type Tokens = Extract<HighlightResponse, { type: "tokens" }>;

const posted: HighlightResponse[] = [];
const transfers: Transferable[][] = [];
/** Called with each message the worker posts. */
let onPost: ((msg: HighlightResponse) => void) | null = null;
let handler: ((e: MessageEvent<HighlightRequest>) => void) | null = null;

// The worker module talks to `self`; stand in for the worker global scope.
vi.stubGlobal("self", {
  addEventListener: (type: string, fn: (e: MessageEvent<HighlightRequest>) => void) => {
    if (type === "message") handler = fn;
  },
  postMessage: (msg: HighlightResponse, transfer: Transferable[]) => {
    posted.push(msg);
    transfers.push(transfer);
    onPost?.(msg);
  },
});

/**
 * Loading shiki, its themes and grammars is by far the slowest part, and under heavy load can
 * take many seconds: it happens once, up front, with as long as it takes. The tests then wait
 * on the worker's own work only, which is quick, but never on a clock.
 */
const SLOW = 180_000;
vi.setConfig({ testTimeout: SLOW, hookTimeout: SLOW });

beforeAll(async () => {
  await import("./highlight.worker");
  const { bundledLanguages } = await import("shiki/langs");
  await Promise.all([
    import("shiki/themes/github-light.mjs"),
    import("shiki/themes/github-dark.mjs"),
    ...(["typescript", "javascript", "c", "python"] as const).map((l) => bundledLanguages[l]()),
  ]);
});

beforeEach(() => {
  posted.splice(0);
  transfers.splice(0);
  onPost = null;
});

let nextDoc = 1;
const send = (msg: HighlightRequest) => handler!({ data: msg } as MessageEvent<HighlightRequest>);

/** Opens a document and returns its id. */
const open = (
  path: string,
  sides: [string[], string[]],
  resets: [number[], number[]] = [[0], [0]],
) => {
  const doc = nextDoc++;
  send({ type: "open", doc, path, sides, resets });
  return doc;
};
const highlight = (doc: number, side: 0 | 1, chunk: number, theme: "dark" | "light" = "dark") =>
  send({ type: "highlight", doc, theme, side, chunk });

const tokensOf = (doc: number) =>
  posted.filter((m): m is Tokens => m.type === "tokens" && m.doc === doc);
/** Waits for the worker, failing a little before the test would time out. */
const waitFor = (fn: () => void) => vi.waitFor(fn, { timeout: SLOW - 10_000, interval: 5 });
/** Lets the worker run on; used only to check that nothing more arrives. */
const idle = () => new Promise((r) => setTimeout(r, 50));

/** Styles of the tokens of line `i` of a chunk, as `[text, style]` pairs. */
const lineTokens = (msg: Tokens, palette: string[], text: string, i: number) => {
  const out: [string, string][] = [];
  let pos = 0;
  for (let t = msg.starts[i]!; t < msg.starts[i + 1]!; t += 2) {
    out.push([text.slice(pos, msg.tokens[t]), palette[msg.tokens[t + 1]!]!]);
    pos = msg.tokens[t]!;
  }
  return out;
};

/** Every palette entry received so far, by index. */
const palette: string[] = [];
const collectPalette = () => {
  for (const m of posted) {
    if (m.type === "tokens" && m.palette)
      m.palette.forEach((s, i) => (palette[m.paletteBase + i] = s));
  }
  return palette;
};

it("highlights a chunk of lines and sends new styles along", async () => {
  const lines = ["const a = 1;", "// note", ""];
  const doc = open("src/a.ts", [[], lines]);
  highlight(doc, 1, 0);
  await waitFor(() => expect(tokensOf(doc)).toHaveLength(1));
  const msg = tokensOf(doc)[0]!;
  expect(msg).toMatchObject({ theme: "dark", side: 1, chunk: 0 });
  expect(msg.starts).toHaveLength(lines.length + 1);
  // Typed arrays are transferred, not copied.
  expect(transfers[0]).toEqual([msg.starts.buffer, msg.tokens.buffer]);
  expect(msg.paletteBase).toBe(0);
  expect(msg.palette!.every((s) => /^#[0-9a-f]{6,8}\|\d+$/i.test(s))).toBe(true);

  const styles = collectPalette();
  const first = lineTokens(msg, styles, lines[0]!, 0);
  expect(first.map(([text]) => text).join("")).toBe(lines[0]);
  expect(first.find(([text]) => text === "const")![1]).not.toBe(
    first.find(([text]) => text === "1")![1],
  );
  const comment = lineTokens(msg, styles, lines[1]!, 1);
  expect(comment.map(([t]) => t).join("")).toBe("// note");
  expect(lineTokens(msg, styles, "", 2)).toEqual([]);

  // The same document in another theme reuses known styles and sends only new ones.
  highlight(doc, 1, 0, "light");
  await waitFor(() => expect(tokensOf(doc)).toHaveLength(2));
  const light = tokensOf(doc)[1]!;
  expect(light.theme).toBe("light");
  expect(light.paletteBase).toBe(msg.palette!.length);
  send({ type: "close", doc });
});

it("carries grammar state across chunks, unless a hunk starts there", async () => {
  // A block comment that starts in the first chunk and ends in the second.
  const lines = Array.from({ length: CHUNK + 2 }, (_, i) => `let x${i} = ${i};`);
  lines[CHUNK - 1] = "/* start";
  lines[CHUNK] = "end */ let y = 1;";
  const continued = open("a.js", [[], lines]);
  // Asking for the second chunk highlights the first one too, in order.
  highlight(continued, 1, 1);
  await waitFor(() => expect(tokensOf(continued)).toHaveLength(2));
  expect(tokensOf(continued).map((m) => m.chunk)).toEqual([0, 1]);
  expect(tokensOf(continued)[1]!.starts).toHaveLength(3);

  const reset = open("a.js", [[], lines], [[0], [0, CHUNK]]);
  highlight(reset, 1, 1);
  await waitFor(() => expect(tokensOf(reset)).toHaveLength(1));
  expect(tokensOf(reset)[0]!.chunk).toBe(1);

  const styles = collectPalette();
  const commentStyle = lineTokens(
    tokensOf(continued)[0]!,
    styles,
    lines[CHUNK - 1]!,
    CHUNK - 1,
  )[0]![1];
  const [endContinued] = lineTokens(tokensOf(continued)[1]!, styles, lines[CHUNK], 0);
  const [endReset] = lineTokens(tokensOf(reset)[0]!, styles, lines[CHUNK], 0);
  // Inside the comment, `end` is comment text; after a reset it is an identifier.
  expect(endContinued![1]).toBe(commentStyle);
  expect(endReset![1]).not.toBe(commentStyle);

  // Chunks already highlighted (e.g. as dependencies) are not sent again.
  highlight(continued, 1, 0);
  await idle();
  expect(tokensOf(continued)).toHaveLength(2);
  send({ type: "close", doc: continued });
  send({ type: "close", doc: reset });
});

it("resets the state at hunk starts within a chunk", async () => {
  const lines = ["/* open", "still", "more"];
  const joined = open("a.c", [lines, []]);
  const split = open("a.c", [lines, []], [[0, 1], [0]]);
  highlight(joined, 0, 0);
  highlight(split, 0, 0);
  await waitFor(() => expect(tokensOf(joined).length + tokensOf(split).length).toBe(2));
  const styles = collectPalette();
  const style = (doc: number, i: number) =>
    lineTokens(tokensOf(doc)[0]!, styles, lines[i]!, i)[0]![1];
  const comment = style(joined, 0);
  expect(style(joined, 1)).toBe(comment);
  // A new hunk does not continue the comment of the previous one, but its own lines do.
  expect(style(split, 1)).not.toBe(comment);
  expect(style(split, 2)).toBe(style(split, 1));
  send({ type: "close", doc: joined });
  send({ type: "close", doc: split });
});

it("serves the newest request first", async () => {
  const doc = open("a.py", [["x = 1"], ["y = 2"]]);
  highlight(doc, 0, 0);
  highlight(doc, 1, 0);
  await waitFor(() => expect(tokensOf(doc)).toHaveLength(2));
  expect(tokensOf(doc).map((m) => m.side)).toEqual([1, 0]);
  send({ type: "close", doc });
});

it("leaves overly long lines as one plain token", async () => {
  const long = "x".repeat(1500);
  const doc = open("a.ts", [[], [long]]);
  highlight(doc, 1, 0);
  await waitFor(() => expect(tokensOf(doc)).toHaveLength(1));
  const msg = tokensOf(doc)[0]!;
  expect(msg.tokens.at(-2)).toBe(1500);
  send({ type: "close", doc });
});

it("reports documents in unknown languages as plain", async () => {
  const doc = open("notes.unknown", [["a"], ["b"]]);
  highlight(doc, 1, 0);
  await waitFor(() => expect(posted).toContainEqual({ type: "plain", doc }));
  await idle();
  expect(tokensOf(doc)).toEqual([]);
  send({ type: "close", doc });
});

it("drops closed documents and their pending requests", async () => {
  const plain = open("plain.unknown", [["a"], []]);
  send({ type: "close", doc: plain });
  const doc = open("a.ts", [[], ["let a = 1;"]]);
  highlight(doc, 1, 0);
  send({ type: "close", doc });
  // Requests for unknown documents are ignored too.
  highlight(12345, 1, 0);
  await idle();
  expect(posted).toEqual([]);
});

it("highlights a long chain of chunks one at a time, newer requests first", async () => {
  const lines = Array.from({ length: CHUNK * 31 }, (_, i) => `let x${i} = ${i};`);
  const doc = open("a.js", [lines, lines]);
  // The first chunk of the chain lets a newer request in before the rest of it.
  onPost = (msg) => {
    if (msg.type === "tokens" && msg.side === 1) {
      onPost = null;
      highlight(doc, 0, 3);
    }
  };
  highlight(doc, 1, 30);
  await waitFor(() => expect(tokensOf(doc).at(-1)?.chunk).toBe(30));
  // Only the last few chunks before the requested one are highlighted for its state.
  expect(tokensOf(doc).map((m) => `${m.side}:${m.chunk}`)).toEqual([
    "1:20",
    "0:0",
    "0:1",
    "0:2",
    "0:3",
    ...Array.from({ length: 10 }, (_, i) => `1:${21 + i}`),
  ]);
  send({ type: "close", doc });
});

it("stops a chain when its document closes", async () => {
  const lines = Array.from({ length: CHUNK * 6 }, (_, i) => `let x${i} = ${i};`);
  const doc = open("a.js", [[], lines]);
  onPost = () => send({ type: "close", doc });
  highlight(doc, 1, 5);
  await waitFor(() => expect(tokensOf(doc)).toHaveLength(1));
  await idle();
  expect(tokensOf(doc)).toHaveLength(1);
});
