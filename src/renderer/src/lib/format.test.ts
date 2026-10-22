import { expect, it } from "vitest";
import {
  absoluteTime,
  basename,
  dirname,
  formatBytes,
  hueOf,
  initials,
  relativeTime,
  shortHash,
} from "./format";

const now = 1_700_000_000;

it("formats relative times in the largest fitting unit", () => {
  expect(relativeTime(now - 30, now)).toBe("just now");
  expect(relativeTime(now - 5 * 60, now)).toBe("5 minutes ago");
  expect(relativeTime(now - 2 * 3600, now)).toBe("2 hours ago");
  expect(relativeTime(now - 24 * 3600, now)).toBe("yesterday");
  expect(relativeTime(now - 3 * 24 * 3600, now)).toBe("3 days ago");
  expect(relativeTime(now - 14 * 24 * 3600, now)).toBe("2 weeks ago");
  expect(relativeTime(now - 60 * 24 * 3600, now)).toBe("2 months ago");
  expect(relativeTime(now - 2 * 365 * 24 * 3600, now)).toBe("2 years ago");
  expect(relativeTime(now + 3 * 3600, now)).toBe("in 3 hours");
});

it("rounds up to the next unit instead of showing its count in the smaller one", () => {
  const day = 24 * 3600;
  expect(relativeTime(now - 362 * day, now)).toBe("last year");
  expect(relativeTime(now - 6.6 * day, now)).toBe("last week");
  expect(relativeTime(now - 23.6 * 3600, now)).toBe("yesterday");
  expect(relativeTime(now - 59.6 * 60, now)).toBe("1 hour ago");
  expect(relativeTime(now + 362 * day, now)).toBe("next year");
  expect(relativeTime(now - 11.4 * 30 * day, now)).toBe("11 months ago");
});

it("defaults relative times to the current clock", () => {
  expect(relativeTime(Date.now() / 1000)).toBe("just now");
});

it("formats absolute times in English", () => {
  // Midday UTC, so the date is the same in every time zone.
  expect(absoluteTime(Date.UTC(2023, 5, 15, 12) / 1000)).toMatch(/^Jun 1[45], 2023/);
});

it("shortens hashes to seven characters", () => {
  expect(shortHash("0123456789abcdef")).toBe("0123456");
  expect(shortHash("abc")).toBe("abc");
});

it("derives initials from names", () => {
  expect(initials("")).toBe("?");
  expect(initials("   ")).toBe("?");
  expect(initials("alice")).toBe("AL");
  expect(initials("Ada King Lovelace")).toBe("AL");
  expect(initials("  linus   torvalds ")).toBe("LT");
  // Characters outside the BMP are not split in half.
  expect(initials("𝒜da 𝔏ovelace")).toBe("𝒜𝔏");
  expect(initials("😀")).toBe("😀");
});

it("hashes strings to a stable hue", () => {
  expect(hueOf("")).toBe(0);
  expect(hueOf("a@example.com")).toBe(hueOf("a@example.com"));
  expect(hueOf("a@example.com")).not.toBe(hueOf("b@example.com"));
  for (const s of ["x", "some very long string ".repeat(50), "ünïcødé"]) {
    const h = hueOf(s);
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  }
});

it("splits paths", () => {
  expect(basename("a/b/c.ts")).toBe("c.ts");
  expect(basename("c.ts")).toBe("c.ts");
  expect(dirname("a/b/c.ts")).toBe("a/b");
  expect(dirname("c.ts")).toBe("");
});

it("formats byte counts", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(1023)).toBe("1023 B");
  expect(formatBytes(1024)).toBe("1.0 KB");
  expect(formatBytes(4300)).toBe("4.2 KB");
  // Rounding up moves to the next unit.
  expect(formatBytes(10_200)).toBe("10 KB");
  expect(formatBytes(1024 * 1024 - 1)).toBe("1.0 MB");
  expect(formatBytes(200 * 1024)).toBe("200 KB");
  expect(formatBytes(13 * 1024 * 1024)).toBe("13 MB");
  expect(formatBytes(2.5 * 1024 ** 3)).toBe("2.5 GB");
  // GB is the largest unit.
  expect(formatBytes(5000 * 1024 ** 3)).toBe("5000 GB");
});
