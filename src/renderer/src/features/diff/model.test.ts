import type { DiffLine, FileDiff } from "@shared/domain";
import { expect, it } from "vitest";
import { buildModel, isChange } from "./model";

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

it("handles an empty diff", () => {
  const m = buildModel(diff());
  expect(m).toMatchObject({ lines: [], unified: [], split: [], width: 0, gutter: 1 });
});
