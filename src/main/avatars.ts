/**
 * Resolves author avatars for the `gitdove-avatar:` protocol.
 *
 * Lookup order: GitHub noreply emails (exact account), then the repository's
 * providers (GitHub's email lookup, GitLab's avatar API), then Gravatar.
 * Results — including "no avatar" — are cached on disk so each email hits the
 * network at most once every few days.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AVATAR_SCHEME,
  type AvatarProvider,
  type AvatarRequest,
  githubNoreply,
  parseAvatarUrl,
} from "@shared/avatars";
import { app, net, protocol } from "electron";
import log from "electron-log/main";
import { Data, Effect, Semaphore } from "effect";

const HIT_TTL = 7 * 24 * 3600 * 1000;
const MISS_TTL = 2 * 24 * 3600 * 1000;
/** Longest a request may take, body included. */
const TIMEOUT = "8 seconds";
/** Largest answer read (avatars are a few KB; a GitLab `avatar_url` may point anywhere). */
const MAX_BYTES = 2 * 1024 * 1024;
/** How long a host that rate-limited us is left alone, unless it says (`Retry-After`). */
const COOLDOWN = 60 * 1000;
const MAX_COOLDOWN = 60 * 60 * 1000;

interface Image {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly type: string;
}

/**
 * No avatar from a source. `transient` failures (network errors, timeouts,
 * 5xx/429) must not be cached as "no avatar".
 */
class NoAvatar extends Data.TaggedError("NoAvatar")<{
  readonly source: string;
  readonly transient: boolean;
}> {}

const definite = (source: string) => new NoAvatar({ source, transient: false });
const transient = (source: string) => new NoAvatar({ source, transient: true });

/** At most a handful of concurrent avatar downloads. */
const network = Semaphore.makeUnsafe(6);

/** Host -> when it may be asked again, after it rate-limited us or was unavailable. */
const cooldowns = new Map<string, number>();

const coolDown = (host: string, res: Response) => {
  const after = Number(res.headers.get("retry-after"));
  const ms = after > 0 ? Math.min(after * 1000, MAX_COOLDOWN) : COOLDOWN;
  cooldowns.set(host, Date.now() + ms);
  log.warn(`avatars: ${host} answered HTTP ${res.status}; leaving it alone for ${ms / 1000}s`);
};

class TooLarge extends Error {}

/** Reads at most {@link MAX_BYTES} of a body; cancelled with `signal`. */
const readBody = async (res: Response, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> => {
  if (Number(res.headers.get("content-length")) > MAX_BYTES) throw new TooLarge();
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        cancel();
        throw new TooLarge();
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  return new Uint8Array(Buffer.concat(chunks));
};

interface Fetched {
  readonly res: Response;
  /** The body, if it was wanted. */
  readonly bytes: Uint8Array<ArrayBuffer> | null;
}

/** Fetches `url`, and its body if `wanted`; the whole request is bounded in time and size. */
const fetchUrl = (url: string, accept: string, wanted: (res: Response) => boolean) => {
  const host = URL.canParse(url) ? new URL(url).host : url;
  return Effect.tryPromise({
    try: async (signal): Promise<Fetched> => {
      if (Date.now() < (cooldowns.get(host) ?? 0)) throw new Error("cooling down");
      const res = await net.fetch(url, { signal, headers: { accept } });
      const unwanted = res.status >= 500 || res.status === 429 || !wanted(res);
      if (unwanted) void res.body?.cancel().catch(() => {});
      if (res.status === 429 || res.status === 503) coolDown(host, res);
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      return { res, bytes: unwanted ? null : await readBody(res, signal) };
    },
    catch: (e) => (e instanceof TooLarge ? definite(url) : transient(url)),
  }).pipe(
    Effect.timeout(TIMEOUT),
    Effect.mapError((e) => (e instanceof NoAvatar ? e : transient(url))),
    network.withPermits(1),
  );
};

const typeOf = (res: Response) => res.headers.get("content-type") ?? "";

const image = (url: string) =>
  fetchUrl(url, "image/*", (res) => res.ok && typeOf(res).startsWith("image/")).pipe(
    Effect.flatMap(({ res, bytes }) =>
      bytes
        ? Effect.succeed({ bytes, type: typeOf(res) } satisfies Image)
        : Effect.fail(definite(url)),
    ),
  );

const parseJson = (bytes: Uint8Array | null): Record<string, unknown> => {
  try {
    const v: unknown = bytes && JSON.parse(new TextDecoder().decode(bytes));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

const GITHUB_PROBE =
  "https://avatars.githubusercontent.com/u/e?email=gitdove-probe%40invalid.invalid&s=64";

/**
 * GitHub's email lookup answers unknown emails with a shared default identicon. Fetch it once
 * for an address that cannot exist and compare against it (`null`: GitHub has none). Only an
 * answer is remembered: after a network failure the next lookup asks again, since taking the
 * identicon for a real avatar would be cached for a week.
 */
const probeGithubDefault = (): Effect.Effect<string | null, NoAvatar> =>
  Effect.runSync(
    Effect.cached(
      image(GITHUB_PROBE).pipe(
        Effect.map((img): string | null => sha256(img.bytes)),
        Effect.catchIf(
          (e) => !e.transient,
          () => Effect.succeed(null),
        ),
        Effect.tapError(() =>
          Effect.sync(() => {
            githubDefault = probeGithubDefault();
          }),
        ),
      ),
    ),
  );
let githubDefault = probeGithubDefault();

const fromGithub = (email: string, size: number) =>
  Effect.gen(function* () {
    const img = yield* image(
      `https://avatars.githubusercontent.com/u/e?email=${encodeURIComponent(email)}&s=${size}`,
    );
    // The default identicon is served for every size, so compare by hash.
    const fallback = yield* githubDefault;
    if (fallback !== null && sha256(img.bytes) === fallback) return yield* definite("github");
    return img;
  });

/**
 * GitLab's avatar API (`/api/v4/avatar`). It only knows users by their public
 * email, and instances that restrict public visibility refuse anonymous calls.
 */
const gitlabAvatarApi = (host: string, email: string, size: number) =>
  fetchUrl(
    `https://${host}/api/v4/avatar?email=${encodeURIComponent(email)}&size=${size}`,
    "application/json",
    (res) => typeOf(res).includes("json"),
  );

const avatarUrlOf = (host: string, { res, bytes }: Fetched): Effect.Effect<string, NoAvatar> => {
  const url = res.ok ? parseJson(bytes).avatar_url : undefined;
  return typeof url === "string" && /^https?:\/\//.test(url)
    ? Effect.succeed(url)
    : Effect.fail(definite(host));
};

/**
 * `gitlab` with the avatar URL served for unknown users, `locked` for GitLab
 * refusing anonymous calls, or `other`.
 */
type GitlabProbe =
  | { readonly kind: "gitlab"; readonly unknown: string }
  | { readonly kind: "locked" | "other" };

/** A probe that failed on the network is retried after this long. */
const PROBE_RETRY = 60 * 1000;

const summary = (res: Response) => {
  const final = URL.canParse(res.url) ? new URL(res.url).host : "";
  return `HTTP ${res.status}, ${res.headers.get("content-type") ?? "no type"}${
    res.redirected && final ? `, redirected to ${final}` : ""
  }`;
};

const probeGitlab = (host: string) =>
  Effect.gen(function* () {
    const fetched = yield* gitlabAvatarApi(host, "gitdove-probe@invalid.invalid", 16);
    const why = summary(fetched.res);
    if (fetched.res.status === 401 || fetched.res.status === 403) {
      const message = parseJson(fetched.bytes).message;
      if (typeof message === "string" && /^40[13]\b/.test(message)) {
        log.warn(`avatars: ${host} is GitLab but refuses anonymous avatar lookups (${why})`);
        return { kind: "locked" } satisfies GitlabProbe;
      }
    }
    const probe: GitlabProbe = yield* avatarUrlOf(host, fetched).pipe(
      Effect.map((unknown) => ({ kind: "gitlab" as const, unknown })),
      Effect.orElseSucceed(() => ({ kind: "other" as const })),
    );
    log.info(`avatars: ${host} is ${probe.kind === "gitlab" ? "" : "not "}GitLab (${why})`);
    return probe;
  }).pipe(Effect.tapError(() => Effect.sync(() => log.warn(`avatars: cannot reach ${host}`))));

/**
 * Whether a remote's host runs GitLab. Self-hosted instances can have any name,
 * so ask once per session instead of guessing from the host name. Network
 * failures (e.g. VPN not up yet) are not remembered for long.
 */
const gitlabHosts = new Map<string, { probe: Effect.Effect<GitlabProbe, NoAvatar>; at: number }>();
const isGitlab = (host: string) => {
  let entry = gitlabHosts.get(host);
  if (!entry) {
    const probe = Effect.runSync(
      Effect.cached(
        probeGitlab(host).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              const failed = gitlabHosts.get(host);
              if (failed?.probe === probe) gitlabHosts.set(host, { ...failed, at: Date.now() });
            }),
          ),
        ),
      ),
    );
    entry = { probe, at: Infinity };
    gitlabHosts.set(host, entry);
  } else if (Date.now() - entry.at > PROBE_RETRY) {
    gitlabHosts.delete(host);
    return isGitlab(host);
  }
  return entry.probe;
};

/** Avatar services (Gravatar, Libravatar) answer `d=404` instead of a placeholder. */
const noPlaceholder = (url: string) =>
  /gravatar\.com|\/avatar\/[0-9a-f]{32,64}\b/i.test(url)
    ? url.replace(/([?&])d=[^&]*/, "$1d=404")
    : url;

const fromGitlab = (host: string, email: string, size: number) =>
  Effect.gen(function* () {
    const probe = yield* isGitlab(host);
    if (probe.kind !== "gitlab") return yield* definite(host);
    const url = yield* avatarUrlOf(host, yield* gitlabAvatarApi(host, email, size));
    // Instances without Gravatar answer unknown users with a default picture.
    if (url === probe.unknown) return yield* definite(host);
    return yield* image(noPlaceholder(url));
  });

const fromGravatar = (email: string, size: number) =>
  image(`https://www.gravatar.com/avatar/${sha256(email)}?d=404&s=${size}`);

/**
 * Tries every source in order; `img` is `null` for no avatar. The answer is `final` unless a
 * source failed transiently (offline, rate-limited): a better avatar may then be found later.
 */
const resolve = ({ email, providers, size }: AvatarRequest) => {
  const noreply = githubNoreply(email);
  const attempts: Effect.Effect<Image, NoAvatar>[] = [];
  if (noreply) {
    attempts.push(
      image(
        noreply.id
          ? `https://avatars.githubusercontent.com/u/${noreply.id}?s=${size}`
          : `https://github.com/${encodeURIComponent(noreply.login)}.png?size=${size}`,
      ),
    );
  }
  for (const p of providers as readonly AvatarProvider[]) {
    if (p === "github") attempts.push(fromGithub(email, size));
    else attempts.push(fromGitlab(p.slice("gitlab:".length), email, size));
  }
  attempts.push(fromGravatar(email, size));

  let unsure = false;
  return Effect.firstSuccessOf(
    attempts.map((a) =>
      a.pipe(
        Effect.tapError((e) =>
          Effect.sync(() => {
            if (e.transient) unsure = true;
          }),
        ),
      ),
    ),
  ).pipe(
    Effect.map((img): Image | null => img),
    Effect.orElseSucceed(() => null),
    Effect.map((img) => ({ img, final: !unsure })),
  );
};

// ---------------------------------------------------------------------------
// Disk cache
// ---------------------------------------------------------------------------

const cacheDir = () => join(app.getPath("userData"), "avatars");

/** A cache entry's metadata: the image type, or `null` for "no avatar". */
const readMeta = async (base: string): Promise<{ type: string | null; at: number } | undefined> => {
  const meta = JSON.parse(await readFile(`${base}.json`, "utf8")) as {
    type?: unknown;
    at?: unknown;
  };
  const type = meta.type;
  if (typeof meta.at !== "number") return undefined;
  if (type === null) return { type, at: meta.at };
  // Served as the response's content type.
  return typeof type === "string" && /^image\/[\w.+-]+$/.test(type)
    ? { type, at: meta.at }
    : undefined;
};

const expired = (meta: { type: string | null; at: number }) =>
  Date.now() - meta.at > (meta.type ? HIT_TTL : MISS_TTL);

const readCache = async (key: string): Promise<Image | null | undefined> => {
  const base = join(cacheDir(), key);
  try {
    const meta = await readMeta(base);
    if (!meta || expired(meta)) return undefined;
    if (!meta.type) return null;
    return { bytes: new Uint8Array(await readFile(`${base}.img`)), type: meta.type };
  } catch {
    return undefined;
  }
};

/** Writes a file atomically, so a crash never leaves a truncated one. */
const writeAtomic = async (path: string, data: string | Uint8Array) => {
  await writeFile(`${path}.tmp`, data);
  await rename(`${path}.tmp`, path);
};

const writeCache = async (key: string, img: Image | null) => {
  const base = join(cacheDir(), key);
  await mkdir(cacheDir(), { recursive: true });
  if (img) await writeAtomic(`${base}.img`, img.bytes);
  await writeAtomic(`${base}.json`, JSON.stringify({ type: img?.type ?? null, at: Date.now() }));
};

/** Deletes expired and broken cache entries, which are otherwise never read again. */
export const pruneAvatarCache = async () => {
  let names: string[];
  try {
    names = await readdir(cacheDir());
  } catch {
    return;
  }
  const keys = new Set(names.map((n) => n.replace(/\.(json|img)(\.tmp)?$/, "")));
  let pruned = 0;
  for (const key of keys) {
    const base = join(cacheDir(), key);
    const meta = await readMeta(base).catch(() => undefined);
    if (meta && !expired(meta)) continue;
    await Promise.all(
      ["json", "img", "json.tmp", "img.tmp"].map((ext) => rm(`${base}.${ext}`, { force: true })),
    ).catch(() => {});
    pruned++;
  }
  if (pruned > 0) log.info(`avatars: pruned ${pruned} cache entries`);
};

const inflight = new Map<string, Promise<Image | null>>();

const lookup = (req: AvatarRequest): Promise<Image | null> => {
  const key = sha256(`${req.email}|${req.providers.join(",")}|${req.size}`);
  let pending = inflight.get(key);
  if (!pending) {
    pending = (async () => {
      const cached = await readCache(key);
      if (cached !== undefined) return cached;
      const { img, final } = await Effect.runPromise(resolve(req));
      if (!final) return img; // Offline or rate-limited: try again next time.
      await writeCache(key, img).catch((e: unknown) => log.warn("avatar cache write failed", e));
      return img;
    })().finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
};

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

/** Must run before the app is ready. */
export const registerAvatarScheme = () =>
  protocol.registerSchemesAsPrivileged([
    { scheme: AVATAR_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);

export const handleAvatarProtocol = () =>
  protocol.handle(AVATAR_SCHEME, async (request) => {
    const req = parseAvatarUrl(request.url);
    if (!req) return new Response(null, { status: 400 });
    const img = await lookup(req);
    if (!img) return new Response(null, { status: 404 });
    return new Response(img.bytes, {
      headers: { "content-type": img.type, "cache-control": "max-age=86400" },
    });
  });
