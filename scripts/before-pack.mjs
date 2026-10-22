// Choose the macOS icon before electron-builder resolves or compiles its assets.
import { execFileSync } from "node:child_process";

function hasIconCompiler() {
  try {
    // Use the same command as electron-builder, respecting PATH and DEVELOPER_DIR.
    const version = execFileSync("actool", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
    });
    const major = version.match(
      /<key>short-bundle-version<\/key>\s*<string>(\d+)(?:\.\d+)*<\/string>/,
    )?.[1];
    return Number(major) >= 26;
  } catch {
    return false;
  }
}

export default function beforePack({ electronPlatformName, packager }) {
  const options = packager.platformSpecificBuildOptions;
  // Preserve explicit icon overrides and leave other platforms alone.
  if (electronPlatformName !== "darwin" || options.icon !== "build/Fold.icon") return;

  if (hasIconCompiler()) {
    console.log("macOS icon: Fold.icon (Liquid Glass, actool 26+)");
  } else {
    options.icon = "build/icon.icns";
    console.warn("macOS icon: icon.icns (static fallback; Xcode 26+ actool is unavailable)");
  }
}
