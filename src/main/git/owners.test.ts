import { describe, expect, it } from "vitest";
import { branchOwners } from "./owners";

/** One `REFS_FORMAT` line. */
const ref = (name: string, oid: string, { upstream = "", symref = "" } = {}) =>
  [name, oid, "", upstream, "", "", symref].join("\0");

/** One `OWNERS_LOG_ARGS` or `TIPS_LOG_ARGS` line. */
const commit = (hash: string, parents: string, name: string, email: string, time: number) =>
  [hash, parents, name, email, String(time)].join("\0");

describe("branchOwners", () => {
  const refs = [
    ref("refs/heads/main", "m1"),
    ref("refs/heads/topic", "t2"),
    ref("refs/heads/merged", "m1"),
    ref("refs/heads/dev", "d1", { upstream: "refs/remotes/origin/develop" }),
    ref("refs/remotes/origin/HEAD", "d1", { symref: "refs/remotes/origin/develop" }),
    ref("refs/remotes/origin/develop", "d1"),
    ref("refs/remotes/origin/topic", "t1"),
    ref("refs/tags/v1", "m1"),
  ].join("\n");
  const commits = [
    commit("t2", "t1", "Ann", "Ann@X", 30),
    commit("t1", "t0", "Cid", "cid@x", 20),
    commit("t0", "m1", "Ann Old", "ann@x", 10),
  ].join("\n");
  const tips = [
    commit("t2", "", "Ann", "ann@x", 30),
    commit("m1", "", "Bob", "bob@x", 5),
    commit("d1", "", "Bob", "bob@x", 5),
    commit("t1", "", "Cid", "cid@x", 20),
  ].join("\n");
  const user = "user.name Ann\nuser.email Ann@X\n";

  it("attributes branches to the authors of their own commits", () => {
    const o = branchOwners(refs, { commits, tips }, user);
    expect(o.byRef["refs/heads/topic"]).toBe("ann@x");
    expect(o.byRef["refs/remotes/origin/topic"]).toBe("cid@x");
    // The newest commit names the email.
    expect(o.people).toEqual({
      "ann@x": { name: "Ann", time: 30 },
      "bob@x": { name: "Bob", time: 5 },
      "cid@x": { name: "Cid", time: 20 },
    });
    expect(o.me).toEqual({ email: "ann@x", name: "Ann" });
  });

  it("falls back to the tip author of merged branches", () => {
    const o = branchOwners(refs, { commits, tips }, "");
    expect(o.byRef["refs/heads/merged"]).toBe("bob@x");
    expect(o.me).toEqual({ email: null, name: null });
  });

  it("leaves default branches, their trackers and tags unowned", () => {
    const o = branchOwners(refs, { commits, tips }, "");
    expect(Object.keys(o.byRef).toSorted()).toEqual([
      "refs/heads/merged",
      "refs/heads/topic",
      "refs/remotes/origin/topic",
    ]);
  });

  it("works with tips only", () => {
    const o = branchOwners(refs, { commits: "", tips }, "");
    expect(o.byRef["refs/heads/topic"]).toBe("ann@x");
    expect(o.byRef["refs/remotes/origin/topic"]).toBe("cid@x");
    expect(branchOwners(refs, { commits: "", tips: "" }, "").byRef).toEqual({});
  });

  it("owns branches that track a default branch but have commits of their own", () => {
    const o = branchOwners(
      ref("refs/heads/feature", "f1", { upstream: "refs/remotes/origin/main" }),
      { commits: commit("f1", "m1", "Ann", "ann@x", 1), tips: commit("f1", "", "Ann", "ann@x", 1) },
      "",
    );
    expect(o.byRef).toEqual({ "refs/heads/feature": "ann@x" });
  });

  it("scopes a remote's default branch to that remote", () => {
    const o = branchOwners(
      [
        ref("refs/remotes/upstream/HEAD", "u1", { symref: "refs/remotes/upstream/develop" }),
        ref("refs/remotes/upstream/develop", "u1"),
        ref("refs/remotes/origin/develop", "o1"),
      ].join("\n"),
      {
        commits: commit("o1", "u1", "Ann", "ann@x", 2),
        tips: [commit("u1", "", "Bob", "bob@x", 1), commit("o1", "", "Ann", "ann@x", 2)].join("\n"),
      },
      "",
    );
    expect(o.byRef).toEqual({ "refs/remotes/origin/develop": "ann@x" });
  });

  it("counts the newest commits, not the closest ones", () => {
    // A merge of 99 recent commits by Ann and one old commit by Bob, in --date-order.
    const ann = Array.from({ length: 99 }, (_, i) =>
      commit(`a${i}`, i < 98 ? `a${i + 1}` : "base", "Ann", "ann@x", 1000 - i),
    );
    const o = branchOwners(
      ref("refs/heads/topic", "merge"),
      {
        commits: [
          commit("merge", "a0 bob", "Ann", "ann@x", 2000),
          ...ann,
          commit("bob", "base", "Bob", "bob@x", 1),
        ].join("\n"),
        tips: commit("merge", "", "Ann", "ann@x", 2000),
      },
      "",
    );
    expect(o.byRef["refs/heads/topic"]).toBe("ann@x");
  });

  /** A linear history of `authors` (newest first) on top of `m1`, as commits `c0`, `c1`... */
  const linear = (authors: readonly string[]) =>
    authors
      .map((a, i) =>
        commit(`c${i}`, i + 1 < authors.length ? `c${i + 1}` : "m1", a, `${a}@x`, 100 - i),
      )
      .join("\n");

  it("owns a branch by its newest commits", () => {
    const owner = (authors: readonly string[]) =>
      branchOwners(ref("refs/heads/b", "c0"), { commits: linear(authors), tips: "" }, "").byRef[
        "refs/heads/b"
      ];
    // Two commits on top of three: 1 + 1/2 against 1/3 + 1/4 + 1/5.
    expect(owner(["two", "two", "one", "one", "one"])).toBe("two@x");
    // A fixup on top of a long branch does not take it over.
    expect(owner(["two", ...Array.from({ length: 10 }, () => "one")])).toBe("one@x");
  });

  it("leaves out the branches a branch was built on", () => {
    // One's A, Two's B on top of it with a single commit, and A's copy on origin.
    const log = linear(["two", "one", "one", "one"]);
    const refsWith = (...names: string[]) =>
      [
        ref("refs/heads/b", "c0"),
        ...names.map((n) =>
          ref(n, "c1", { upstream: n === "refs/heads/a" ? "refs/remotes/origin/a" : "" }),
        ),
      ].join("\n");
    const owners = (...names: string[]) =>
      branchOwners(refsWith(...names), { commits: log, tips: "" }, "").byRef;
    expect(owners("refs/heads/a", "refs/remotes/origin/a")).toEqual({
      "refs/heads/a": "one@x",
      "refs/remotes/origin/a": "one@x",
      "refs/heads/b": "two@x",
    });
    // Once A is gone, nothing tells Two's commit from a fixup on top of One's branch.
    expect(owners()).toEqual({ "refs/heads/b": "one@x" });
  });

  it("does not leave out the upstream or copies of a branch", () => {
    const o = branchOwners(
      [
        ref("refs/heads/b", "c0", { upstream: "refs/remotes/origin/b" }),
        ref("refs/remotes/origin/b", "c1"),
        ref("refs/remotes/fork/b", "c2"),
      ].join("\n"),
      { commits: linear(["one", "two", "two", "two"]), tips: "" },
      "",
    );
    expect(o.byRef["refs/heads/b"]).toBe("two@x");
  });

  it("skips merge commits", () => {
    const o = branchOwners(
      ref("refs/heads/b", "merge"),
      {
        commits: [commit("merge", "c0 m1", "Bob", "bob@x", 200), linear(["ann"])].join("\n"),
        tips: "",
      },
      "",
    );
    expect(o.byRef["refs/heads/b"]).toBe("ann@x");
  });

  it("scales to many refs on one commit", { timeout: 3000 }, () => {
    // Remotes with the same branch name, and other branches, on a commit of the history.
    const many = Array.from({ length: 40_000 }, (_, i) => [
      ref(`refs/remotes/r${i}/x`, "c0"),
      ref(`refs/heads/b${i}`, "c1"),
    ]).flat();
    const o = branchOwners(many.join("\n"), { commits: linear(["one", "two"]), tips: "" }, "");
    expect(o.byRef["refs/remotes/r0/x"]).toBe("one@x");
    expect(o.byRef["refs/heads/b0"]).toBe("two@x");
  });

  it("walks only reachable commits, once per kind of ref", { timeout: 3000 }, () => {
    // Many refs on a tip whose parent comes after a long run of unrelated commits.
    const gap = Array.from({ length: 5000 }, (_, i) =>
      commit(`u${i}`, i + 1 < 5000 ? `u${i + 1}` : "", "Bob", "bob@x", 1e5 - i),
    );
    const many = Array.from({ length: 80_000 }, (_, i) => ref(`refs/heads/b${i}`, "t"));
    const o = branchOwners(
      [ref("refs/heads/u", "u0"), ...many].join("\n"),
      {
        commits: [
          commit("t", "p", "Ann", "ann@x", 1e6),
          ...gap,
          commit("p", "", "Ann", "ann@x", 1),
        ].join("\n"),
        tips: "",
      },
      "",
    );
    expect(o.byRef["refs/heads/b0"]).toBe("ann@x");
    expect(o.byRef["refs/heads/u"]).toBe("bob@x");
  });

  it("falls back to tip authors when walks would take too long", { timeout: 3000 }, () => {
    // Each ref's name is also a remote branch at the base its tip merged, so each walks alone.
    const base = Array.from({ length: 4000 }, (_, i) =>
      commit(`x${i}`, i + 1 < 4000 ? `x${i + 1}` : "", "Bob", "bob@x", 1e5 - i),
    );
    const many = Array.from({ length: 20_000 }, (_, i) => [
      ref(`refs/heads/b${i}`, "t"),
      ref(`refs/remotes/r/b${i}`, "x0"),
    ]).flat();
    const o = branchOwners(
      many.join("\n"),
      {
        commits: [
          commit("t", "x0 o0", "Ann", "ann@x", 1e6),
          ...base,
          commit("o0", "m1", "Cid", "cid@x", 5),
        ].join("\n"),
        tips: commit("t", "", "Ann", "ann@x", 1e6),
      },
      "",
    );
    // The first walks find Cid's commit; later ones run out and fall back to Ann's merge.
    expect(o.byRef["refs/heads/b0"]).toBe("cid@x");
    expect(o.byRef["refs/heads/b19999"]).toBe("ann@x");
  });

  it("owns a branch with only merges of other branches by its tip", () => {
    // An integration branch tracking main that merged Ann's topic.
    const o = branchOwners(
      [
        ref("refs/heads/integration", "merge", { upstream: "refs/remotes/origin/main" }),
        ref("refs/heads/topic", "c0"),
      ].join("\n"),
      {
        commits: [commit("merge", "m1 c0", "Bob", "bob@x", 200), linear(["ann"])].join("\n"),
        tips: commit("merge", "", "Bob", "bob@x", 200),
      },
      "",
    );
    expect(o.byRef["refs/heads/integration"]).toBe("bob@x");
  });
});
