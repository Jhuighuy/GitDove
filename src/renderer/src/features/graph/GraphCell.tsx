import type { GraphRow } from "@shared/domain";
import { memo } from "react";
import { laneColor } from "@/lib/graph-colors";

export const ROW_HEIGHT = 28;
export const LANE_WIDTH = 16;
const PAD = 6;

const lx = (lane: number) => PAD + lane * LANE_WIDTH + LANE_WIDTH / 2;
const ly = (y: number) => (y * ROW_HEIGHT) / 2;

export const graphWidthFor = (lanes: number) => PAD * 2 + Math.max(1, lanes) * LANE_WIDTH;

/** Width a row's lanes need, to tell whether a narrower column cuts them off. */
export const rowGraphWidth = (row: GraphRow): number => {
  let max = row.lane;
  const e = row.edges;
  for (let i = 0; i < e.length; i += 5) max = Math.max(max, e[i]!, e[i + 2]!);
  return graphWidthFor(max + 1);
};

const edgePath = (x1: number, y1: number, x2: number, y2: number) => {
  const ax = lx(x1);
  const ay = ly(y1);
  const bx = lx(x2);
  const by = ly(y2);
  if (ax === bx) return `M${ax} ${ay}V${by}`;
  const my = (ay + by) / 2;
  return `M${ax} ${ay}C${ax} ${my} ${bx} ${my} ${bx} ${by}`;
};

interface Props {
  readonly row: GraphRow;
  readonly width: number;
  readonly isHead: boolean;
  readonly isStash: boolean;
  /** Draw a dashed line up to the WIP row above. */
  readonly wipAbove: boolean;
  /** Draw a line from the left edge to the dot, continuing the line from the row's ref pills. */
  readonly refLine?: boolean;
}

/** Draws one row of the commit graph. */
export const GraphCell = memo(function GraphCell({
  row,
  width,
  isHead,
  isStash,
  wipAbove,
  refLine = false,
}: Props) {
  const e = row.edges;
  const paths = [];
  for (let i = 0; i < e.length; i += 5) {
    paths.push(
      <path
        key={i}
        d={edgePath(e[i]!, e[i + 1]!, e[i + 2]!, e[i + 3]!)}
        stroke={laneColor(e[i + 4]!)}
        strokeWidth={2}
        fill="none"
      />,
    );
  }
  const cx = lx(row.lane);
  const cy = ROW_HEIGHT / 2;
  const color = laneColor(row.color);
  const merge = row.parents.length > 1;

  return (
    <svg width={width} height={ROW_HEIGHT} className="block shrink-0 overflow-hidden" aria-hidden>
      {wipAbove && (
        <path
          d={`M${cx} 0V${cy}`}
          stroke={color}
          strokeWidth={2}
          strokeDasharray="3 3"
          fill="none"
        />
      )}
      {paths}
      {refLine && <path d={`M0 ${cy}H${cx}`} stroke={color} strokeWidth={2} fill="none" />}
      {isStash ? (
        <rect
          x={cx - 5}
          y={cy - 5}
          width={10}
          height={10}
          rx={2}
          className="fill-background"
          stroke={color}
          strokeWidth={2}
          strokeDasharray="2 2"
        />
      ) : merge ? (
        <circle cx={cx} cy={cy} r={4} fill={color} />
      ) : (
        <circle
          cx={cx}
          cy={cy}
          r={6}
          className="fill-background"
          stroke={color}
          strokeWidth={2.5}
        />
      )}
      {isHead && <circle cx={cx} cy={cy} r={2.5} fill={color} />}
    </svg>
  );
});

/** Graph cell for the work-in-progress row. */
export function WipGraphCell({
  lane,
  color,
  width,
}: {
  lane: number;
  color: number;
  width: number;
}) {
  const cx = lx(lane);
  const cy = ROW_HEIGHT / 2;
  const c = laneColor(color);
  return (
    <svg width={width} height={ROW_HEIGHT} className="block shrink-0" aria-hidden>
      <path d={`M${cx} ${cy}V${ROW_HEIGHT}`} stroke={c} strokeWidth={2} strokeDasharray="3 3" />
      <circle
        cx={cx}
        cy={cy}
        r={6}
        className="fill-background"
        stroke={c}
        strokeWidth={2}
        strokeDasharray="3 2"
      />
    </svg>
  );
}
