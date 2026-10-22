import type { DiffModel, Row } from "./model";

/** A position in a diff's text: a row of the view and a character in its line. */
export interface TextPoint {
  readonly row: number;
  readonly offset: number;
}

/**
 * The text between two points of a diff view, one line per row, without line numbers or signs.
 * In split view `side` picks the column; hunk headers, empty cells and no-newline markers are left
 * out.
 */
export const copiedText = (
  model: DiffModel,
  rows: readonly Row[],
  start: TextPoint,
  end: TextPoint,
  side: 0 | 1,
): string => {
  const out: string[] = [];
  for (let i = start.row; i <= end.row; i++) {
    const row = rows[i];
    const id =
      row?.type === "line" ? row.id : row?.type === "split" ? [row.left, row.right][side]! : -1;
    if (id < 0 || model.lines[id]!.kind === "meta") continue;
    let text = model.lines[id]!.text;
    if (i === end.row) text = text.slice(0, end.offset);
    if (i === start.row) text = text.slice(start.offset);
    out.push(text);
  }
  return out.join("\n");
};
