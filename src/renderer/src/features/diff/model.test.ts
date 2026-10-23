import type { DiffLine, FileDiff } from "@shared/domain";
import { expect, it } from "vitest";
import { buildModel, capLines, displayWidth, isChange } from "./model";

const ctx = (oldNo: number, newNo: number, text: string): DiffLine => ({
  kind: "context",
  oldNo,
  newNo,
  text,
});
const del = (oldNo: number, text: string): DiffLine => ({ kind: "del", oldNo, newNo: null, text });
const add = (newNo: number, text: string): DiffLine => ({ kind: "add", oldNo: null, newNo, text });
const meta = (text = "\\ No newline at end of file"): DiffLine => ({
  kind: "meta",
  oldNo: null,
  newNo: null,
  text,
});

const diff = (...hunks: { start: [number, number]; lines: DiffLine[] }[]): FileDiff => ({
  path: "a.txt",
  oldPath: null,
  binary: false,
  truncated: false,
  hunks: hunks.map(({ start: [oldStart, newStart], lines }) => ({
    header: `@@ -${oldStart} +${newStart} @@`,
    oldStart,
    oldLines: lines.filter((l) => l.kind !== "add" && l.kind !== "meta").length,
    newStart,
    newLines: lines.filter((l) => l.kind !== "del" && l.kind !== "meta").length,
    lines,
  })),
});

it("flattens hunks into unified rows and pairs replaced lines", () => {
  const m = buildModel(
    diff({
      start: [1, 1],
      lines: [ctx(1, 1, "a"), del(2, "b"), del(3, "c"), add(2, "B"), ctx(4, 3, "d")],
    }),
  );
  expect(m.unified).toEqual([
    { type: "hunk", hunk: 0 },
    ...[0, 1, 2, 3, 4].map((id) => ({ type: "line", id })),
  ]);
  expect(m.split).toEqual([
    { type: "hunk", hunk: 0 },
    { type: "split", left: 0, right: 0 },
    { type: "split", left: 1, right: 3 },
    { type: "split", left: 2, right: -1 },
    { type: "split", left: 4, right: 4 },
  ]);
  expect(m.lines.map((l) => l.pair)).toEqual([-1, 3, -1, 1, -1]);
  // Context lines are on both sides; highlighting indexes the new side.
  expect(m.sides).toEqual([
    ["a", "b", "c", "d"],
    ["a", "B", "d"],
  ]);
  expect(m.lines.map((l) => [l.side, l.sideIndex])).toEqual([
    [1, 0],
    [0, 1],
    [0, 2],
    [1, 1],
    [1, 2],
  ]);
  expect(m.lines.filter(isChange).map((l) => l.id)).toEqual([1, 2, 3]);
  expect(m.width).toBe(1);
  expect(m.gutter).toBe(1);
});

it("starts a new block when a deletion follows additions", () => {
  const m = buildModel(diff({ start: [1, 1], lines: [del(1, "x"), add(1, "y"), del(2, "z")] }));
  expect(m.split.slice(1)).toEqual([
    { type: "split", left: 0, right: 1 },
    { type: "split", left: 2, right: -1 },
  ]);
});

it("keeps no-newline markers with the line they belong to", () => {
  const m = buildModel(
    diff({
      start: [1, 1],
      lines: [del(1, "old"), meta(), add(1, "new"), meta(), ctx(2, 2, "same"), meta()],
    }),
  );
  expect(m.split.slice(1)).toEqual([
    { type: "split", left: 0, right: 2 },
    { type: "split", left: 1, right: 3 },
    { type: "split", left: 4, right: 4 },
    { type: "split", left: 5, right: 5 },
  ]);
  // Markers are not part of the file contents and do not pair.
  expect(m.lines[1]).toMatchObject({ pair: -1, sideIndex: -1 });
  expect(m.lines[0]!.pair).toBe(2);
  expect(m.sides).toEqual([
    ["old", "same"],
    ["new", "same"],
  ]);
  expect(m.width).toBe("\\ No newline at end of file".length);
});

it("records where each hunk starts, for highlighting resets", () => {
  const m = buildModel(
    diff(
      { start: [1, 1], lines: [ctx(1, 1, "a"), add(2, "b")] },
      { start: [120, 121], lines: [del(120, "c"), ctx(121, 122, "d")] },
    ),
  );
  expect(m.hunkStart).toEqual([0, 2]);
  expect(m.resets).toEqual([
    [0, 1],
    [0, 2],
  ]);
  expect(m.unified.filter((r) => r.type === "hunk")).toEqual([
    { type: "hunk", hunk: 0 },
    { type: "hunk", hunk: 1 },
  ]);
  expect(m.lines[2]).toMatchObject({ hunk: 1, index: 0 });
  // Line numbers go up to 123, three digits.
  expect(m.gutter).toBe(3);
});

it("measures lines in columns, expanding tabs and counting wide characters twice", () => {
  expect(displayWidth("ab")).toBe(2);
  expect(displayWidth("\tx")).toBe(5);
  expect(displayWidth("ab\tx")).toBe(5);
  expect(displayWidth("日本語")).toBe(6);
  expect(displayWidth("é")).toBe(1);
  expect(displayWidth("😀")).toBe(2);
  expect(displayWidth("x".repeat(20_000))).toBe(10_000);
  const m = buildModel(diff({ start: [1, 1], lines: [ctx(1, 1, "abcdef"), add(2, "\t\tx")] }));
  expect(m.width).toBe(9);
});

it("cuts huge diffs short", () => {
  const big = diff(
    { start: [1, 1], lines: [add(1, "a"), add(2, "b")] },
    { start: [10, 11], lines: [add(11, "c"), add(12, "d"), add(13, "e")] },
    { start: [20, 22], lines: [add(22, "f")] },
  );
  expect(capLines(big, 6)).toBe(big);
  const cut = capLines(big, 4);
  expect(cut.truncated).toBe(true);
  expect(cut.hunks.map((h) => h.lines.map((l) => l.text))).toEqual([
    ["a", "b"],
    ["c", "d"],
  ]);
  // The budget ends exactly at the end of a hunk, with more hunks after it.
  const between = capLines(big, 5);
  expect(between.truncated).toBe(true);
  expect(between.hunks.map((h) => h.lines.length)).toEqual([2, 3]);
});

it("handles an empty diff", () => {
  const m = buildModel(diff());
  expect(m).toMatchObject({ lines: [], unified: [], split: [], width: 0, gutter: 1 });
});

it("puts the actions of each block of conflict markers above it", () => {
  const block = (n: number): DiffLine[] => [
    add(n, "<<<<<<< HEAD"),
    add(n + 1, "ours"),
    add(n + 2, "======="),
    add(n + 3, ">>>>>>> side"),
  ];
  const lines = [ctx(1, 1, "a"), ...block(2), ...block(6), ctx(2, 10, "z")];
  const m = buildModel({ ...diff({ start: [1, 1], lines }), readOnly: "conflict" });
  expect(m.conflicts).toHaveLength(2);
  expect(m.unified.map((r) => (r.type === "line" ? r.id : r.type))).toEqual([
    "hunk",
    0,
    "conflict",
    1,
    2,
    3,
    4,
    "conflict",
    5,
    6,
    7,
    8,
    9,
  ]);
  expect(m.split.filter((r) => r.type === "conflict")).toEqual([
    { type: "conflict", conflict: 0 },
    { type: "conflict", conflict: 1 },
  ]);
  expect(m.lines.map((l) => l.conflict)).toEqual([
    null,
    "marker",
    "current",
    "marker",
    "marker",
    "marker",
    "current",
    "marker",
    "marker",
    null,
  ]);
});
