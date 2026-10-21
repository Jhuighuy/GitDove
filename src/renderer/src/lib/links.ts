/**
 * Links in commit messages: URLs, and issue or pull request references (`#12`, GitLab's `!12`,
 * `owner/repo#12`) resolved against the repository's hosting service.
 */
import type { Remote } from "@shared/domain";

export type Forge = "github" | "gitlab" | "bitbucket" | "other";

/** Where a repository lives on the web, e.g. `https://github.com` and `owner/repo`. */
export interface WebRepo {
  readonly forge: Forge;
  readonly origin: string;
  readonly path: string;
}

/** The web page of a remote (`https://…`, `ssh://…` or scp-like `git@host:path`), if it has one. */
export const webRepo = (url: string): WebRepo | null => {
  let origin: string;
  let path: string;
  const http = /^https?:\/\//i.test(url);
  const m = http
    ? null
    : (/^(?:ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(url) ??
      /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/.exec(url));
  if (http) {
    try {
      const u = new URL(url);
      origin = u.origin;
      path = u.pathname.slice(1);
    } catch {
      return null;
    }
  } else if (m) {
    origin = `https://${m[1]!.toLowerCase()}`;
    path = m[2]!;
  } else {
    return null;
  }
  path = path.replace(/\/+$/, "").replace(/\.git$/, "");
  const host = new URL(origin).hostname;
  // Dot-less names are LAN/ssh aliases (e.g. "fedora"), with no web page to link to.
  if (!host.includes(".") || !/^[\w.-]+(\/[\w.-]+)+$/.test(path)) return null;
  const forge: Forge =
    host === "github.com"
      ? "github"
      : host === "bitbucket.org"
        ? "bitbucket"
        : host.includes("gitlab")
          ? "gitlab"
          : "other";
  return { forge, origin, path };
};

/** The remote that references point to: `upstream` (of a fork), then `origin`, then any. */
export const referenceRepo = (remotes: readonly Remote[]): WebRepo | null => {
  const ordered = [
    ...remotes.filter((r) => r.name === "upstream"),
    ...remotes.filter((r) => r.name === "origin"),
    ...remotes,
  ];
  for (const r of ordered) {
    const repo = webRepo(r.fetchUrl);
    if (repo) return repo;
  }
  return null;
};

/** The page of issue or pull request `n`; `!` is GitLab's merge request sigil. */
const referenceUrl = (repo: WebRepo, path: string, sigil: string, n: string) => {
  const base = `${repo.origin}/${path}`;
  switch (repo.forge) {
    case "gitlab":
      return `${base}/-/${sigil === "!" ? "merge_requests" : "issues"}/${n}`;
    case "bitbucket":
      return `${base}/pull-requests/${n}`;
    default:
      // GitHub, Gitea and Forgejo redirect an issue URL to the pull request with that number.
      return `${base}/issues/${n}`;
  }
};

export type Segment = { readonly text: string; readonly href?: string };

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/g;
const REF_RE = /(^|[^\w/&#!-])(?:([\w.-]+\/[\w.-]+))?([#!])(\d+)\b/g;

/** Splits a message into plain text and links. */
export const linkify = (text: string, repo: WebRepo | null): Segment[] => {
  const out: Segment[] = [];
  const plain = (s: string) => {
    if (!s) return;
    if (!repo) return void out.push({ text: s });
    let last = 0;
    for (const m of s.matchAll(REF_RE)) {
      const [, before = "", path, sigil = "#", n = ""] = m;
      if (sigil === "!" && repo.forge !== "gitlab") continue;
      const start = m.index + before.length;
      if (start > last) out.push({ text: s.slice(last, start) });
      const end = m.index + m[0].length;
      out.push({
        text: s.slice(start, end),
        href: referenceUrl(repo, path ?? repo.path, sigil, n),
      });
      last = end;
    }
    if (last < s.length) out.push({ text: s.slice(last) });
  };
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    plain(text.slice(last, m.index));
    out.push({ text: m[0], href: m[0] });
    last = m.index + m[0].length;
  }
  plain(text.slice(last));
  return out;
};
