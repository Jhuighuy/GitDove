/**
 * Links in commit messages: URLs, and issue or pull request references (`#12`, GitLab's `!12`,
 * `owner/repo#12`) resolved against the repository's hosting service.
 */
import type { Remote } from "@shared/domain";

export type Forge = "github" | "gitlab" | "bitbucket" | "other";

/** Where a repository lives on the web, e.g. `https://github.com` and `owner/repo`. */
export interface WebRepo {
  readonly forge: Forge;
  readonly host: string;
  readonly origin: string;
  readonly path: string;
}

/** The web page of a remote (`https://…`, `ssh://…` or scp-like `git@host:path`), if it has one. */
export const webRepo = (url: string): WebRepo | null => {
  let origin: string;
  let host: string;
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
      host = u.hostname;
      path = u.pathname.slice(1);
    } catch {
      return null;
    }
  } else if (m && /^[a-z0-9.-]+$/i.test(m[1]!)) {
    // Bracketed IPv6 hosts and the like are left out: they have no web page worth linking.
    host = m[1]!.toLowerCase();
    origin = `https://${host}`;
    path = m[2]!;
  } else {
    return null;
  }
  const segments = path.split("/");
  while (segments.at(-1) === "") segments.pop();
  path = segments.join("/").replace(/\.git$/, "");
  // Dot-less names are LAN/ssh aliases (e.g. "fedora"), with no web page to link to.
  const valid = segments.length >= 2 && segments.every((p) => /^[\w.-]+$/.test(p));
  if (!host.includes(".") || !valid) return null;
  const forge: Forge =
    host === "github.com"
      ? "github"
      : host === "bitbucket.org"
        ? "bitbucket"
        : host.includes("gitlab")
          ? "gitlab"
          : "other";
  return { forge, host, origin, path };
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

/** A piece of a message, `start` being where it starts in the message. */
export type Segment = { readonly text: string; readonly href?: string; readonly start: number };

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/g;
/** Punctuation that ends a sentence rather than a URL. */
const TRAILING = new Set(".,;:!?)]}");
/** The closing bracket of each opening one. */
const CLOSING: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" };
const CLOSERS = new Set(Object.values(CLOSING));

/**
 * The URL at the start of `s`, without the punctuation of the sentence around it. A closing
 * bracket stays when the URL opened it: https://en.wikipedia.org/wiki/Git_(software).
 */
const trimUrl = (s: string) => {
  // Opened minus closed, keyed by the closing bracket.
  const balance = new Map<string, number>();
  const count = (close: string, delta: number) =>
    balance.set(close, (balance.get(close) ?? 0) + delta);
  for (const c of s) {
    if (CLOSING[c]) count(CLOSING[c], 1);
    else if (CLOSERS.has(c)) count(c, -1);
  }
  let end = s.length;
  while (end > 0 && TRAILING.has(s[end - 1]!)) {
    const c = s[end - 1]!;
    if (CLOSERS.has(c)) {
      // A closing bracket the URL opened.
      if (balance.get(c)! >= 0) break;
      count(c, 1);
    }
    end--;
  }
  return s.slice(0, end);
};
/** `#12` or `!12`; what comes before and after is checked by `reference`. */
const REF_RE = /[#!]\d+/g;
const WORD = /\w/;
/** Characters of an `owner/repo` qualifier. */
const QUALIFIER = /[\w./-]/;
/** Characters that make `#12` part of something else (`a#12`, `&#12;`, `##12`). */
const JOINED = /[\w/&#!-]/;

/**
 * The reference at `m` in `s` (`#12`, `owner/repo#12`, on GitLab also `group/sub/repo!12`)
 * with where it starts, or null when the match is part of a word, an entity or the like.
 */
const reference = (s: string, m: RegExpMatchArray, nested: boolean) => {
  const at = m.index!;
  const end = at + m[0].length;
  if (end < s.length && WORD.test(s[end]!)) return null;
  let start = at;
  while (start > 0 && QUALIFIER.test(s[start - 1]!)) start--;
  const qualifier = s.slice(start, at);
  if (qualifier) {
    const parts = qualifier.split("/");
    if (parts.length < 2 || (!nested && parts.length > 2)) return null;
    if (!parts.every((p) => /^[\w.-]+$/.test(p))) return null;
  }
  if (start > 0 && JOINED.test(s[start - 1]!)) return null;
  return { start, end, path: qualifier || null, sigil: m[0][0]!, n: m[0].slice(1) };
};

/** Splits a message into plain text and links. */
export const linkify = (text: string, repo: WebRepo | null): Segment[] => {
  const out: Omit<Segment, "start">[] = [];
  const plain = (s: string) => {
    if (!s) return;
    if (!repo) return void out.push({ text: s });
    let last = 0;
    for (const m of s.matchAll(REF_RE)) {
      const ref = reference(s, m, repo.forge === "gitlab");
      if (!ref || ref.start < last || (ref.sigil === "!" && repo.forge !== "gitlab")) continue;
      if (ref.start > last) out.push({ text: s.slice(last, ref.start) });
      out.push({
        text: s.slice(ref.start, ref.end),
        href: referenceUrl(repo, ref.path ?? repo.path, ref.sigil, ref.n),
      });
      last = ref.end;
    }
    if (last < s.length) out.push({ text: s.slice(last) });
  };
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    plain(text.slice(last, m.index));
    out.push({ text: url, href: url });
    last = m.index + url.length;
  }
  plain(text.slice(last));
  let start = 0;
  return out.map((s) => {
    const segment = { ...s, start };
    start += s.text.length;
    return segment;
  });
};
