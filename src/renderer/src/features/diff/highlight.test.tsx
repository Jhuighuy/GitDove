// @vitest-environment happy-dom
import type { FileDiff } from "@shared/domain";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import type { HighlightRequest, HighlightResponse } from "./highlight-protocol";
import { CHUNK } from "./highlight-protocol";
import { DocHighlighter, tokenStyle, useHighlighter } from "./highlight";
import { buildModel } from "./model";

/** Stands in for the highlighting worker, recording what is sent to it. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly sent: HighlightRequest[] = [];
  private listener: ((e: MessageEvent<HighlightResponse>) => void) | null = null;
  constructor(readonly url: URL) {
    FakeWorker.instances.push(this);
  }
  addEventListener(_: "message", listener: (e: MessageEvent<HighlightResponse>) => void) {
    this.listener = listener;
  }
  postMessage(req: HighlightRequest) {
    this.sent.push(req);
  }
  reply(msg: HighlightResponse) {
    this.listener!({ data: msg } as MessageEvent<HighlightResponse>);
  }
}

// The worker is created lazily, on the first message.
vi.stubGlobal("Worker", FakeWorker);
afterAll(() => vi.unstubAllGlobals());

const worker = () => FakeWorker.instances[0]!;
const sent = () => worker()?.sent ?? [];

const fileDiff = (lines: number, path = "a.ts"): FileDiff => ({
  path,
  oldPath: null,
  binary: false,
  truncated: false,
  hunks: [
    {
      header: "@@",
      oldStart: 1,
      oldLines: 0,
      newStart: 1,
      newLines: lines,
      lines: Array.from({ length: lines }, (_, i) => ({
        kind: "add" as const,
        oldNo: null,
        newNo: i + 1,
        text: `line ${i}`,
      })),
    },
  ],
});

/** Reports the highlighter of a diff. */
function Probe({
  model,
  onValue,
}: {
  model: ReturnType<typeof buildModel>;
  onValue: (v: DocHighlighter | null) => void;
}) {
  const value = useHighlighter(model);
  // Report after commit: renders can be replayed or dropped.
  useEffect(() => {
    onValue(value);
  });
  return null;
}

const frame = () => act(async () => new Promise<void>((r) => requestAnimationFrame(() => r())));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  worker()?.sent.splice(0);
});

it("opens documents in a single worker and requests visible chunks once", () => {
  const model = buildModel(fileDiff(3));
  const hl = new DocHighlighter(model);
  // Nothing is requested before the document is open.
  hl.ensure("dark", 1, 0, 2);
  expect(FakeWorker.instances).toHaveLength(0);

  hl.open();
  expect(FakeWorker.instances).toHaveLength(1);
  expect(worker().url.pathname).toMatch(/highlight\.worker\.ts$/);
  const open = sent()[0];
  expect(open).toMatchObject({
    type: "open",
    path: "a.ts",
    sides: [[], ["line 0", "line 1", "line 2"]],
    resets: [[0], [0]],
  });
  const doc = (open as { doc: number }).doc;

  hl.ensure("dark", 1, 0, CHUNK * 2 + 1);
  hl.ensure("dark", 1, 5, 10);
  hl.ensure("light", 1, 5, 10);
  // Invalid ranges are ignored.
  hl.ensure("dark", 0, -1, 10);
  hl.ensure("dark", 0, 10, 5);
  expect(sent().slice(1)).toEqual(
    [0, 1, 2]
      .map((chunk) => ({ type: "highlight", doc, theme: "dark", side: 1, chunk }))
      .concat([{ type: "highlight", doc, theme: "light", side: 1, chunk: 0 }]),
  );

  hl.dispose();
  expect(sent().at(-1)).toEqual({ type: "close", doc });
  // A disposed document requests nothing.
  hl.ensure("dark", 1, 0, 1);
  expect(sent().at(-1)).toEqual({ type: "close", doc });
});

it("stores tokens and styles from the worker and notifies subscribers once per frame", async () => {
  const hl = new DocHighlighter(buildModel(fileDiff(3)));
  hl.open();
  const doc = (sent().at(-1) as { doc: number }).doc;
  const listener = vi.fn();
  const unsubscribe = hl.subscribe(listener);
  expect(hl.tokens("dark", 1, 0)).toBeNull();
  expect(hl.tokens("dark", 1, -1)).toBeNull();

  // Line 0 has two tokens, line 1 one, line 2 none.
  const starts = Uint32Array.from([0, 4, 6, 6]);
  const tokens = Uint32Array.from([4, 0, 6, 1, 6, 2]);
  worker().reply({
    type: "tokens",
    doc,
    theme: "dark",
    side: 1,
    chunk: 0,
    starts,
    tokens,
    paletteBase: 100,
    palette: ["#ff0000|0", "#00ff00|3", "|4"],
  });
  worker().reply({
    type: "tokens",
    doc,
    theme: "light",
    side: 1,
    chunk: 0,
    starts,
    tokens,
    paletteBase: 103,
    palette: null,
  });
  expect([...hl.tokens("dark", 1, 0)!]).toEqual([4, 0, 6, 1]);
  expect([...hl.tokens("dark", 1, 1)!]).toEqual([6, 2]);
  expect([...hl.tokens("dark", 1, 2)!]).toEqual([]);
  expect(tokenStyle(100)).toEqual({
    color: "#ff0000",
    fontStyle: undefined,
    fontWeight: undefined,
    textDecoration: undefined,
  });
  expect(tokenStyle(101)).toEqual({
    color: "#00ff00",
    fontStyle: "italic",
    fontWeight: 600,
    textDecoration: undefined,
  });
  expect(tokenStyle(102)).toEqual({
    color: undefined,
    fontStyle: undefined,
    fontWeight: undefined,
    textDecoration: "underline",
  });
  expect(tokenStyle(103)).toBeUndefined();

  expect(listener).not.toHaveBeenCalled();
  const version = hl.version;
  await frame();
  expect(listener).toHaveBeenCalledOnce();
  expect(hl.version).toBe(version + 1);

  // Chunks that arrived as dependencies are not requested again.
  hl.ensure("dark", 1, 0, 2);
  expect(sent().filter((m) => m.type === "highlight")).toEqual([]);
  unsubscribe();
  hl.dispose();
  expect(hl.tokens("dark", 1, 0)).toBeNull();
});

it("stops requesting chunks for documents that cannot be highlighted", () => {
  const hl = new DocHighlighter(buildModel(fileDiff(3, "notes.unknown")));
  hl.open();
  const doc = (sent().at(-1) as { doc: number }).doc;
  worker().reply({ type: "plain", doc });
  // Replies for closed documents are dropped.
  worker().reply({ type: "plain", doc: 9999 });
  hl.ensure("dark", 1, 0, 2);
  expect(sent().filter((m) => m.type === "highlight")).toEqual([]);
  hl.dispose();
});

it("opens a highlighter while a component shows the diff", async () => {
  const model = buildModel(fileDiff(2));
  const hl = { current: null as DocHighlighter | null };
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe model={model} onValue={(v) => (hl.current = v)} />));
  expect(hl.current).not.toBeNull();
  expect(sent().map((m) => m.type)).toEqual(["open"]);
  await act(async () => root.unmount());
  expect(sent().map((m) => m.type)).toEqual(["open", "close"]);
});

it("does not highlight huge diffs", async () => {
  const model = buildModel(fileDiff(100_001));
  const hl = { current: undefined as DocHighlighter | null | undefined };
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe model={model} onValue={(v) => (hl.current = v)} />));
  expect(hl.current).toBeNull();
  expect(sent()).toEqual([]);
  await act(async () => root.unmount());
});
