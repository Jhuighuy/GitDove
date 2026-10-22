/**
 * Author avatars are served by the main process through the `gitdove-avatar:`
 * protocol, which resolves them via GitHub, GitLab and Gravatar and caches the
 * result on disk. This module builds and parses those URLs.
 */

export const AVATAR_SCHEME = "gitdove-avatar";

/** Where to look an email up, besides Gravatar: `github` or a (possible) GitLab host. */
export type AvatarProvider = "github" | `gitlab:${string}`;

const HOST_RE = /^[a-z0-9.-]+(:\d+)?$/i;

/**
 * Extracts the host from a git remote URL (`https://…`, `ssh://…` or scp-like
 * `git@host:path`). HTTP(S) remotes keep their port, which the web UI shares.
 */
export const remoteHost = (url: string): string | null => {
  const web = /^https?:\/\/(?:[^@/]+@)?([^/:]+(?::\d+)?)/i.exec(url);
  const m =
    web ??
    /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)/i.exec(url) ??
    /^(?:[^@/]+@)?([^/:]+):(?!\/\/)/.exec(url);
  return m?.[1]?.toLowerCase().replace(/:443$/, "") ?? null;
};

/** Hosts known not to run GitLab, so they are never probed. */
const NOT_GITLAB = [
  "bitbucket.org",
  "codeberg.org",
  "dev.azure.com",
  "ssh.dev.azure.com",
  "vs-ssh.visualstudio.com",
  "git.sr.ht",
  "huggingface.co",
  "sourceforge.net",
  "git.code.sf.net",
];

/**
 * Avatar providers implied by a repository's remotes. Any other host may be a
 * self-hosted GitLab (e.g. gitlab.kitware.com, gitlab.inria.fr, or an instance
 * with no "gitlab" in its name); the main process checks before using it.
 */
export const providersForRemotes = (urls: readonly string[]): AvatarProvider[] => {
  const out = new Set<AvatarProvider>();
  for (const url of urls) {
    const host = remoteHost(url);
    if (!host || !HOST_RE.test(host)) continue;
    const name = host.replace(/:\d+$/, "");
    if (name === "github.com" || name.endsWith(".github.com")) out.add("github");
    else if (NOT_GITLAB.some((h) => name === h || name.endsWith(`.${h}`))) continue;
    // Dot-less names are LAN/ssh aliases (e.g. "fedora"), unlikely to serve HTTPS.
    else if (name.includes(".") || name.includes("gitlab")) out.add(`gitlab:${host}`);
  }
  return [...out];
};

export const avatarUrl = (email: string, providers: readonly AvatarProvider[], size: number) =>
  `${AVATAR_SCHEME}://avatar/?e=${encodeURIComponent(email.trim().toLowerCase())}` +
  `&p=${encodeURIComponent(providers.join(","))}&s=${size}`;

export interface AvatarRequest {
  readonly email: string;
  readonly providers: readonly AvatarProvider[];
  readonly size: number;
}

export const parseAvatarUrl = (url: string): AvatarRequest | null => {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const email = u.searchParams.get("e") ?? "";
  const size = Number(u.searchParams.get("s"));
  if (!email || email.length > 320 || !email.includes("@") || /[\s\0]/.test(email)) return null;
  if (!Number.isInteger(size) || size < 8 || size > 512) return null;
  const providers = (u.searchParams.get("p") ?? "")
    .split(",")
    .filter(
      (p): p is AvatarProvider =>
        p === "github" || (p.startsWith("gitlab:") && HOST_RE.test(p.slice("gitlab:".length))),
    );
  return { email, providers, size };
};

/** GitHub's private commit emails embed the account: `[id+]login@users.noreply.github.com`. */
export const githubNoreply = (email: string): { id: string | null; login: string } | null => {
  const m = /^(?:(\d+)\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(email);
  return m ? { id: m[1] ?? null, login: m[2]! } : null;
};
