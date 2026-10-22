// @vitest-environment happy-dom
import type { GraphRow } from "@shared/domain";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { laneColor } from "@/lib/graph-colors";
import { GraphCell, graphWidthFor, LANE_WIDTH, ROW_HEIGHT, WipGraphCell } from "./GraphCell";

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const row = (extra: Partial<GraphRow> = {}): GraphRow => ({
  hash: "a".repeat(40),
  parents: ["b".repeat(40)],
  subject: "Subject",
  authorName: "A",
  authorEmail: "a@example.com",
  authorTime: 0,
  lane: 0,
  color: 0,
  edges: [],
  width: 1,
  ...extra,
});

const render = (el: React.ReactNode) => act(() => root.render(el));
const all = (selector: string) => [...container.querySelectorAll(selector)];

it("sizes the graph column by lanes, with at least one", () => {
  expect(graphWidthFor(0)).toBe(graphWidthFor(1));
  expect(graphWidthFor(3) - graphWidthFor(2)).toBe(LANE_WIDTH);
});

it("draws straight and curved edges in their lane colors", () => {
  // A straight edge in lane 0 (top to middle) and a curve from lane 0 to lane 1.
  render(
    <GraphCell
      row={row({ edges: [0, 0, 0, 1, 2, 0, 1, 1, 2, 3], width: 2 })}
      isHead={false}
      isStash={false}
      wipAbove={false}
    />,
  );
  const svg = container.querySelector("svg")!;
  // As wide as the row's lanes: the column cuts it off.
  expect(svg.getAttribute("width")).toBe(String(graphWidthFor(2)));
  expect(svg.getAttribute("height")).toBe(String(ROW_HEIGHT));
  const paths = all("path");
  expect(paths.map((p) => p.getAttribute("d"))).toEqual([
    `M14 0V${ROW_HEIGHT / 2}`,
    `M14 ${ROW_HEIGHT / 2}C14 ${(ROW_HEIGHT * 3) / 4} 30 ${(ROW_HEIGHT * 3) / 4} 30 ${ROW_HEIGHT}`,
  ]);
  expect(paths.map((p) => p.getAttribute("stroke"))).toEqual([laneColor(2), laneColor(3)]);
  // A regular commit is a hollow circle in its lane.
  const node = all("circle");
  expect(node).toHaveLength(1);
  expect(node[0]!.getAttribute("r")).toBe("6");
  expect(node[0]!.getAttribute("cx")).toBe("14");
});

it("marks merges, HEAD, stashes and a WIP row above", () => {
  render(
    <GraphCell
      row={row({ lane: 1, color: 4, parents: ["p1", "p2"] })}
      isHead
      isStash={false}
      wipAbove
    />,
  );
  const circles = all("circle");
  // A filled merge dot with a hole for HEAD, which would not show in the dot's color.
  expect(circles.map((c) => c.getAttribute("r"))).toEqual(["4", "2"]);
  expect(circles[0]!.getAttribute("fill")).toBe(laneColor(4));
  expect(circles[1]!.getAttribute("class")).toBe("fill-background");
  const dashed = container.querySelector("path")!;
  expect(dashed.getAttribute("d")).toBe(`M30 0V${ROW_HEIGHT / 2}`);
  expect(dashed.getAttribute("stroke-dasharray")).toBe("3 3");

  render(<GraphCell row={row()} isHead={false} isStash wipAbove={false} />);
  expect(all("circle")).toHaveLength(0);
  const rect = container.querySelector("rect")!;
  expect(rect.getAttribute("stroke-dasharray")).toBe("2 2");
  expect(rect.getAttribute("x")).toBe("9");
});

it("draws the WIP node with a dashed line down to HEAD", () => {
  render(<WipGraphCell lane={2} color={1} />);
  expect(container.querySelector("svg")!.getAttribute("width")).toBe(String(graphWidthFor(3)));
  const path = container.querySelector("path")!;
  expect(path.getAttribute("d")).toBe(`M46 ${ROW_HEIGHT / 2}V${ROW_HEIGHT}`);
  expect(path.getAttribute("stroke")).toBe(laneColor(1));
  const circle = container.querySelector("circle")!;
  expect(circle.getAttribute("cx")).toBe("46");
  expect(circle.getAttribute("stroke-dasharray")).toBe("3 2");
});

it("marks HEAD on a regular commit with a dot in its color", () => {
  render(<GraphCell row={row()} isHead isStash={false} wipAbove={false} />);
  const circles = all("circle");
  expect(circles.map((c) => c.getAttribute("r"))).toEqual(["6", "2.5"]);
  expect(circles[1]!.getAttribute("fill")).toBe(laneColor(0));
});

it("draws a line from the ref pills to the dot", () => {
  render(
    <GraphCell
      row={row({ lane: 1, color: 2 })}
      isHead={false}
      isStash={false}
      wipAbove={false}
      refLine
    />,
  );
  const line = container.querySelector("path")!;
  expect(line.getAttribute("d")).toBe(`M0 ${ROW_HEIGHT / 2}H30`);
  expect(line.getAttribute("stroke")).toBe(laneColor(2));
});
