/** Lane colors, chosen to be distinguishable on both dark and light backgrounds. */
export const LANE_COLORS = [
  "oklch(0.70 0.15 230)", // blue
  "oklch(0.70 0.18 330)", // magenta
  "oklch(0.75 0.15 150)", // green
  "oklch(0.78 0.15 75)", // amber
  "oklch(0.68 0.20 25)", // red
  "oklch(0.72 0.14 195)", // cyan
  "oklch(0.70 0.17 290)", // violet
  "oklch(0.78 0.16 120)", // lime
  "oklch(0.72 0.17 50)", // orange
  "oklch(0.70 0.12 260)", // indigo
] as const;

export const laneColor = (index: number): string => LANE_COLORS[index % LANE_COLORS.length]!;
