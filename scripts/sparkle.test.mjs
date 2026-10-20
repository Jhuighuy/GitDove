import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  files: new Map(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
  readdirSync: vi.fn(),
  copyFileSync: vi.fn(),
  execFileSync: vi.fn(),
}));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return {
    ...actual,
    ...mocks,
    readFileSync: (path, ...args) =>
      path.endsWith("sparkle.json") ? actual.readFileSync(path, ...args) : mocks.files.get(path),
  };
});
vi.mock("node:child_process", () => ({ execFileSync: mocks.execFileSync }));
import {
  adHocSign,
  createSparkleHelper,
  prepareSparkle,
  projectRoot,
  readPlist,
  sparkleConfig,
  updateSettings,
} from "./sparkle.mjs";
import afterPack from "./after-pack.mjs";

const platform = Object.getOwnPropertyDescriptor(process, "platform");
const originalChecksum = sparkleConfig.sha256;
const data = Buffer.from("pinned framework download");
const archive = join(
  projectRoot,
  "node_modules/.cache/gitdove-sparkle",
  sparkleConfig.version,
  "Sparkle.tar.xz",
);
beforeEach(() => {
  for (const value of Object.values(mocks)) if (vi.isMockFunction(value)) value.mockReset();
  mocks.files.clear();
  mocks.writeFileSync.mockImplementation((path, value) => mocks.files.set(path, value));
  mocks.existsSync.mockReturnValue(false);
  sparkleConfig.sha256 = createHash("sha256").update(data).digest("hex");
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => data }));
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  sparkleConfig.sha256 = originalChecksum;
  vi.unstubAllGlobals();
});

describe("pinned Sparkle distribution", () => {
  it("verifies the downloaded checksum before extraction", async () => {
    const directory = await prepareSparkle();
    expect(mocks.files.get(archive)).toEqual(data);
    expect(mocks.execFileSync).toHaveBeenCalledWith("tar", ["-xf", archive, "-C", directory]);
  });
  it("reuses a verified cached framework", async () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.files.set(archive, data);
    await prepareSparkle();
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });
  it("rejects modified downloads and cached archives", async () => {
    sparkleConfig.sha256 = "wrong";
    await expect(prepareSparkle()).rejects.toThrow("download checksum mismatch");
    expect(mocks.execFileSync).not.toHaveBeenCalled();
    mocks.existsSync.mockReturnValue(true);
    mocks.files.set(archive, data);
    await expect(prepareSparkle()).rejects.toThrow("Cached Sparkle");
    expect(mocks.rmSync).toHaveBeenCalledWith(archive);
  });
  it("reports unavailable downloads and unsupported platforms", async () => {
    fetch.mockResolvedValue({ ok: false, status: 503 });
    await expect(prepareSparkle()).rejects.toThrow("HTTP 503");
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    await expect(prepareSparkle()).rejects.toThrow("requires macOS");
  });
});

describe("macOS package integration", () => {
  it.each(["arm64", "x64"])(
    "compiles the bridge for %s and includes its framework license",
    (arch) => {
      const executable = createSparkleHelper("/app/Updater.app", "/cache/Sparkle", arch);
      expect(executable).toBe(join("/app/Updater.app", "Contents/MacOS/GitDoveUpdater"));
      expect(mocks.execFileSync).toHaveBeenCalledWith(
        "xcrun",
        expect.arrayContaining([
          "-arch",
          arch === "x64" ? "x86_64" : "arm64",
          "-mmacosx-version-min=13.0",
        ]),
      );
      expect(mocks.copyFileSync).toHaveBeenCalledWith(
        join("/cache/Sparkle", "LICENSE"),
        join("/app/Updater.app", "Contents/Resources/Sparkle-LICENSE.txt"),
      );
      expect(
        JSON.parse(mocks.files.get(join("/app/Updater.app", "Contents/Info.plist")))
          .CFBundleIdentifier,
      ).toBe("dev.gitdove.updater");
    },
  );
  it("selects a signed feed for the packaged architecture", () => {
    expect(updateSettings("arm64")).toEqual(
      expect.objectContaining({
        SUFeedURL: `${sparkleConfig.feedBaseURL}/appcast-arm64.xml`,
        SURequireSignedFeed: true,
        SUVerifyUpdateBeforeExtraction: true,
      }),
    );
    expect(
      updateSettings("x64", { publicKey: "test", feedURL: "http://localhost/test.xml" }),
    ).toEqual(
      expect.objectContaining({ SUPublicEDKey: "test", SUFeedURL: "http://localhost/test.xml" }),
    );
    expect(() => updateSettings("ia32")).toThrow("Unsupported");
  });
  it("adds Sparkle metadata only to supported macOS bundles", async () => {
    await afterPack({ electronPlatformName: "win32" });
    expect(mocks.execFileSync).not.toHaveBeenCalled();
    await expect(afterPack({ electronPlatformName: "darwin", arch: 0 })).rejects.toThrow(
      "Unsupported",
    );
    mocks.existsSync.mockReturnValue(true);
    mocks.files.set(archive, data);
    mocks.execFileSync.mockImplementation((command) =>
      command.endsWith("plutil") ? JSON.stringify({ CFBundleName: "GitDove" }) : "",
    );
    await afterPack({
      electronPlatformName: "darwin",
      arch: 3,
      appOutDir: "/release/mac-arm64",
      packager: { appInfo: { productFilename: "GitDove" } },
    });
    const plist = JSON.parse(
      mocks.files.get(join("/release/mac-arm64", "GitDove.app/Contents/Info.plist")),
    );
    expect(plist.CFBundleName).toBe("GitDove");
    expect(plist.SUPublicEDKey).toBe(sparkleConfig.publicKey);
    expect(readPlist("/test.plist")).toEqual({ CFBundleName: "GitDove" });
  });
  it("re-signs nested code from the inside out, preserving entitlements", () => {
    const directory = (name) => ({ name, isDirectory: () => true });
    mocks.readdirSync.mockImplementation((path) =>
      path === "/app"
        ? [directory("Sparkle.framework")]
        : path === join("/app", "Sparkle.framework")
          ? [directory("Installer.xpc")]
          : [],
    );
    adHocSign("/app");
    const paths = mocks.execFileSync.mock.calls.map(([, args]) => args.at(-1));
    expect(paths).toEqual([
      join("/app", "Sparkle.framework/Installer.xpc"),
      join("/app", "Sparkle.framework"),
      "/app",
    ]);
    expect(mocks.execFileSync.mock.calls[0][1]).toContain(
      "--preserve-metadata=entitlements,flags,runtime",
    );
    expect(mocks.execFileSync.mock.calls[0][1]).not.toContain("--deep");
  });
});
