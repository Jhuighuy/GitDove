import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appcastXml, manifestFiles, releaseProblems, releaseVersion } from "./release.mjs";

describe("releaseVersion", () => {
  it("uses the CI run number as the patch version", () => {
    expect(releaseVersion("0.1.0", "42")).toBe("0.1.42");
    expect(releaseVersion("2.3.9", "7")).toBe("2.3.7");
  });

  it("rejects bad input", () => {
    expect(() => releaseVersion("0.1", "42")).toThrow();
    expect(() => releaseVersion("0.1.0", "")).toThrow();
    expect(() => releaseVersion("0.1.0", "04")).toThrow();
    expect(() => releaseVersion("0.1.0", "1; rm")).toThrow();
  });
});

describe("appcastXml", () => {
  const item = {
    version: "0.1.42",
    shortVersion: "0.1.42",
    minimumSystemVersion: "13.0",
    url: "https://github.com/Jhuighuy/GitDove/releases/download/v0.1.42/GitDove-0.1.42-mac-arm64.zip",
    length: 1234,
    signature: "c2lnbmF0dXJl",
  };

  it("offers the update", () => {
    const xml = appcastXml(item);
    expect(xml).toContain("<sparkle:version>0.1.42</sparkle:version>");
    expect(xml).toContain("<sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>");
    expect(xml).toContain(`url="${item.url}" length="1234"`);
    expect(xml).toContain('sparkle:edSignature="c2lnbmF0dXJl"');
  });

  it("escapes values", () => {
    const xml = appcastXml({ ...item, url: 'https://example.com/a?b=1&c="2"' });
    expect(xml).toContain('url="https://example.com/a?b=1&amp;c=&quot;2&quot;"');
  });
});

const sha512 = (data) => createHash("sha512").update(data).digest("base64");

// As electron-builder writes it (latest.yml for NSIS).
const latestYml = (url, hash) => `version: 0.1.42
files:
  - url: ${url}
    sha512: ${hash}
    size: 9
path: ${url}
sha512: ${hash}
releaseDate: '2026-10-22T10:00:00.000Z'
`;

describe("manifestFiles", () => {
  it("lists each file once with its checksum", () => {
    const yml = `version: 1.0.0
files:
  - url: GitDove-1.0.0.AppImage
    sha512: aaa==
    size: 1
    blockMapSize: 2
  - url: "GitDove-1.0.0-arm64.AppImage"
    sha512: bbb==
path: GitDove-1.0.0.AppImage
sha512: aaa==
`;
    expect(manifestFiles(yml)).toEqual(
      new Map([
        ["GitDove-1.0.0.AppImage", "aaa=="],
        ["GitDove-1.0.0-arm64.AppImage", "bbb=="],
      ]),
    );
  });
});

describe("releaseProblems", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gitdove-release-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("accepts a release whose manifests match its files", () => {
    writeFileSync(join(dir, "GitDove-Setup-0.1.42.exe"), "installer");
    writeFileSync(join(dir, "GitDove-Setup-0.1.42.exe.blockmap"), "map");
    writeFileSync(
      join(dir, "latest.yml"),
      latestYml("GitDove-Setup-0.1.42.exe", sha512("installer")),
    );
    expect(releaseProblems(dir)).toEqual([]);
  });

  // The 0.1.144 regression: the manifest named the safe file name, the asset had spaces.
  it("rejects names GitHub would rewrite and manifests pointing at missing files", () => {
    writeFileSync(join(dir, "GitDove Setup 0.1.42.exe"), "installer");
    writeFileSync(
      join(dir, "latest.yml"),
      latestYml("GitDove-Setup-0.1.42.exe", sha512("installer")),
    );
    expect(releaseProblems(dir)).toEqual([
      "GitDove Setup 0.1.42.exe: GitHub would rename this asset",
      "latest.yml: GitDove-Setup-0.1.42.exe is not in the release",
    ]);
  });

  it("rejects a file that does not match its checksum", () => {
    writeFileSync(join(dir, "GitDove-0.1.42.AppImage"), "tampered");
    writeFileSync(
      join(dir, "latest-linux.yml"),
      latestYml("GitDove-0.1.42.AppImage", sha512("original")),
    );
    expect(releaseProblems(dir)).toEqual([
      "latest-linux.yml: GitDove-0.1.42.AppImage does not match its sha512",
    ]);
  });
});
