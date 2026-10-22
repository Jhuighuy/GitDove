/**
 * Resolves author avatars for the `gitdove-avatar:` protocol.
 *
 * Lookup order: GitHub noreply emails (exact account), then the repository's
 * providers (GitHub's email lookup, GitLab's avatar API), then Gravatar.
 * Results — including "no avatar" — are cached on disk so each email hits the
 * network at most once every few days.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
const TIMEOUT = "8 seconds";

interface Image {
  readonly bytes: Uint8Array;
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

/** At most a handful of concurrent avatar downloads. */
const network = Semaphore.makeUnsafe(6);

const get = (url: string, accept = "image/*") =>
  Effect.tryPromise({
    try: (signal) => net.fetch(url, { signal, headers: { accept } }),
    catch: () => new NoAvatar({ source: url, transient: true }),
  }).pipe(
    Effect.timeout(TIMEOUT),
    Effect.catch(() => Effect.fail(new NoAvatar({ source: url, transient: true }))),
    Effect.flatMap((res) =>
      res.status >= 500 || res.status === 429
        ? Effect.fail(new NoAvatar({ source: url, transient: true }))
        : Effect.succeed(res),
    ),
    network.withPermits(1),
  );

const body = <A>(source: string, read: () => Promise<A>) =>
  Effect.tryPromise({ try: read, catch: () => new NoAvatar({ source, transient: true }) });

const image = (url: string) =>
  Effect.gen(function* () {
    const res = yield* get(url);
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.startsWith("image/")) return yield* definite(url);
    const bytes = new Uint8Array(yield* body(url, () => res.arrayBuffer()));
    return { bytes, type } satisfies Image;
  });

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/**
 * GitHub's email lookup answers unknown emails with a shared default identicon.
 * Fetch it once for an address that cannot exist and compare against it.
 */
const githubDefault = Effect.runSync(
  Effect.cached(
    image(
      "https://avatars.githubusercontent.com/u/e?email=gitdove-probe%40invalid.invalid&s=64",
    ).pipe(
      Effect.map((img) => sha256(img.bytes)),
      Effect.orElseSucceed(() => null),
    ),
  ),
);

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
 * `origin` is the instance's web origin, e.g. `https://gitlab.com` or `http://git.lan:8080`.
 */
const gitlabAvatarApi = (origin: string, email: string, size: number) =>
  get(
    `${origin}/api/v4/avatar?email=${encodeURIComponent(email)}&size=${size}`,
    "application/json",
  );

const avatarUrlOf = (origin: string, res: Response) =>
  Effect.gen(function* () {
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) {
      return yield* definite(origin);
    }
    const data = yield* body(origin, () => res.json() as Promise<unknown>);
    // Any JSON parses, `null` included: only an object can name an avatar.
    const url =
      typeof data === "object" && data !== null
        ? (data as { avatar_url?: unknown }).avatar_url
        : undefined;
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) return yield* definite(origin);
    return url;
  });

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

const probeGitlab = (origin: string) =>
  Effect.gen(function* () {
    const res = yield* gitlabAvatarApi(origin, "gitdove-probe@invalid.invalid", 16);
    const why = summary(res);
    // GitLab marks its answers, its error pages included.
    const marked = res.headers.has("x-gitlab-meta");
    if (res.status === 401 || res.status === 403 || (marked && !res.ok)) {
      const message = yield* body(origin, () => res.json() as Promise<{ message?: unknown }>).pipe(
        Effect.map((b) => (typeof b === "object" && b !== null ? b.message : null)),
        Effect.orElseSucceed(() => null),
      );
      if (marked || (typeof message === "string" && /^40[13]\b/.test(message))) {
        log.warn(`avatars: ${origin} is GitLab but refuses anonymous avatar lookups (${why})`);
        return { kind: "locked" } satisfies GitlabProbe;
      }
    }
    const probe: GitlabProbe = yield* avatarUrlOf(origin, res).pipe(
      Effect.map((unknown) => ({ kind: "gitlab" as const, unknown })),
      Effect.catchIf(
        (e) => !e.transient,
        () => Effect.succeed({ kind: marked ? ("locked" as const) : ("other" as const) }),
      ),
    );
    log.info(`avatars: ${origin} is ${probe.kind === "other" ? "not " : ""}GitLab (${why})`);
    return probe;
  }).pipe(Effect.tapError(() => Effect.sync(() => log.warn(`avatars: cannot reach ${origin}`))));

/**
 * Whether a web origin runs GitLab. Self-hosted instances can have any name,
 * so ask once per session instead of guessing from the host name. Network
 * failures (e.g. VPN not up yet) are not remembered for long.
 */
const gitlabOrigins = new Map<
  string,
  { probe: Effect.Effect<GitlabProbe, NoAvatar>; at: number }
>();
const probeOf = (origin: string): Effect.Effect<GitlabProbe, NoAvatar> => {
  let entry = gitlabOrigins.get(origin);
  if (!entry) {
    const probe = Effect.runSync(
      Effect.cached(
        probeGitlab(origin).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              const failed = gitlabOrigins.get(origin);
              if (failed?.probe === probe) gitlabOrigins.set(origin, { ...failed, at: Date.now() });
            }),
          ),
        ),
      ),
    );
    entry = { probe, at: Infinity };
    gitlabOrigins.set(origin, entry);
  } else if (Date.now() - entry.at > PROBE_RETRY) {
    gitlabOrigins.delete(origin);
    return probeOf(origin);
  }
  return entry.probe;
};

/** Whether a web origin runs GitLab, refusing anonymous lookups or not (false if unreachable). */
export const isGitlab = (origin: string) =>
  probeOf(origin).pipe(
    Effect.map((p) => p.kind !== "other"),
    Effect.orElseSucceed(() => false),
  );

/** Avatar services (Gravatar, Libravatar) answer `d=404` instead of a placeholder. */
const noPlaceholder = (url: string) =>
  /gravatar\.com|\/avatar\/[0-9a-f]{32,64}\b/i.test(url)
    ? url.replace(/([?&])d=[^&]*/, "$1d=404")
    : url;

const fromGitlab = (host: string, email: string, size: number) =>
  Effect.gen(function* () {
    const origin = `https://${host}`;
    const probe = yield* probeOf(origin);
    if (probe.kind !== "gitlab") return yield* definite(host);
    const url = yield* avatarUrlOf(origin, yield* gitlabAvatarApi(origin, email, size));
    // Instances without Gravatar answer unknown users with a default picture.
    if (url === probe.unknown) return yield* definite(host);
    return yield* image(noPlaceholder(url));
  });

const fromGravatar = (email: string, size: number) =>
  image(`https://www.gravatar.com/avatar/${sha256(email)}?d=404&s=${size}`);

/** Tries every source in order; `null` = definitely no avatar, `undefined` = try again later. */
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

  let transient = false;
  return Effect.firstSuccessOf(
    attempts.map((a) =>
      a.pipe(
        Effect.tapError((e) =>
          Effect.sync(() => {
            if (e.transient) transient = true;
          }),
        ),
      ),
    ),
  ).pipe(
    Effect.map((img): Image | null | undefined => img),
    Effect.orElseSucceed(() => (transient ? undefined : null)),
  );
};

// ---------------------------------------------------------------------------
// Disk cache
// ---------------------------------------------------------------------------

const cacheDir = () => join(app.getPath("userData"), "avatars");

const readCache = async (key: string): Promise<Image | null | undefined> => {
  const base = join(cacheDir(), key);
  try {
    const meta = JSON.parse(await readFile(`${base}.json`, "utf8")) as {
      type: string | null;
      at: number;
    };
    const ttl = meta.type ? HIT_TTL : MISS_TTL;
    if (Date.now() - meta.at > ttl) return undefined;
    if (!meta.type) return null;
    return { bytes: new Uint8Array(await readFile(`${base}.img`)), type: meta.type };
  } catch {
    return undefined;
  }
};

const writeCache = async (key: string, img: Image | null) => {
  const base = join(cacheDir(), key);
  await mkdir(cacheDir(), { recursive: true });
  if (img) await writeFile(`${base}.img`, img.bytes);
  await writeFile(`${base}.json.tmp`, JSON.stringify({ type: img?.type ?? null, at: Date.now() }));
  await rename(`${base}.json.tmp`, `${base}.json`);
};

const inflight = new Map<string, Promise<Image | null>>();

const lookup = (req: AvatarRequest): Promise<Image | null> => {
  const key = sha256(`${req.email}|${req.providers.join(",")}|${req.size}`);
  let pending = inflight.get(key);
  if (!pending) {
    pending = (async () => {
      const cached = await readCache(key);
      if (cached !== undefined) return cached;
      const img = await Effect.runPromise(resolve(req));
      if (img === undefined) return null; // Offline or rate-limited: retry next time.
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
