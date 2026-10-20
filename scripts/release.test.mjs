import { createHash, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";

const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync }));
vi.mock("./sparkle.mjs", async () => ({
  ...(await vi.importActual("./sparkle.mjs")),
  prepareSparkle: vi.fn(async () => "/sparkle"),
}));
import {
  appcastXml,
  assertSigningKey,
  compareVersions,
  publishRelease,
  releaseFiles,
  releaseVersion,
  validateReleaseFiles,
  validateMacArchives,
  stageRelease,
} from "./release.mjs";
import { sparkleConfig } from "./sparkle.mjs";

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gitdove-release-test-"));
  vi.clearAllMocks();
  execFileSync.mockReset();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});
const version = "0.1.25";
const sha = "a".repeat(40);
const embeddedKey = sparkleConfig.publicKey;
afterEach(() => {
  sparkleConfig.publicKey = embeddedKey;
  vi.unstubAllEnvs();
});

function fixture() {
  const names = [
    ...["arm64", "x64"].flatMap((arch) =>
      ["zip", "dmg"].map((extension) => `GitDove-${version}-mac-${arch}.${extension}`),
    ),
    `GitDove-${version}-win-x64.exe`,
    `GitDove-${version}-linux-x64.AppImage`,
    `GitDove-${version}-linux-x64.deb`,
  ];
  for (const name of names) writeFileSync(join(root, name), name);
  for (const [name, asset] of [
    ["latest.yml", names[4]],
    ["latest-linux.yml", names[5]],
  ]) {
    const data = readFileSync(join(root, asset));
    writeFileSync(
      join(root, name),
      stringify({
        version,
        files: [
          {
            url: asset,
            size: data.length,
            sha512: createHash("sha512").update(data).digest("base64"),
          },
        ],
      }),
    );
  }
  return releaseFiles(root);
}

describe("release identity", () => {
  it("uses one increasing CI build number across platforms and reruns", () => {
    expect(releaseVersion("0.1.0", 25)).toBe(version);
    expect(releaseVersion("2.5.0", "99")).toBe("2.5.99");
    expect(compareVersions("0.1.100", "0.1.99")).toBe(1);
    expect(compareVersions("0.2.1", "0.1.100")).toBe(1);
    expect(compareVersions(version, version)).toBe(0);
    expect(compareVersions("0.1.1", "1.0.0")).toBe(-1);
  });
  it.each([
    ["0.1.0", ""],
    ["0.1.0", "0"],
    ["0.1.0", "1; whoami"],
    ["invalid", 1],
    ["0.1.0", "99999999999999999999"],
  ])("rejects invalid release inputs", (base, build) => {
    expect(() => releaseVersion(base, build)).toThrow();
  });
  it("rejects malformed comparison versions", () =>
    expect(() => compareVersions("nightly", version)).toThrow());
  it("binds release signing to the embedded update key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const seed = privateKey
      .export({ type: "pkcs8", format: "der" })
      .subarray(-32)
      .toString("base64");
    const publicText = publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("base64");
    expect(() => assertSigningKey(seed, publicText)).not.toThrow();
    expect(() => assertSigningKey(seed)).toThrow("does not match");
    expect(() => assertSigningKey("missing")).toThrow("base64-encoded");
  });
});

describe("release validation", () => {
  it("requires all platforms and validates updater checksums", () => {
    const files = fixture();
    expect(() => validateReleaseFiles(files, version)).not.toThrow();
    writeFileSync(files.get(`GitDove-${version}-win-x64.exe`), "tampered");
    expect(() => validateReleaseFiles(files, version)).toThrow("checksum mismatch");
  });
  it("rejects missing packages, mixed versions, and invalid manifests", () => {
    const files = fixture();
    const first = files.keys().next().value;
    const file = files.get(first);
    files.delete(first);
    expect(() => validateReleaseFiles(files, version)).toThrow("Missing release asset");
    files.set(first, file);
    files.set("GitDove-0.1.1-win-x64.exe", file);
    expect(() => validateReleaseFiles(files, version)).toThrow("Unexpected release version");
    files.delete("GitDove-0.1.1-win-x64.exe");
    writeFileSync(files.get("latest.yml"), stringify({ version: "0.1.1", files: [] }));
    expect(() => validateReleaseFiles(files, version)).toThrow("Invalid update manifest");
    writeFileSync(
      files.get("latest.yml"),
      stringify({ version, files: [{ url: "../outside.exe" }] }),
    );
    expect(() => validateReleaseFiles(files, version)).toThrow("missing asset");
  });
  it("rejects duplicate names and ignores unpacked directories and macOS electron-updater feeds", () => {
    fixture();
    mkdirSync(join(root, "second"));
    writeFileSync(join(root, "latest-mac.yml"), "unused");
    expect(releaseFiles(root).has("latest-mac.yml")).toBe(false);
    writeFileSync(join(root, "second/latest.yml"), "duplicate");
    expect(() => releaseFiles(root)).toThrow("Duplicate release asset");
  });
  it("checks macOS app identity, version, embedded feed, and code signature", () => {
    const files = fixture();
    let arch;
    execFileSync.mockImplementation((command, args) => {
      if (command.endsWith("ditto")) arch = args[2].includes("arm64") ? "arm64" : "x64";
      if (command.endsWith("plutil"))
        return JSON.stringify({
          CFBundleIdentifier: "dev.gitdove.app",
          CFBundleShortVersionString: version,
          SUPublicEDKey: sparkleConfig.publicKey,
          SUFeedURL: `${sparkleConfig.feedBaseURL}/appcast-${arch}.xml`,
        });
      return "";
    });
    validateMacArchives(files, version);
    expect(execFileSync).toHaveBeenCalledWith(
      "/usr/bin/codesign",
      expect.arrayContaining(["--verify", "--strict"]),
    );
    execFileSync.mockReturnValue(JSON.stringify({ CFBundleIdentifier: "wrong.app" }));
    expect(() => validateMacArchives(files, version)).toThrow("Invalid packaged macOS update");
  });
});

it("writes a versioned HTTPS appcast and escapes XML attributes", () => {
  const input = {
    version,
    url: "https://example.com/update.zip?a=1&b=2",
    size: 12,
    signature: '"<signed>"',
  };
  const xml = appcastXml(input);
  expect(xml).toContain(`<sparkle:version>${version}</sparkle:version>`);
  expect(xml).toContain("a=1&amp;b=2");
  expect(xml).toContain("&quot;&lt;signed&gt;&quot;");
  expect(() => appcastXml({ ...input, url: "http://example.com" })).toThrow("HTTPS");
  expect(() => appcastXml({ ...input, size: 0 })).toThrow("Invalid appcast");
});

it("stages a complete release and signs both macOS archives and feeds", async () => {
  fixture();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64");
  sparkleConfig.publicKey = publicKey
    .export({ type: "spki", format: "der" })
    .subarray(-32)
    .toString("base64");
  let arch;
  execFileSync.mockImplementation((command, args) => {
    if (command.endsWith("ditto")) arch = args[2].includes("arm64") ? "arm64" : "x64";
    if (command.endsWith("plutil"))
      return JSON.stringify({
        CFBundleIdentifier: "dev.gitdove.app",
        CFBundleShortVersionString: version,
        SUPublicEDKey: sparkleConfig.publicKey,
        SUFeedURL: `${sparkleConfig.feedBaseURL}/appcast-${arch}.xml`,
      });
    return "signature";
  });
  vi.stubEnv("GITDOVE_RELEASE_SHA", sha);
  const output = join(root, "staged");
  await stageRelease(root, output, version, seed);
  for (const targetArch of ["arm64", "x64"]) {
    expect(readFileSync(join(output, `appcast-${targetArch}.xml`), "utf8")).toContain(
      `GitDove-${version}-mac-${targetArch}.zip`,
    );
  }
  const signatures = execFileSync.mock.calls.filter(([command]) => command.endsWith("sign_update"));
  expect(signatures).toHaveLength(4);
  expect(
    signatures.every(
      ([, args, options]) => args.includes("--ed-key-file") && options.input === seed,
    ),
  ).toBe(true);
  expect(readFileSync(join(output, "notes.md"), "utf8")).toContain(sha);
});

describe("atomic publication", () => {
  const response = (value, status = 200) => ({
    status,
    ok: status === 200,
    json: async () => value,
  });
  it("uploads every asset to a draft before publishing", async () => {
    writeFileSync(join(root, "notes.md"), "release notes");
    writeFileSync(join(root, "appcast-arm64.xml"), "signed feed");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(null, 404)));
    await publishRelease(root, version, sha);
    const calls = execFileSync.mock.calls.map(([, args]) => args);
    expect(calls[0]).toEqual(
      expect.arrayContaining(["create", `v${version}`, "--target", sha, "--draft"]),
    );
    expect(calls[1]).toEqual(expect.arrayContaining(["upload", join(root, "appcast-arm64.xml")]));
    expect(calls[2]).toEqual(expect.arrayContaining(["edit", "--draft=false", "--latest"]));
  });
  it("does not publish when an upload fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(null, 404)));
    execFileSync.mockImplementation((_command, args) => {
      if (args[1] === "upload") throw new Error("upload failed");
      return "";
    });
    await expect(publishRelease(root, version, sha)).rejects.toThrow("upload failed");
    expect(execFileSync.mock.calls.some(([, args]) => args.includes("--draft=false"))).toBe(false);
  });
  it("does not move latest backwards", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ tag_name: "v0.1.26" })));
    await publishRelease(root, version, sha);
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it("resumes drafts, and treats published reruns as complete", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(null, 404))
      .mockResolvedValueOnce(response({ draft: true }))
      .mockResolvedValueOnce(response({ sha }));
    vi.stubGlobal("fetch", fetch);
    await publishRelease(root, version, sha);
    expect(execFileSync.mock.calls[0][1]).toContain("upload");
    execFileSync.mockClear();
    fetch
      .mockResolvedValueOnce(response(null, 404))
      .mockResolvedValueOnce(response({ draft: false }))
      .mockResolvedValueOnce(response({ sha }));
    await publishRelease(root, version, sha);
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it("rejects different commits and API failures", async () => {
    await expect(publishRelease(root, version, "invalid")).rejects.toThrow(
      "Invalid release commit",
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, 403)));
    await expect(publishRelease(root, version, sha)).rejects.toThrow("HTTP 403");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response(null, 404))
        .mockResolvedValueOnce(response({ draft: false }))
        .mockResolvedValueOnce(response({ sha: "b".repeat(40) })),
    );
    await expect(publishRelease(root, version, sha)).rejects.toThrow("different commit");
  });
});
