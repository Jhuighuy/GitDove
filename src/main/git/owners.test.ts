import { describe, expect, it } from "vitest";
import { branchOwners } from "./owners";

/** One `REFS_FORMAT` line. */
const ref = (
  name: string,
  oid: string,
  { upstream = "", symref = "", author = "", email = "" } = {},
) => [name, oid, "", upstream, "", "", symref, author, email ? `<${email}>` : ""].join("\0");

/** One `OWNERS_LOG_ARGS` line. */
const commit = (hash: string, parents: string, name: string, email: string) =>
  [hash, parents, name, email].join("\0");

describe("branchOwners", () => {
  const refs = [
    ref("refs/heads/main", "m1", { author: "Bob", email: "bob@x" }),
    ref("refs/heads/topic", "t2", { author: "Ann", email: "Ann@X" }),
    ref("refs/heads/merged", "m1", { author: "Bob", email: "bob@x" }),
    ref("refs/heads/dev", "d1", { upstream: "refs/remotes/origin/develop" }),
    ref("refs/remotes/origin/HEAD", "d1", { symref: "refs/remotes/origin/develop" }),
    ref("refs/remotes/origin/develop", "d1", { author: "Bob", email: "bob@x" }),
    ref("refs/remotes/origin/topic", "t1", { author: "Cid", email: "cid@x" }),
    ref("refs/tags/v1", "m1"),
  ].join("\n");
  const log = [
    commit("t2", "t1", "Ann", "ann@x"),
    commit("t1", "t0", "Cid", "cid@x"),
    commit("t0", "m1", "Ann", "ann@x"),
  ].join("\n");

  it("attributes branches to the authors of their own commits", () => {
    const o = branchOwners(refs, log, "Ann@X\n");
    expect(o.byRef["refs/heads/topic"]).toEqual(["ann@x", "cid@x"]);
    expect(o.byRef["refs/remotes/origin/topic"]).toEqual(["cid@x", "ann@x"]);
    expect(o.names).toMatchObject({ "ann@x": "Ann", "cid@x": "Cid" });
    expect(o.me).toBe("ann@x");
  });

  it("falls back to the tip author of merged branches", () => {
    const o = branchOwners(refs, log, null);
    expect(o.byRef["refs/heads/merged"]).toEqual(["bob@x"]);
    expect(o.names["bob@x"]).toBe("Bob");
    expect(o.me).toBeNull();
  });

  it("leaves default branches, their trackers and tags unowned", () => {
    const o = branchOwners(refs, log, null);
    expect(Object.keys(o.byRef).toSorted()).toEqual([
      "refs/heads/merged",
      "refs/heads/topic",
      "refs/remotes/origin/topic",
    ]);
  });

  it("works without the commit log", () => {
    const o = branchOwners(refs, "", null);
    expect(o.byRef["refs/heads/topic"]).toEqual(["ann@x"]);
    expect(o.byRef["refs/remotes/origin/topic"]).toEqual(["cid@x"]);
  });
});
