import { describe, expect, it } from "vitest";
import { isRepoId, isSshHost } from "./ipc";

describe("isSshHost", () => {
  it("accepts aliases and user@host destinations", () => {
    for (const h of ["fedora", "my-box", "git@example.org", "10.0.0.1", "[::1]"]) {
      expect(isSshHost(h), h).toBe(true);
    }
  });

  it("rejects options, whitespace, slashes and control characters", () => {
    for (const h of ["", "-oProxyCommand=x", "a b", "a/b", "a\nb", "a\0b", "x".repeat(256)]) {
      expect(isSshHost(h), JSON.stringify(h)).toBe(false);
    }
  });
});

describe("isRepoId", () => {
  it("accepts canonical ids", () => {
    for (const id of ["local:/a", "local:C:\\work\\a", "ssh://fedora/srv/a", "ssh://u@h/~/a"]) {
      expect(isRepoId(id), id).toBe(true);
    }
  });

  it("rejects malformed ids", () => {
    for (const id of [
      "",
      "a",
      "local:",
      "local:/a\0b",
      "ssh://fedora",
      "ssh:///srv",
      "ssh://-oProxyCommand=x/srv",
      "ssh://a b/srv",
      "file:///srv",
    ]) {
      expect(isRepoId(id), JSON.stringify(id)).toBe(false);
    }
  });
});
