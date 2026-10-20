import { describe, expect, it } from "vitest";
import { buildTree, type TreeNode } from "./tree";

/** Compact shape for assertions: leaves as strings, folders as `[name, prefix, children]`. */
type Shape = string | [string, string, Shape[]];
const shape = (nodes: readonly TreeNode<string>[]): Shape[] =>
  nodes.map((n) => (n.kind === "leaf" ? n.name : [n.name, n.prefix, shape(n.children)]));
const tree = (names: string[], base = "") => buildTree(names, (n) => n, base);

describe("buildTree", () => {
  it("groups names that share a prefix", () => {
    expect(shape(tree(["main", "release/2023.0", "release/2023.1", "release/2024.0"]))).toEqual([
      "main",
      ["release", "release/", ["2023.0", "2023.1", "2024.0"]],
    ]);
  });

  it("leaves a lone prefixed name as is", () => {
    expect(shape(tree(["main", "user/my-branch"]))).toEqual(["main", "user/my-branch"]);
    expect(shape(tree(["a/b/c", "a/d"]))).toEqual([["a", "a/", ["b/c", "d"]]]);
  });

  it("nests deeper prefixes and merges single-folder chains", () => {
    expect(shape(tree(["feature/ui/a", "feature/ui/b", "feature/x"]))).toEqual([
      ["feature", "feature/", [["ui", "feature/ui/", ["a", "b"]], "x"]],
    ]);
    expect(shape(tree(["feature/ui/a", "feature/ui/b"], "refs/heads/"))).toEqual([
      ["feature/ui", "refs/heads/feature/ui/", ["a", "b"]],
    ]);
  });

  it("keeps input order and collects folder items", () => {
    const nodes = tree(["a", "x/1", "b", "x/2", "c"]);
    expect(shape(nodes)).toEqual(["a", ["x", "x/", ["1", "2"]], "b", "c"]);
    const folder = nodes[1]!;
    expect(folder.kind === "folder" && folder.items).toEqual(["x/1", "x/2"]);
  });

  it("keeps a branch next to a folder of the same name", () => {
    expect(shape(tree(["dev", "dev/a", "dev/b"]))).toEqual(["dev", ["dev", "dev/", ["a", "b"]]]);
  });
});
