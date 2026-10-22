import { expect, it } from "vitest";
import { linkify, referenceRepo, webRepo } from "./links";

it("finds the web page of a remote", () => {
  const gh = {
    forge: "github",
    host: "github.com",
    origin: "https://github.com",
    path: "ada/engine",
  };
  expect(webRepo("git@github.com:ada/engine.git")).toEqual(gh);
  expect(webRepo("https://github.com/ada/engine.git")).toEqual(gh);
  expect(webRepo("https://user:token@github.com/ada/engine/")).toEqual(gh);
  expect(webRepo("ssh://git@github.com:22/ada/engine.git")).toEqual(gh);
  expect(webRepo("ssh://git@gitlab.example.org/group/sub/project.git")).toEqual({
    forge: "gitlab",
    host: "gitlab.example.org",
    origin: "https://gitlab.example.org",
    path: "group/sub/project",
  });
  expect(webRepo("https://bitbucket.org/team/repo")?.forge).toBe("bitbucket");
  expect(webRepo("https://codeberg.org/ada/engine")?.forge).toBe("other");
  expect(webRepo("http://git.lan:8080/ada/engine")?.origin).toBe("http://git.lan:8080");
  // Local paths, ssh aliases and odd URLs have no web page.
  for (const url of [
    "/srv/repo.git",
    "file:///srv/repo",
    "fedora:repos/x.git",
    "github.com:x",
    "git@[2001:db8::1]:owner/repo.git",
    "ssh://git@[2001:db8::1]/owner/repo.git",
  ])
    expect(webRepo(url)).toBeNull();
});

it("prefers the upstream remote, then origin", () => {
  const remote = (name: string, fetchUrl: string) => ({ name, fetchUrl, pushUrl: "" });
  expect(
    referenceRepo([
      remote("fork", "git@github.com:me/fork.git"),
      remote("origin", "git@github.com:me/engine.git"),
      remote("upstream", "git@github.com:ada/engine.git"),
    ])?.path,
  ).toBe("ada/engine");
  expect(
    referenceRepo([remote("fork", "/srv/x"), remote("origin", "git@github.com:me/engine.git")])
      ?.path,
  ).toBe("me/engine");
  expect(referenceRepo([remote("fork", "git@github.com:me/fork.git")])?.path).toBe("me/fork");
  expect(referenceRepo([remote("origin", "/srv/x")])).toBeNull();
});

const links = (text: string, url: string | null) =>
  linkify(text, url ? webRepo(url) : null)
    .filter((s) => s.href)
    .map((s) => [s.text, s.href]);

it("links issue and pull request references", () => {
  const gh = "https://github.com/ada/engine";
  expect(links("Fix the engine (#12), see #3 and other/lib#4", gh)).toEqual([
    ["#12", `${gh}/issues/12`],
    ["#3", `${gh}/issues/3`],
    ["other/lib#4", "https://github.com/other/lib/issues/4"],
  ]);
  // Not references: inside words, URLs, entities; `!` outside GitLab.
  expect(links("a#1 &#38; x/#2 ##3 !4 #5a a/b/c#8", gh)).toEqual([]);
  expect(links("#1, -#2 x(#3) #6#7", gh)).toEqual([
    ["#1", `${gh}/issues/1`],
    ["#3", `${gh}/issues/3`],
    ["#6", `${gh}/issues/6`],
  ]);
  // Long words stay fast.
  expect(links(`${"a".repeat(50_000)}#1`, gh)).toEqual([]);
  expect(links("Merge !5 for #6", "https://gitlab.com/g/p")).toEqual([
    ["!5", "https://gitlab.com/g/p/-/merge_requests/5"],
    ["#6", "https://gitlab.com/g/p/-/issues/6"],
  ]);
  // GitLab projects may sit in nested groups; GitHub's are owner/repo only.
  expect(links("See group/repo!1234 and g/sub/r#7", "https://gitlab.com/g/p")).toEqual([
    ["group/repo!1234", "https://gitlab.com/group/repo/-/merge_requests/1234"],
    ["g/sub/r#7", "https://gitlab.com/g/sub/r/-/issues/7"],
  ]);
  expect(links("g/sub/r#7", gh)).toEqual([]);
  expect(
    links("Merged in x (Pull request #7), fixes #8; pull request: #9", "https://bitbucket.org/t/r"),
  ).toEqual([
    ["#7", "https://bitbucket.org/t/r/pull-requests/7"],
    ["#8", "https://bitbucket.org/t/r/issues/8"],
    ["#9", "https://bitbucket.org/t/r/pull-requests/9"],
  ]);
  // Without a web page, only URLs are links.
  expect(links("#8 at https://x.org/a#b.", null)).toEqual([
    ["https://x.org/a#b", "https://x.org/a#b"],
  ]);
});

it("leaves sentence punctuation out of URLs", () => {
  expect(links("(see https://x.org/a.b?c=1).", null)).toEqual([
    ["https://x.org/a.b?c=1", "https://x.org/a.b?c=1"],
  ]);
  expect(links("https://x.org/...", null)).toEqual([["https://x.org/", "https://x.org/"]]);
  // Brackets the URL opened are part of it.
  const wiki = "https://en.wikipedia.org/wiki/Git_(software)";
  expect(links(`See ${wiki}.`, null)).toEqual([[wiki, wiki]]);
  expect(links(`(see ${wiki})`, null)).toEqual([[wiki, wiki]]);
  expect(links("[https://x.org/a[1]]", null)).toEqual([
    ["https://x.org/a[1]", "https://x.org/a[1]"],
  ]);
  // Long runs of punctuation stay fast.
  for (const tail of [".", ")"]) {
    const long = `https://x.org/${tail.repeat(50_000)}`;
    expect(links(long, null)).toEqual([["https://x.org/", "https://x.org/"]]);
  }
});

it("keeps all of the text", () => {
  const text = "Fix (#12): see https://x.org/y, and #3.";
  const segments = linkify(text, webRepo("https://github.com/a/b"));
  expect(segments.map((s) => s.text).join("")).toBe(text);
  expect(segments.map((s) => text.slice(s.start, s.start + s.text.length))).toEqual(
    segments.map((s) => s.text),
  );
  expect(segments.map((s) => s.href ?? null)).toEqual([
    null,
    "https://github.com/a/b/issues/12",
    null,
    "https://x.org/y",
    null,
    "https://github.com/a/b/issues/3",
    null,
  ]);
});
