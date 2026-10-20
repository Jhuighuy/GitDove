// Sparkle (macOS updates) packaging: fetches the pinned Sparkle release, builds the updater helper
// from `native/macos/Updater.swift`, and embeds both into a GitDove.app bundle. See docs/updates.md.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const root = join(import.meta.dirname, "..");
export const config = JSON.parse(readFileSync(join(root, "build/sparkle.json"), "utf8"));

/** Relative to GitDove.app; `src/main/sparkle.ts` launches the helper from here. */
export const helperPath = "Contents/Frameworks/GitDove Updater.app";

/** Downloads and unpacks the pinned Sparkle release; returns its directory. */
export async function fetchSparkle() {
  const dir = join(root, "node_modules/.cache/sparkle", config.version);
  if (existsSync(join(dir, "Sparkle.framework"))) return dir;
  const url = `https://github.com/sparkle-project/Sparkle/releases/download/${config.version}/Sparkle-${config.version}.tar.xz`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Downloading ${url} failed: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(data).digest("hex");
  if (sha256 !== config.sha256) throw new Error(`Sparkle checksum mismatch: ${sha256}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const archive = join(dir, "Sparkle.tar.xz");
  writeFileSync(archive, data);
  execFileSync("tar", ["-xf", archive, "-C", dir]);
  return dir;
}

export function readPlist(file) {
  return JSON.parse(
    execFileSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }),
  );
}

export function writePlist(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
  execFileSync("plutil", ["-convert", "xml1", file]);
}

/** Info.plist settings for GitDove.app; tests override the feed and key. */
export function updateSettings(
  arch,
  { feedURL = config.feedURL.replace("{arch}", arch), publicKey = config.publicKey } = {},
) {
  return {
    SUFeedURL: feedURL,
    SUPublicEDKey: publicKey,
    // Both the feed and the archive must carry our Ed25519 signature.
    SURequireSignedFeed: true,
    SUVerifyUpdateBeforeExtraction: true,
    // Check on startup and every 4 hours; download silently and install on quit.
    SUEnableAutomaticChecks: true,
    SUAutomaticallyUpdate: true,
    SUScheduledCheckInterval: 4 * 60 * 60,
  };
}

/**
 * Embeds Sparkle.framework and the updater helper into `app` (before code signing) and adds the
 * update settings to its Info.plist. `arch` is the app's architecture: "arm64" or "x64".
 */
export async function embedUpdater(app, arch, settings = updateSettings(arch)) {
  const sparkle = await fetchSparkle();
  const frameworks = join(app, "Contents/Frameworks");
  rmSync(join(frameworks, "Sparkle.framework"), { recursive: true, force: true });
  execFileSync("ditto", [
    join(sparkle, "Sparkle.framework"),
    join(frameworks, "Sparkle.framework"),
  ]);

  const info = readPlist(join(app, "Contents/Info.plist"));
  const helper = join(app, helperPath);
  rmSync(helper, { recursive: true, force: true });
  mkdirSync(join(helper, "Contents/MacOS"), { recursive: true });
  execFileSync("xcrun", [
    "swiftc",
    "-O",
    "-parse-as-library",
    "-target",
    `${arch === "x64" ? "x86_64" : arch}-apple-macos${info.LSMinimumSystemVersion}`,
    "-F",
    sparkle,
    "-framework",
    "Sparkle",
    // GitDove Updater.app/Contents/MacOS -> GitDove.app/Contents/Frameworks
    "-Xlinker",
    "-rpath",
    "-Xlinker",
    "@executable_path/../../..",
    join(root, "native/macos/Updater.swift"),
    "-o",
    join(helper, "Contents/MacOS/GitDove Updater"),
  ]);
  writePlist(join(helper, "Contents/Info.plist"), {
    CFBundleIdentifier: `${info.CFBundleIdentifier}.updater`,
    CFBundleName: "GitDove Updater",
    CFBundleExecutable: "GitDove Updater",
    CFBundlePackageType: "APPL",
    CFBundleShortVersionString: info.CFBundleShortVersionString,
    CFBundleVersion: info.CFBundleVersion,
    LSMinimumSystemVersion: info.LSMinimumSystemVersion,
    LSUIElement: true,
  });
  // Sparkle's MIT license asks for its notice to ship with the binaries.
  mkdirSync(join(helper, "Contents/Resources"));
  copyFileSync(join(sparkle, "LICENSE"), join(helper, "Contents/Resources/Sparkle-LICENSE.txt"));
  writePlist(join(app, "Contents/Info.plist"), { ...info, ...settings });
}
