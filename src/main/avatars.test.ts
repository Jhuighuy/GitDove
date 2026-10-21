import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AVATAR_SCHEME, type AvatarProvider, avatarUrl } from "@shared/avatars";

type Route = (url: string) => Response | Promise<Response>;
const electron = vi.hoisted(() => ({
  userData: "",
  route: null as null | ((url: string) => Response | Promise<Response>),
  handler: null as null | ((request: { url: string }) => Promise<Response>),
}));
const fetch = vi.hoisted(() =>
  vi.fn(async (url: string, _init?: { signal?: AbortSignal; headers?: Record<string, string> }) => {
    if (!electron.route) throw new Error("no route");
    return electron.route(url);
  }),
);
const protocol = vi.hoisted(() => ({
  registerSchemesAsPrivileged: vi.fn(),
  handle: vi.fn((_scheme: string, h: (request: { url: string }) => Promise<Response>) => {
    electron.handler = h;
  }),
}));
vi.mock("electron", () => ({
  app: { getPath: () => electron.userData },
  net: { fetch },
  protocol,
}));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock("electron-log/main", () => ({ default: log }));

const png = (tag: string) =>
  new Response(new TextEncoder().encode(`png:${tag}`), {
    headers: { "content-type": "image/png" },
  });
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const status = (code: number) => new Response(null, { status: code });

/** Serves `routes` by URL prefix; anything else is a 404. */
const serve = (routes: Record<string, Route | Response>) => {
  electron.route = (url) => {
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!hit) return status(404);
    const r = hit[1];
    return typeof r === "function" ? r(url) : r.clone();
  };
};

const GITHUB_DEFAULT =
  "https://avatars.githubusercontent.com/u/e?email=gitdove-probe%40invalid.invalid";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const gravatar = (email: string) => `https://www.gravatar.com/avatar/${sha256(email)}?d=404&s=`;

/** A fresh module: it keeps probes and in-flight lookups at module level. */
const load = async () => {
  vi.resetModules();
  const m = await import("./avatars");
  m.handleAvatarProtocol();
  return m;
};

const request = async (email: string, providers: AvatarProvider[] = [], size = 64) => {
  const res = await electron.handler!({ url: avatarUrl(email, providers, size) });
  return {
    status: res.status,
    type: res.headers.get("content-type"),
    cache: res.headers.get("cache-control"),
    body: res.status === 200 ? new TextDecoder().decode(await res.arrayBuffer()) : null,
  };
};
const fetched = () => fetch.mock.calls.map((c) => c[0]);

beforeEach(() => {
  electron.userData = mkdtempSync(join(tmpdir(), "gitdove-avatars-"));
  electron.route = null;
  fetch.mockClear();
  log.warn.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(electron.userData, { recursive: true, force: true });
});

describe("avatar protocol", () => {
  it("registers a privileged scheme", async () => {
    const { registerAvatarScheme } = await load();
    registerAvatarScheme();
    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      {
        scheme: AVATAR_SCHEME,
        privileges: { standard: true, secure: true, supportFetchAPI: true },
      },
    ]);
    expect(protocol.handle).toHaveBeenCalledWith(AVATAR_SCHEME, expect.any(Function));
  });

  it("rejects malformed requests", async () => {
    await load();
    const res = await electron.handler!({ url: `${AVATAR_SCHEME}://avatar/?e=nope&s=64` });
    expect(res.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("serves images with their type and a cache header", async () => {
    await load();
    serve({ "https://www.gravatar.com/": png("g") });
    expect(await request("a@x.org")).toEqual({
      status: 200,
      type: "image/png",
      cache: "max-age=86400",
      body: "png:g",
    });
  });
});

describe("avatar lookup", () => {
  it("uses the exact GitHub account of noreply emails", async () => {
    await load();
    serve({
      "https://avatars.githubusercontent.com/u/123?": png("id"),
      "https://github.com/octo-cat.png": png("login"),
    });
    expect((await request("123+octo@users.noreply.github.com", ["github"], 40)).body).toBe(
      "png:id",
    );
    expect((await request("octo-cat@users.noreply.github.com")).body).toBe("png:login");
    expect(fetched()).toEqual([
      "https://avatars.githubusercontent.com/u/123?s=40",
      "https://github.com/octo-cat.png?size=64",
    ]);
  });

  it("asks GitHub by email and ignores its default identicon", async () => {
    await load();
    serve({
      [GITHUB_DEFAULT]: png("identicon"),
      "https://avatars.githubusercontent.com/u/e?email=known%40x.org": png("known"),
      "https://avatars.githubusercontent.com/u/e?email=unknown%40x.org": png("identicon"),
      [gravatar("unknown@x.org")]: png("gravatar"),
    });
    expect((await request("known@x.org", ["github"])).body).toBe("png:known");
    expect((await request("unknown@x.org", ["github"])).body).toBe("png:gravatar");
    // The default identicon is fetched once.
    expect(fetched().filter((u) => u.startsWith(GITHUB_DEFAULT))).toHaveLength(1);
    expect(fetched()).toContain(`${gravatar("unknown@x.org")}64`);
  });

  it("uses GitHub's answer when its default identicon is unavailable", async () => {
    await load();
    serve({
      [GITHUB_DEFAULT]: status(404),
      "https://avatars.githubusercontent.com/u/e?email=": png("whatever"),
    });
    expect((await request("a@x.org", ["github"])).body).toBe("png:whatever");
  });

  it("probes GitLab hosts once and uses their avatar API", async () => {
    await load();
    serve({
      "https://gitlab.example.org/api/v4/avatar?email=gitdove-probe%40invalid.invalid&size=16":
        json({
          avatar_url: "https://secure.gravatar.com/avatar/probe?s=16&d=identicon",
        }),
      "https://gitlab.example.org/api/v4/avatar?email=dev%40x.org&size=64": json({
        avatar_url: "https://gitlab.example.org/uploads/dev.png",
      }),
      "https://gitlab.example.org/api/v4/avatar?email=anon%40x.org&size=64": json({
        avatar_url: "https://secure.gravatar.com/avatar/abc?s=64&d=identicon&r=g",
      }),
      "https://gitlab.example.org/uploads/dev.png": png("gitlab"),
      "https://secure.gravatar.com/avatar/abc?s=64&d=404&r=g": png("gravatar-via-gitlab"),
    });
    expect((await request("dev@x.org", ["gitlab:gitlab.example.org"])).body).toBe("png:gitlab");
    expect((await request("anon@x.org", ["gitlab:gitlab.example.org"])).body).toBe(
      "png:gravatar-via-gitlab",
    );
    expect(fetched().filter((u) => u.includes("gitdove-probe"))).toHaveLength(1);
    expect(fetch.mock.calls.find((c) => c[0].includes("/api/v4/"))?.[1]?.headers).toEqual({
      accept: "application/json",
    });
    expect(log.info).toHaveBeenCalledWith("avatars: gitlab.example.org is GitLab");
  });

  it("skips hosts that are not GitLab", async () => {
    await load();
    serve({
      "https://git.example.org/": new Response("<html>", {
        headers: { "content-type": "text/html" },
      }),
      [gravatar("a@x.org")]: png("gravatar"),
    });
    expect((await request("a@x.org", ["gitlab:git.example.org"])).body).toBe("png:gravatar");
    expect((await request("a@x.org", ["gitlab:git.example.org"], 32)).body).toBe("png:gravatar");
    expect(fetched().filter((u) => u.startsWith("https://git.example.org/"))).toHaveLength(1);
    expect(log.info).toHaveBeenCalledWith("avatars: git.example.org is not GitLab");
  });

  it("ignores GitLab answers without a usable avatar URL", async () => {
    await load();
    const probe = json({ avatar_url: "https://gitlab.example.org/probe.png" });
    serve({
      "https://gitlab.example.org/api/v4/avatar?email=gitdove-probe": probe,
      "https://gitlab.example.org/api/v4/avatar?email=a%40x.org": json({
        avatar_url: "javascript:x",
      }),
      "https://gitlab.example.org/api/v4/avatar?email=b%40x.org": json({}),
      "https://gitlab.example.org/api/v4/avatar?email=c%40x.org": new Response("{}", {
        headers: { "content-type": "text/plain" },
      }),
      "https://www.gravatar.com/": png("gravatar"),
    });
    for (const email of ["a@x.org", "b@x.org", "c@x.org"]) {
      expect((await request(email, ["gitlab:gitlab.example.org"])).body).toBe("png:gravatar");
    }
  });

  it("falls back to Gravatar with a SHA-256 hash", async () => {
    await load();
    serve({ [gravatar("me@x.org")]: png("gravatar") });
    expect((await request("Me@X.org", [], 128)).body).toBe("png:gravatar");
    expect(fetched()).toEqual([`${gravatar("me@x.org")}128`]);
  });

  it("does not accept non-image answers", async () => {
    await load();
    serve({
      "https://www.gravatar.com/": new Response("hi", {
        headers: { "content-type": "text/plain" },
      }),
    });
    expect((await request("a@x.org")).status).toBe(404);
  });

  it("tries the sources in order and stops at the first avatar", async () => {
    await load();
    serve({
      [GITHUB_DEFAULT]: png("identicon"),
      "https://avatars.githubusercontent.com/u/e?email=": png("identicon"),
      "https://gitlab.example.org/api/v4/avatar?email=gitdove-probe": json({
        avatar_url: "https://gitlab.example.org/x.png",
      }),
      "https://gitlab.example.org/api/v4/avatar?email=a%40x.org": json({
        avatar_url: "https://gitlab.example.org/a.png",
      }),
      "https://gitlab.example.org/a.png": png("gitlab"),
    });
    expect((await request("a@x.org", ["github", "gitlab:gitlab.example.org"])).body).toBe(
      "png:gitlab",
    );
    expect(fetched().some((u) => u.includes("gravatar"))).toBe(false);
  });
});

describe("avatar cache", () => {
  it("serves hits from disk", async () => {
    await load();
    serve({ "https://www.gravatar.com/": png("g") });
    await request("a@x.org");
    expect(readdirSync(join(electron.userData, "avatars")).toSorted()).toEqual(
      expect.arrayContaining([expect.stringMatching(/\.img$/), expect.stringMatching(/\.json$/)]),
    );
    await load();
    electron.route = null;
    expect((await request("a@x.org")).body).toBe("png:g");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("caches misses for two days and hits for a week", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    await load();
    serve({});
    expect((await request("miss@x.org")).status).toBe(404);
    serve({ "https://www.gravatar.com/": png("g") });
    expect((await request("hit@x.org")).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);

    vi.setSystemTime(start + 47 * 3600 * 1000);
    expect((await request("miss@x.org")).status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(2);

    vi.setSystemTime(start + 49 * 3600 * 1000);
    expect((await request("miss@x.org")).body).toBe("png:g");
    expect((await request("hit@x.org")).body).toBe("png:g");
    expect(fetch).toHaveBeenCalledTimes(3);

    vi.setSystemTime(start + 8 * 24 * 3600 * 1000);
    expect((await request("hit@x.org")).body).toBe("png:g");
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("keys the cache by providers and size", async () => {
    await load();
    serve({ "https://www.gravatar.com/": png("g") });
    await request("a@x.org", [], 32);
    await request("a@x.org", [], 64);
    await request("a@x.org", ["gitlab:nope.example.org"], 64);
    expect(fetched().filter((u) => u.includes("gravatar"))).toHaveLength(3);
  });

  it("does not cache transient failures", async () => {
    await load();
    let n = 0;
    serve({
      "https://www.gravatar.com/": () => {
        n++;
        if (n === 1) throw new TypeError("net::ERR_INTERNET_DISCONNECTED");
        if (n === 2) return status(503);
        if (n === 3) return status(429);
        return png("g");
      },
    });
    expect((await request("a@x.org")).status).toBe(404);
    expect((await request("a@x.org")).status).toBe(404);
    expect((await request("a@x.org")).status).toBe(404);
    expect((await request("a@x.org")).body).toBe("png:g");
    expect(existsSync(join(electron.userData, "avatars"))).toBe(true);
  });

  it("does not cache a miss when any source failed transiently", async () => {
    await load();
    serve({
      [GITHUB_DEFAULT]: png("identicon"),
      "https://avatars.githubusercontent.com/u/e?email=": status(502),
    });
    expect((await request("a@x.org", ["github"])).status).toBe(404);
    serve({
      [GITHUB_DEFAULT]: png("identicon"),
      "https://avatars.githubusercontent.com/u/e?email=": png("late"),
    });
    expect((await request("a@x.org", ["github"])).body).toBe("png:late");
  });

  it("gives up on requests that hang", async () => {
    vi.useFakeTimers();
    await load();
    electron.route = () => new Promise<Response>(() => {});
    const pending = request("a@x.org");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(8000);
    expect((await pending).status).toBe(404);
    const signal = fetch.mock.calls[0]![1]!.signal!;
    expect(signal.aborted).toBe(true);
    // Not cached as a miss.
    serve({ "https://www.gravatar.com/": png("g") });
    expect((await request("a@x.org")).body).toBe("png:g");
  });

  it("treats a failing body read as transient", async () => {
    await load();
    let n = 0;
    serve({
      "https://www.gravatar.com/": () => {
        n++;
        if (n > 1) return png("g");
        const res = png("broken");
        vi.spyOn(res, "arrayBuffer").mockRejectedValue(new Error("reset"));
        return res;
      },
    });
    expect((await request("a@x.org")).status).toBe(404);
    expect((await request("a@x.org")).body).toBe("png:g");
  });

  it("shares concurrent lookups", async () => {
    await load();
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    serve({ "https://www.gravatar.com/": async () => (await gate, png("g")) });
    const all = Promise.all([request("a@x.org"), request("a@x.org"), request("a@x.org")]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    release();
    expect((await all).map((r) => r.body)).toEqual(["png:g", "png:g", "png:g"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("still serves the avatar when the cache cannot be written", async () => {
    writeFileSync(join(electron.userData, "avatars"), "not a directory");
    await load();
    serve({ "https://www.gravatar.com/": png("g") });
    expect((await request("a@x.org")).body).toBe("png:g");
    expect(log.warn).toHaveBeenCalledWith("avatar cache write failed", expect.anything());
  });

  it("ignores a corrupt cache entry", async () => {
    await load();
    serve({ "https://www.gravatar.com/": png("g") });
    await request("a@x.org");
    const dir = join(electron.userData, "avatars");
    for (const f of readdirSync(dir)) if (f.endsWith(".json")) writeFileSync(join(dir, f), "{");
    expect((await request("a@x.org")).body).toBe("png:g");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
