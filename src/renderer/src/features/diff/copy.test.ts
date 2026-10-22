import type { FileDiff } from "@shared/domain";
import { expect, it } from "vitest";
import { copiedText } from "./copy";
import { buildModel } from "./model";

const model = buildModel({
  path: "a",
  oldPath: null,
  binary: false,
  truncated: false,
  hunks: [
    {
      header: "@@ -1,2 +1,2 @@",
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      lines: [
        { kind: "context", oldNo: 1, newNo: 1, text: "same" },
        { kind: "del", oldNo: 2, newNo: null, text: "before" },
        { kind: "add", oldNo: null, newNo: 2, text: "after" },
      ],
    },
  ],
} satisfies FileDiff);

it("copies whole lines between two points, cutting the first and the last", () => {
  // Unified rows: the hunk header, then the three lines.
  const rows = model.unified;
  expect(copiedText(model, rows, { row: 0, offset: 0 }, { row: 3, offset: Infinity }, 0)).toBe(
    "same\nbefore\nafter",
  );
  expect(copiedText(model, rows, { row: 1, offset: 2 }, { row: 2, offset: 3 }, 0)).toBe("me\nbef");
  expect(copiedText(model, rows, { row: 2, offset: 1 }, { row: 2, offset: 4 }, 0)).toBe("efo");
});

it("copies one column of a split view", () => {
  const rows = model.split;
  const all = (side: 0 | 1) =>
    copiedText(
      model,
      rows,
      { row: 0, offset: 0 },
      { row: rows.length - 1, offset: Infinity },
      side,
    );
  expect(all(0)).toBe("same\nbefore");
  expect(all(1)).toBe("same\nafter");
});

it("leaves out no-newline markers", () => {
  const m = buildModel({
    path: "a",
    oldPath: null,
    binary: false,
    truncated: false,
    hunks: [
      {
        header: "@@ -1 +1 @@",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [
          { kind: "del", oldNo: 1, newNo: null, text: "x" },
          { kind: "meta", oldNo: null, newNo: null, text: "\\ No newline at end of file" },
          { kind: "add", oldNo: null, newNo: 1, text: "y" },
        ],
      },
    ],
  });
  const end = { row: m.unified.length - 1, offset: Infinity };
  expect(copiedText(m, m.unified, { row: 0, offset: 0 }, end, 0)).toBe("x\ny");
});
