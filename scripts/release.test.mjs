import { describe, expect, it } from "vitest";
import { appcastXml, releaseVersion } from "./release.mjs";

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
