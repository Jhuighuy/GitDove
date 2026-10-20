import { describe, expect, it } from "vitest";
import { wordDiff } from "./words";

const marked = (s: string, rs: readonly (readonly [number, number])[]) => {
  let out = "";
  let pos = 0;
  for (const [a, b] of rs) {
    out += s.slice(pos, a) + "[" + s.slice(a, b) + "]";
    pos = b;
  }
  return out + s.slice(pos);
};

const show = (a: string, b: string) => {
  const d = wordDiff(a, b);
  return d && [marked(a, d.del), marked(b, d.add)];
};

describe("wordDiff", () => {
  it("marks changed words", () => {
    expect(show("const x = foo(a, b);", "const x = bar(a, c);")).toEqual([
      "const x = [foo](a, [b]);",
      "const x = [bar](a, [c]);",
    ]);
  });

  it("marks pure insertions on one side only", () => {
    expect(show("call(a)", "call(a, b)")).toEqual(["call(a)", "call(a[, b])"]);
  });

  it("merges changes separated by whitespace", () => {
    expect(show("let total value = 1", "let sum of things = 1")).toEqual([
      "let [total value] = 1",
      "let [sum of things] = 1",
    ]);
  });

  it("handles unicode words", () => {
    expect(show("привет мир", "привет всем")).toEqual(["привет [мир]", "привет [всем]"]);
  });

  it("skips identical, unrelated and huge lines", () => {
    expect(wordDiff("same", "same")).toBeNull();
    expect(wordDiff("alpha beta gamma", "1 + 2 * 3")).toBeNull();
    expect(wordDiff("x".repeat(2000), "y")).toBeNull();
  });
});
