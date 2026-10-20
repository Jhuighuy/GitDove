/** A node of a slash-separated name tree (e.g. branches in the sidebar). */
export type TreeNode<T> =
  | {
      readonly kind: "folder";
      /** Display name, possibly several segments (`feature/ui`) after merging. */
      readonly name: string;
      /** Full prefix including the base and a trailing slash (`refs/heads/feature/`). */
      readonly prefix: string;
      readonly children: readonly TreeNode<T>[];
      /** Every item below this folder, in input order. */
      readonly items: readonly T[];
    }
  | {
      readonly kind: "leaf";
      /** Display name relative to the parent folder. */
      readonly name: string;
      readonly item: T;
    };

interface Entry<T> {
  readonly rest: string;
  readonly item: T;
  readonly index: number;
}

/**
 * Groups items by the slash-separated segments of their names. A folder is only
 * created for a prefix shared by at least two items (a lone `user/topic` stays a
 * leaf), and a folder whose only child is another folder is merged into it
 * (`feature/ui`). Nodes keep the input order of their first item.
 */
export function buildTree<T>(
  items: readonly T[],
  nameOf: (item: T) => string,
  /** Prefix prepended to folder prefixes, e.g. `refs/heads/`. */
  base = "",
): TreeNode<T>[] {
  return build(
    items.map((item, index) => ({ rest: nameOf(item), item, index })),
    base,
  );
}

function build<T>(entries: readonly Entry<T>[], base: string): TreeNode<T>[] {
  const nodes: { node: TreeNode<T>; index: number }[] = [];
  const groups = new Map<string, Entry<T>[]>();
  for (const e of entries) {
    const slash = e.rest.indexOf("/");
    if (slash <= 0) {
      nodes.push({ node: { kind: "leaf", name: e.rest, item: e.item }, index: e.index });
      continue;
    }
    const head = e.rest.slice(0, slash);
    const group = groups.get(head) ?? [];
    group.push({ ...e, rest: e.rest.slice(slash + 1) });
    groups.set(head, group);
  }
  for (const [head, group] of groups) {
    const first = group[0]!;
    if (group.length === 1) {
      nodes.push({
        node: { kind: "leaf", name: `${head}/${first.rest}`, item: first.item },
        index: first.index,
      });
      continue;
    }
    const prefix = `${base}${head}/`;
    const children = build(group, prefix);
    const only = children.length === 1 ? children[0] : undefined;
    const node: TreeNode<T> =
      only?.kind === "folder"
        ? { ...only, name: `${head}/${only.name}` }
        : { kind: "folder", name: head, prefix, children, items: group.map((g) => g.item) };
    nodes.push({ node, index: first.index });
  }
  return nodes.toSorted((a, b) => a.index - b.index).map((n) => n.node);
}
