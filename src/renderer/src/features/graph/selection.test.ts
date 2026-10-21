import type { GraphRow } from "@shared/domain";
import { expect, it } from "vitest";
import { MAX_RANGE, rangeIndexes, selectionOf, toggled } from "./selection";

const picked = (index: number) => ({ index, row: { hash: `c${index}` } as GraphRow });

it("makes a selection of one commit, several or none", () => {
  expect(selectionOf([], "c0")).toBeNull();
  expect(selectionOf([picked(2)], "c2")).toEqual({ kind: "commit", hash: "c2" });
  expect(selectionOf([picked(2), picked(2)], "c2")).toEqual({ kind: "commit", hash: "c2" });
  expect(selectionOf([picked(5), picked(2)], "c5")).toEqual({
    kind: "commits",
    commits: [picked(2), picked(5)],
    anchor: "c5",
  });
});

it("toggles a commit", () => {
  expect(toggled([picked(1)], picked(3))).toEqual([picked(1), picked(3)]);
  expect(toggled([picked(1), picked(3)], picked(1))).toEqual([picked(3)]);
});

it("limits a range to the commits nearest the click", () => {
  expect(rangeIndexes(2, 5)).toEqual([2, 5]);
  expect(rangeIndexes(5, 2)).toEqual([2, 5]);
  expect(rangeIndexes(0, 5000)).toEqual([5000 - MAX_RANGE + 1, 5000]);
  expect(rangeIndexes(5000, 0)).toEqual([0, MAX_RANGE - 1]);
});
