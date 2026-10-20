import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const sparkleConfig = JSON.parse(
  readFileSync(join(projectRoot, "build/sparkle.json"), "utf8"),
);

export async function prepareSparkle() {
  if (process.platform !== "darwin") throw new Error("Sparkle requires macOS");
  const directory = join(projectRoot, "node_modules/.cache/gitdove-sparkle", sparkleConfig.version);
  const archive = join(directory, "Sparkle.tar.xz");
  mkdirSync(directory, { recursive: true });
  if (!existsSync(archive)) {
    const url = `https://github.com/sparkle-project/Sparkle/releases/download/${sparkleConfig.version}/Sparkle-${sparkleConfig.version}.tar.xz`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Sparkle download failed: HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(data).digest("hex") !== sparkleConfig.sha256) {
      throw new Error("Sparkle download checksum mismatch");
    }
    writeFileSync(archive, data);
  }
  if (createHash("sha256").update(readFileSync(archive)).digest("hex") !== sparkleConfig.sha256) {
    rmSync(archive);
    throw new Error("Cached Sparkle download checksum mismatch; retry to download it again");
  }
  if (!existsSync(join(directory, "Sparkle.framework"))) {
    execFileSync("/usr/bin/tar", ["-xf", archive, "-C", directory]);
  }
  return directory;
}

export function writePlist(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
  execFileSync("/usr/bin/plutil", ["-convert", "xml1", file]);
}

export function readPlist(file) {
  return JSON.parse(
    execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }),
  );
}

export function createSparkleHelper(destination, sparkle, arch = process.arch) {
  const executable = join(destination, "Contents/MacOS/GitDoveUpdater");
  mkdirSync(dirname(executable), { recursive: true });
  mkdirSync(join(destination, "Contents/Frameworks"), { recursive: true });
  execFileSync("/usr/bin/ditto", [
    join(sparkle, "Sparkle.framework"),
    join(destination, "Contents/Frameworks/Sparkle.framework"),
  ]);
  execFileSync("/usr/bin/xcrun", [
    "clang",
    "-fobjc-arc",
    "-Werror",
    "-Wno-unused-parameter",
    "-arch",
    arch === "x64" ? "x86_64" : arch,
    "-mmacosx-version-min=13.0",
    "-framework",
    "AppKit",
    "-framework",
    "Sparkle",
    "-F",
    sparkle,
    "-Wl,-rpath,@executable_path/../Frameworks",
    join(projectRoot, "native/macos/updater.m"),
    "-o",
    executable,
  ]);
  writePlist(join(destination, "Contents/Info.plist"), {
    CFBundleIdentifier: "dev.gitdove.updater",
    CFBundleName: "GitDove Updater",
    CFBundleExecutable: "GitDoveUpdater",
    CFBundlePackageType: "APPL",
    CFBundleVersion: "1",
    LSUIElement: true,
    LSMinimumSystemVersion: "13.0",
  });
  mkdirSync(join(destination, "Contents/Resources"), { recursive: true });
  copyFileSync(
    join(sparkle, "LICENSE"),
    join(destination, "Contents/Resources/Sparkle-LICENSE.txt"),
  );
  return executable;
}

export function adHocSign(app) {
  const bundles = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      visit(path);
      if (/\.(app|framework|xpc)$/.test(entry.name)) bundles.push(path);
    }
  };
  visit(app);
  for (const path of [...bundles, app]) {
    execFileSync(
      "/usr/bin/codesign",
      [
        "--force",
        "--sign",
        "-",
        "--timestamp=none",
        "--preserve-metadata=entitlements,flags,runtime",
        path,
      ],
      { stdio: "pipe" },
    );
  }
}

export function updateSettings(arch, { publicKey = sparkleConfig.publicKey, feedURL } = {}) {
  if (!["arm64", "x64"].includes(arch)) throw new Error(`Unsupported macOS architecture: ${arch}`);
  return {
    SUPublicEDKey: publicKey,
    SUFeedURL: feedURL ?? `${sparkleConfig.feedBaseURL}/appcast-${arch}.xml`,
    SUEnableAutomaticChecks: false,
    SUVerifyUpdateBeforeExtraction: true,
    SURequireSignedFeed: true,
  };
}
