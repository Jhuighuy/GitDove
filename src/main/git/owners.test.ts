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
    expect(o.byRef["refs/heads/topic"]).toEqual(["ann@x", "cid@x"]);
    expect(o.byRef["refs/remotes/origin/topic"]).toEqual(["cid@x", "ann@x"]);
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
    expect(o.byRef["refs/heads/merged"]).toEqual(["bob@x"]);
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
    expect(o.byRef["refs/heads/topic"]).toEqual(["ann@x"]);
    expect(o.byRef["refs/remotes/origin/topic"]).toEqual(["cid@x"]);
    expect(branchOwners(refs, { commits: "", tips: "" }, "").byRef).toEqual({});
  });

  it("owns branches that track a default branch but have commits of their own", () => {
    const o = branchOwners(
      ref("refs/heads/feature", "f1", { upstream: "refs/remotes/origin/main" }),
      { commits: commit("f1", "m1", "Ann", "ann@x", 1), tips: commit("f1", "", "Ann", "ann@x", 1) },
      "",
    );
    expect(o.byRef).toEqual({ "refs/heads/feature": ["ann@x"] });
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
    expect(o.byRef).toEqual({ "refs/remotes/origin/develop": ["ann@x"] });
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
    expect(o.byRef["refs/heads/topic"]).toEqual(["ann@x"]);
  });
});
