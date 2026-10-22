import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import beforePack from "./before-pack.mjs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const versionPlist = (version) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>com.apple.actool.version</key><dict>
  <key>bundle-version</key><string>26200</string>
  <key>short-bundle-version</key><string>${version}</string>
</dict></dict></plist>`;

const context = (platform = "darwin", icon = "build/Fold.icon") => ({
  electronPlatformName: platform,
  packager: { platformSpecificBuildOptions: { icon, minimumSystemVersion: "26.0" } },
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe("macOS icon selection", () => {
  it.each(["26.0", "26.2.1", "27.0"])("keeps the layered icon with actool %s", (version) => {
    vi.mocked(execFileSync).mockReturnValue(versionPlist(version));
    const build = context();
    beforePack(build);
    expect(build.packager.platformSpecificBuildOptions.icon).toBe("build/Fold.icon");
  });

  it.each(["16.4", "25.9", "unknown"])("uses the static icon with actool %s", (version) => {
    vi.mocked(execFileSync).mockReturnValue(versionPlist(version));
    const build = context();
    beforePack(build);
    expect(build.packager.platformSpecificBuildOptions).toEqual({
      icon: "build/icon.icns",
      minimumSystemVersion: "26.0",
    });
  });

  it.each(["ENOENT", "ETIMEDOUT", "Xcode license not accepted"])(
    "still packages when the compiler fails: %s",
    (message) => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error(message);
      });
      const build = context();
      beforePack(build);
      expect(build.packager.platformSpecificBuildOptions.icon).toBe("build/icon.icns");
    },
  );

  it("falls back if the compiler returns unexpected output", () => {
    vi.mocked(execFileSync).mockReturnValue("Xcode 26.0");
    const build = context();
    beforePack(build);
    expect(build.packager.platformSpecificBuildOptions.icon).toBe("build/icon.icns");
  });

  it.each([
    ["linux", "build/icons"],
    ["win32", "build/icon.ico"],
    ["darwin", "build/icon.icns"],
    ["darwin", "custom.icon"],
  ])("preserves %s's explicit %s without probing Xcode", (platform, icon) => {
    const build = context(platform, icon);
    beforePack(build);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(build.packager.platformSpecificBuildOptions.icon).toBe(icon);
  });
});
