import { describe, expect, it } from "vitest";
import { GraphBuilder, LogParser, type LogCommit } from "./graph";

const c = (hash: string, ...parents: string[]): LogCommit => ({
  hash,
  parents,
  authorName: "a",
  authorEmail: "a@x",
  authorTime: 0,
  subject: hash,
});

const build = (commits: LogCommit[]) => {
  const g = new GraphBuilder();
  for (const x of commits) g.push(x);
  return g;
};

describe("GraphBuilder", () => {
  it("lays out a linear history in one lane", () => {
    const g = build([c("c", "b"), c("b", "a"), c("a")]);
    expect(g.rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(g.maxLanes).toBe(1);
  });

  it("forks and merges", () => {
    // m merges f into b; f and b both branch from a.
    const g = build([c("m", "b", "f"), c("f", "a"), c("b", "a"), c("a")]);
    expect(g.rows.map((r) => r.lane)).toEqual([0, 1, 0, 0]);
    // f's lane joins a's lane at the bottom of f's row.
    const f = g.rows[1]!;
    expect(f.edges).toContain(1);
    expect(g.maxLanes).toBe(2);
    // The last row has nothing but incoming edges.
    expect(g.rows[3]!.width).toBe(2);
  });

  it("starts a new lane for each branch tip", () => {
    const g = build([c("x", "a"), c("y", "a"), c("a")]);
    expect(g.rows.map((r) => r.lane)).toEqual([0, 1, 0]);
  });

  it("reuses freed lanes", () => {
    const g = build([c("x", "a"), c("y", "b"), c("b", "a"), c("a"), c("z")]);
    expect(g.rows.at(-1)!.lane).toBe(0);
  });
});

describe("LogParser", () => {
  it("parses records split across chunks", () => {
    const out: LogCommit[] = [];
    const p = new LogParser((x) => out.push(x));
    // A subject may contain any character but NUL, including the old record separator.
    const text =
      "aaa\x1fbbb ccc\x1fJane\x1fj@x\x1f10\x1fHello\x1fworld\x1e\0bbb\x1f\x1fJoe\x1fjo@x\x1f5\x1fInit\0";
    const bytes = new TextEncoder().encode(text);
    for (let i = 0; i < bytes.length; i += 7) p.push(bytes.subarray(i, i + 7));
    p.end();
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      hash: "aaa",
      parents: ["bbb", "ccc"],
      subject: "Hello\x1fworld\x1e",
    });
    expect(out[1]).toEqual({
      hash: "bbb",
      parents: [],
      authorName: "Joe",
      authorEmail: "jo@x",
      authorTime: 5,
      subject: "Init",
    });
  });

  it("reads a last record without a terminator", () => {
    const out: LogCommit[] = [];
    const p = new LogParser((x) => out.push(x));
    p.push(new TextEncoder().encode("aaa\x1f\x1fJ\x1fj@x\x1f1\x1fOnly"));
    p.end();
    expect(out.map((commit) => commit.subject)).toEqual(["Only"]);
  });
});
