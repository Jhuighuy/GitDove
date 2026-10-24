import type { GraphRow } from "@shared/domain";
import { memo } from "react";
import { laneColor } from "@/lib/graph-colors";

export const ROW_HEIGHT = 28;
export const LANE_WIDTH = 16;
const PAD = 6;

const lx = (lane: number) => PAD + lane * LANE_WIDTH + LANE_WIDTH / 2;
const ly = (y: number) => (y * ROW_HEIGHT) / 2;

export const graphWidthFor = (lanes: number) => PAD * 2 + Math.max(1, lanes) * LANE_WIDTH;

/**
 * Width a row's lanes need (and the WIP line in `wipLane`, if any), to tell whether a narrower
 * column cuts them off.
 */
export const rowGraphWidth = (row: GraphRow, wipLane: number | null = null): number =>
  graphWidthFor(Math.max(row.width, row.lane + 1, (wipLane ?? -1) + 1));

/** Dashes of the WIP line, a whole number of them per half row so that rows join up. */
const WIP_DASHES = "4 3";

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
  readonly isHead: boolean;
  readonly isStash: boolean;
  /**
   * The column of the dashed line from the WIP row above down to HEAD, if it runs through this
   * row: it ends at HEAD's dot, and passes through any other row.
   */
  readonly wipLane?: number | null;
  /** The WIP line's color. */
  readonly wipColor?: number;
  /** Draw a line from the left edge to the dot, continuing the line from the row's ref pills. */
  readonly refLine?: boolean;
}

/**
 * Draws one row of the commit graph, as wide as its lanes: the column around it cuts it off
 * (so resizing the column does not draw it again).
 */
export const GraphCell = memo(function GraphCell({
  row,
  isHead,
  isStash,
  wipLane = null,
  wipColor = 0,
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
    <svg
      width={rowGraphWidth(row, wipLane)}
      height={ROW_HEIGHT}
      className="block shrink-0 overflow-hidden"
      aria-hidden
    >
      {wipLane !== null && (
        <path
          d={isHead ? edgePath(wipLane, 0, row.lane, 1) : `M${lx(wipLane)} 0V${ROW_HEIGHT}`}
          stroke={laneColor(wipColor)}
          strokeWidth={2}
          strokeDasharray={WIP_DASHES}
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
      {/* On a filled merge dot, HEAD is a hole instead. */}
      {isHead && (
        <circle
          cx={cx}
          cy={cy}
          r={merge && !isStash ? 2 : 2.5}
          className={merge && !isStash ? "fill-background" : undefined}
          fill={merge && !isStash ? undefined : color}
        />
      )}
    </svg>
  );
});

/** Graph cell for the work-in-progress row. */
export const WipGraphCell = memo(function WipGraphCell({
  lane,
  color,
}: {
  lane: number;
  color: number;
}) {
  const cx = lx(lane);
  const cy = ROW_HEIGHT / 2;
  const c = laneColor(color);
  return (
    <svg width={graphWidthFor(lane + 1)} height={ROW_HEIGHT} className="block shrink-0" aria-hidden>
      <path
        d={`M${cx} ${cy}V${ROW_HEIGHT}`}
        stroke={c}
        strokeWidth={2}
        strokeDasharray={WIP_DASHES}
      />
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
});
