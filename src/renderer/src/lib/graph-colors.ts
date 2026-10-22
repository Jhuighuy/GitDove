/** Theme-aware lane colors, paired across the light and dark palettes in styles.css. */
export const LANE_COLORS = [
  "var(--lane-0)", // terracotta
  "var(--lane-1)", // plum
  "var(--lane-2)", // teal
  "var(--lane-3)", // ochre
  "var(--lane-4)", // rose
  "var(--lane-5)", // blue
  "var(--lane-6)", // olive
  "var(--lane-7)", // violet
  "var(--lane-8)", // copper
  "var(--lane-9)", // cyan
] as const;

export const laneColor = (index: number): string => LANE_COLORS[index % LANE_COLORS.length]!;
