import { describe, expect, it } from "vitest";
import { normalizeMessage, parseOperation, rebaseTodo } from "./history";

const h = (c: string) => c.repeat(40);

describe("rebaseTodo", () => {
  it("picks, edits, folds, rewords and drops", () => {
    expect(
      rebaseTodo([
        { hash: h("a"), action: "pick" },
        { hash: h("b"), action: "drop" },
        { hash: h("c"), action: "edit" },
        { hash: h("d"), action: "pick", message: "It's\nback\\slash" },
        { hash: h("e"), action: "fixup" },
      ]),
    ).toBe(
      [
        `pick ${h("a")}`,
        `edit ${h("c")}`,
        `pick ${h("d")}`,
        `fixup ${h("e")}`,
        String.raw`exec printf '%b' 'It'\''s\nback\\slash\n' | git commit --amend --no-verify --allow-empty --cleanup=whitespace -F -`,
        `drop ${h("b")}`,
        "",
      ].join("\n"),
    );
  });

  it("breaks after an edited commit that has more applied to it", () => {
    expect(
      rebaseTodo([
        { hash: h("a"), action: "edit" },
        { hash: h("b"), action: "fixup", message: "Both" },
      ]).split("\n"),
    ).toEqual([`pick ${h("a")}`, `fixup ${h("b")}`, expect.stringMatching(/^exec /), "break", ""]);
  });

  it("rejects plans that make no sense", () => {
    expect(() => rebaseTodo([])).toThrow();
    expect(() => rebaseTodo([{ hash: h("a"), action: "fixup" }])).toThrow();
    expect(() => rebaseTodo([{ hash: h("a"), action: "pick", message: " \n" }])).toThrow();
    // Dropping everything is fine.
    expect(rebaseTodo([{ hash: h("a"), action: "drop" }])).toBe(`drop ${h("a")}\n`);
  });
});

describe("normalizeMessage", () => {
  it("trims like git, keeping comment lines", () => {
    expect(normalizeMessage("\n\nSubject  \r\n\n# kept\nbody\t\n\n\n")).toBe(
      "Subject\n\n# kept\nbody\n",
    );
  });
});

describe("parseOperation", () => {
  it("reads rebase progress", () => {
    expect(
      parseOperation(["rebasing", "refs/heads/main", "o", "c", "Subject", "2", "5", "0", "1"]),
    ).toEqual({
      state: "rebasing",
      operation: {
        branch: "main",
        onto: "o",
        commit: "c",
        subject: "Subject",
        step: 2,
        total: 5,
        remaining: 3,
        editing: true,
      },
    });
  });

  it("reads a cherry-pick sequence and clean states", () => {
    expect(parseOperation(["cherry-picking", "", "", "c", "S", "", "", "2", ""]).operation).toEqual(
      {
        branch: null,
        onto: null,
        commit: "c",
        subject: "S",
        step: null,
        total: null,
        remaining: 2,
        editing: false,
      },
    );
    expect(parseOperation(["clean"])).toEqual({ state: "clean", operation: null });
    expect(parseOperation(["bisecting", "", ""])).toEqual({ state: "bisecting", operation: null });
  });
});
