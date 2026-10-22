import type { GraphRow } from "@shared/domain";

export interface LogCommit {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorTime: number;
  readonly committerTime: number;
  readonly subject: string;
}

/**
 * Fields of a commit in `git log -z --format`, which ends each commit with a NUL (a subject
 * cannot contain one). Authors are mapped through `.mailmap`, like the branch owners.
 */
export const LOG_FORMAT = "%H%x1f%P%x1f%aN%x1f%aE%x1f%at%x1f%ct%x1f%s";

/**
 * Incremental parser for {@link LOG_FORMAT} output. Feed it raw chunks; it
 * emits complete commits as soon as they are available.
 */
export class LogParser {
  private buffer = "";
  private readonly decoder = new TextDecoder("utf-8");

  constructor(private readonly emit: (commit: LogCommit) => void) {}

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let start = 0;
    for (;;) {
      const end = this.buffer.indexOf("\0", start);
      if (end < 0) break;
      this.parseRecord(this.buffer.slice(start, end));
      start = end + 1;
    }
    this.buffer = this.buffer.slice(start);
  }

  end(): void {
    this.buffer += this.decoder.decode();
    if (this.buffer) this.parseRecord(this.buffer);
    this.buffer = "";
  }

  private parseRecord(record: string): void {
    const f = record.replace(/^\n/, "").replace(/\n$/, "").split("\x1f");
    if (f.length < 7) return;
    this.emit({
      hash: f[0]!,
      parents: f[1] ? f[1].split(" ") : [],
      authorName: f[2]!,
      authorEmail: f[3]!,
      authorTime: Number(f[4]),
      committerTime: Number(f[5]),
      subject: f.slice(6).join("\x1f"),
    });
  }
}

/**
 * Assigns commits to lanes, in the order they are produced by
 * `git log --date-order` (children always before parents).
 *
 * Lanes are never shifted: a lane keeps its column until the branch it
 * represents ends, which keeps lines straight and the layout stable while
 * scrolling. Freed columns are reused by new branches.
 */
export class GraphBuilder {
  readonly rows: GraphRow[] = [];
  maxLanes = 0;

  /** For each column, the hash of the commit expected next in it (or null). */
  private readonly lanes: (string | null)[] = [];
  private readonly colors: number[] = [];
  private nextColor = 0;
  readonly index = new Map<string, number>();

  push(c: LogCommit): void {
    const lanes = this.lanes;
    const colors = this.colors;
    const edges: number[] = [];
    const before = lanes.length;

    // Columns that were waiting for this commit.
    let col = -1;
    for (let i = 0; i < before; i++) {
      if (lanes[i] === c.hash) {
        if (col < 0) col = i;
        edges.push(i, 0, col, 1, colors[i]!);
      } else if (lanes[i] !== null) {
        // Pass-through line.
        edges.push(i, 0, i, 2, colors[i]!);
      }
    }
    if (col < 0) {
      // A branch tip: nothing was expecting this commit.
      col = this.freeColumn();
      lanes[col] = c.hash;
      colors[col] = this.nextColor++;
    }
    const color = colors[col]!;
    for (let i = col + 1; i < before; i++) {
      if (lanes[i] === c.hash) lanes[i] = null;
    }

    const parents = c.parents;
    if (parents.length === 0) {
      lanes[col] = null;
    } else {
      // The first parent always continues in this column, even if another
      // column already expects it: the lines then converge at the parent row,
      // so a branch line runs all the way down to its fork point.
      lanes[col] = parents[0]!;
      edges.push(col, 1, col, 2, color);
      for (let k = 1; k < parents.length; k++) {
        const p = parents[k]!;
        let j = this.findLane(p);
        if (j < 0) {
          j = this.freeColumn();
          lanes[j] = p;
          colors[j] = this.nextColor++;
        }
        edges.push(col, 1, j, 2, colors[j]!);
      }
    }

    while (lanes.length > 0 && lanes.at(-1) === null) {
      lanes.pop();
      colors.pop();
    }

    const width = Math.max(before, lanes.length, col + 1);
    if (width > this.maxLanes) this.maxLanes = width;
    this.index.set(c.hash, this.rows.length);
    this.rows.push({
      hash: c.hash,
      parents: c.parents,
      subject: c.subject,
      authorName: c.authorName,
      authorEmail: c.authorEmail,
      authorTime: c.authorTime,
      committerTime: c.committerTime,
      lane: col,
      color,
      edges,
      width,
    });
  }

  private findLane(hash: string): number {
    return this.lanes.indexOf(hash);
  }

  private freeColumn(): number {
    const i = this.lanes.indexOf(null);
    return i < 0 ? this.lanes.length : i;
  }
}
