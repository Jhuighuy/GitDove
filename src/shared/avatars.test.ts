import { describe, expect, it } from "vitest";
import {
  avatarUrl,
  githubNoreply,
  parseAvatarUrl,
  providersForRemotes,
  remoteHost,
} from "./avatars";

describe("avatars", () => {
  it("extracts hosts from remote URLs", () => {
    expect(remoteHost("https://github.com/Jhuighuy/GitDove.git")).toBe("github.com");
    expect(remoteHost("git@github.com:Jhuighuy/GitDove.git")).toBe("github.com");
    expect(remoteHost("ssh://git@gitlab.example.org:2222/a/b.git")).toBe("gitlab.example.org");
    expect(remoteHost("/srv/git/repo.git")).toBeNull();
  });

  it("derives providers", () => {
    expect(
      providersForRemotes([
        "git@github.com:a/b.git",
        "https://gitlab.com/x/y",
        "git@gitlab.kitware.com:vtk/vtk.git",
        "https://code.example.com/z",
        "git@bitbucket.org:a/b.git",
        "fedora:/srv/repo.git",
      ]),
    ).toEqual([
      "github",
      "gitlab:gitlab.com",
      "gitlab:gitlab.kitware.com",
      "gitlab:code.example.com",
    ]);
  });

  it("round-trips avatar URLs and rejects junk", () => {
    const url = avatarUrl(" Jane@Example.com ", ["github", "gitlab:gitlab.com"], 64);
    expect(parseAvatarUrl(url)).toEqual({
      email: "jane@example.com",
      providers: ["github", "gitlab:gitlab.com"],
      size: 64,
    });
    expect(parseAvatarUrl("gitdove-avatar://avatar/?e=nope&s=64")).toBeNull();
    expect(
      parseAvatarUrl("gitdove-avatar://avatar/?e=a@b&p=gitlab:evil/path&s=64")?.providers,
    ).toEqual([]);
  });

  it("recognizes GitHub noreply emails", () => {
    expect(githubNoreply("38412262+rohanjain101@users.noreply.github.com")).toEqual({
      id: "38412262",
      login: "rohanjain101",
    });
    expect(githubNoreply("SunBlack@users.noreply.github.com")).toEqual({
      id: null,
      login: "SunBlack",
    });
    expect(githubNoreply("a@gmail.com")).toBeNull();
  });
});
