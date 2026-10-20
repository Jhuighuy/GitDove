import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { prepareSparkle, projectRoot, readPlist, sparkleConfig } from "./sparkle.mjs";

export function releaseVersion(base, build) {
  const match = /^(\d+)\.(\d+)\.\d+$/.exec(base);
  if (!match || !/^[1-9]\d*$/.test(String(build)) || !Number.isSafeInteger(Number(build)))
    throw new Error("Invalid release version or CI build number");
  return `${match[1]}.${match[2]}.${build}`;
}

export function compareVersions(left, right) {
  const parseVersion = (version) => {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid version: ${version}`);
    return version.split(".").map(Number);
  };
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export function appcastXml({ version, url, size, signature }) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !Number.isSafeInteger(size) || size <= 0)
    throw new Error("Invalid appcast release");
  if (new URL(url).protocol !== "https:") throw new Error("Release downloads must use HTTPS");
  const escape = (text) =>
    String(text)
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>
<title>GitDove</title><item><title>GitDove ${version}</title>
<sparkle:version>${version}</sparkle:version><sparkle:shortVersionString>${version}</sparkle:shortVersionString>
<sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
<enclosure url="${escape(url)}" length="${size}" type="application/octet-stream" sparkle:edSignature="${escape(signature)}" />
</item></channel></rss>\n`;
}

export function releaseFiles(directory) {
  const files = new Map();
  const visit = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (
        !entry.isFile() ||
        !(
          /\.(AppImage|deb|exe|dmg|zip|blockmap)$/.test(entry.name) ||
          /^(latest|latest-linux)\.yml$/.test(entry.name)
        )
      )
        continue;
      if (files.has(entry.name)) throw new Error(`Duplicate release asset: ${entry.name}`);
      files.set(entry.name, path);
    }
  };
  visit(directory);
  return files;
}

export function validateReleaseFiles(files, version) {
  const required = [
    ...["arm64", "x64"].flatMap((arch) =>
      ["zip", "dmg"].map((extension) => `GitDove-${version}-mac-${arch}.${extension}`),
    ),
    `GitDove-${version}-win-x64.exe`,
    `GitDove-${version}-linux-x86_64.AppImage`,
    `GitDove-${version}-linux-amd64.deb`,
    "latest.yml",
    "latest-linux.yml",
  ];
  for (const name of required) {
    if (!files.has(name)) throw new Error(`Missing release asset: ${name}`);
  }
  for (const [name, file] of files) {
    if (name.startsWith("GitDove-") && !name.startsWith(`GitDove-${version}-`))
      throw new Error(`Unexpected release version: ${name}`);
    if (!name.endsWith(".yml")) continue;
    validateUpdateManifest(name, file, files, version);
  }
}

function validateUpdateManifest(name, file, files, version) {
  const manifest = parse(readFileSync(file, "utf8"));
  if (manifest.version !== version || !Array.isArray(manifest.files) || !manifest.files.length)
    throw new Error(`Invalid update manifest: ${name}`);
  for (const entry of manifest.files) {
    const asset = decodeURIComponent(entry.url);
    if (asset !== basename(asset) || !files.has(asset))
      throw new Error(`Update manifest references missing asset: ${asset}`);
    const data = readFileSync(files.get(asset));
    if (
      entry.size !== data.length ||
      entry.sha512 !== createHash("sha512").update(data).digest("base64")
    )
      throw new Error(`Update checksum mismatch: ${asset}`);
  }
}

export function assertSigningKey(seed, expectedPublicKey = sparkleConfig.publicKey) {
  const data = Buffer.from(seed, "base64");
  if (data.length !== 32)
    throw new Error("SPARKLE_PRIVATE_KEY must be a base64-encoded Ed25519 seed");
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), data]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(key)
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64");
  if (publicKey !== expectedPublicKey)
    throw new Error("SPARKLE_PRIVATE_KEY does not match the app's embedded public key");
}

export function validateMacArchives(files, version) {
  for (const arch of ["arm64", "x64"]) {
    const name = `GitDove-${version}-mac-${arch}.zip`;
    const file = files.get(name);
    const temporary = mkdtempSync(join(tmpdir(), "gitdove-release-"));
    try {
      execFileSync("/usr/bin/ditto", ["-x", "-k", file, temporary]);
      const app = join(temporary, "GitDove.app");
      const info = readPlist(join(app, "Contents/Info.plist"));
      if (
        info.CFBundleIdentifier !== "dev.gitdove.app" ||
        info.CFBundleShortVersionString !== version ||
        info.SUPublicEDKey !== sparkleConfig.publicKey ||
        info.SUFeedURL !== `${sparkleConfig.feedBaseURL}/appcast-${arch}.xml`
      )
        throw new Error(`Invalid packaged macOS update: ${name}`);
      execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}

export async function stageRelease(input, output, version, seed) {
  assertSigningKey(seed);
  const files = releaseFiles(input);
  validateReleaseFiles(files, version);
  validateMacArchives(files, version);
  const sparkle = await prepareSparkle();
  mkdirSync(output, { recursive: true });
  for (const [name, file] of files) copyFileSync(file, join(output, name));
  for (const arch of ["arm64", "x64"]) {
    const name = `GitDove-${version}-mac-${arch}.zip`;
    const file = join(output, name);
    const signature = execFileSync(
      join(sparkle, "bin/sign_update"),
      ["--ed-key-file", "-", "-p", file],
      { input: seed, encoding: "utf8" },
    ).trim();
    const appcast = join(output, `appcast-${arch}.xml`);
    writeFileSync(
      appcast,
      appcastXml({
        version,
        url: `https://github.com/Jhuighuy/GitDove/releases/download/v${version}/${name}`,
        size: readFileSync(file).length,
        signature,
      }),
    );
    execFileSync(join(sparkle, "bin/sign_update"), ["--ed-key-file", "-", "-p", appcast], {
      input: seed,
    });
  }
  writeFileSync(
    join(output, "notes.md"),
    `GitDove ${version}\n\nBuilt from ${process.env.GITDOVE_RELEASE_SHA}.\n\nmacOS builds use ad-hoc code signing and Sparkle Ed25519 update signatures. They are not Apple-notarized.\n`,
  );
}

async function findRelease(api, tag) {
  const matches = [];
  for (let page = 1; ; page++) {
    const releases = (await api(`releases?per_page=100&page=${page}`)) ?? [];
    matches.push(...releases.filter((release) => release.tag_name === tag));
    if (releases.length < 100) break;
  }
  if (matches.length > 1) throw new Error(`Multiple releases exist for ${tag}`);
  return matches[0] ?? null;
}

export async function publishRelease(directory, version, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid release commit");
  const repository = "Jhuighuy/GitDove";
  // Release publication runs on macOS with the runner's Homebrew GitHub CLI.
  const githubCLI = process.arch === "arm64" ? "/opt/homebrew/bin/gh" : "/usr/local/bin/gh";
  const api = async (path) => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
      headers: {
        authorization: `Bearer ${process.env.GH_TOKEN}`,
        accept: "application/vnd.github+json",
      },
    });
    if (response.status === 404) return null;
    if (response.status === 422 && path.startsWith("commits/")) {
      const error = await response.json().catch(() => ({}));
      if (String(error.message ?? "").startsWith("No commit found for SHA: ")) return null;
    }
    if (!response.ok) throw new Error(`GitHub API failed: HTTP ${response.status}`);
    return response.json();
  };
  const latest = await api("releases/latest");
  if (latest && compareVersions(latest.tag_name.replace(/^v/, ""), version) > 0) {
    console.log("A newer release is already published; leaving it as latest.");
    return;
  }
  const tag = `v${version}`;
  const existing = await findRelease(api, tag);
  if (existing) {
    const commit = await api(`commits/${tag}`);
    if (commit ? commit.sha !== sha : !existing.draft || existing.target_commitish !== sha)
      throw new Error("Release tag points to a different commit");
    if (!existing.draft) {
      console.log(`${tag} is already published`);
      return;
    }
  } else {
    const commit = await api(`commits/${tag}`);
    if (commit && commit.sha !== sha) throw new Error("Release tag points to a different commit");
    execFileSync(
      githubCLI,
      [
        "release",
        "create",
        tag,
        "--repo",
        repository,
        "--target",
        sha,
        "--draft",
        "--title",
        `GitDove ${version}`,
        "--notes-file",
        join(directory, "notes.md"),
      ],
      { stdio: "inherit" },
    );
  }
  const assets = readdirSync(directory)
    .filter((name) => name !== "notes.md")
    .map((name) => join(directory, name));
  execFileSync(
    githubCLI,
    ["release", "upload", tag, "--repo", repository, "--clobber", ...assets],
    {
      stdio: "inherit",
    },
  );
  execFileSync(
    githubCLI,
    ["release", "edit", tag, "--repo", repository, "--draft=false", "--latest"],
    {
      stdio: "inherit",
    },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const base = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")).version;
  const version = releaseVersion(
    base,
    process.env.GITDOVE_BUILD_NUMBER ?? process.env.GITHUB_RUN_NUMBER,
  );
  const [command, input, output] = process.argv.slice(2);
  if (command === "version") {
    console.log(version);
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
  } else if (command === "validate") {
    const files = releaseFiles(input);
    validateReleaseFiles(files, version);
    validateMacArchives(files, version);
    console.log(`Validated ${files.size} release assets for ${version}`);
  } else if (command === "stage")
    await stageRelease(input, output, version, process.env.SPARKLE_PRIVATE_KEY ?? "");
  else if (command === "publish")
    await publishRelease(input, version, process.env.GITDOVE_RELEASE_SHA ?? "");
  else
    throw new Error(
      "Usage: release.mjs version | validate <artifacts> | stage <artifacts> <output> | publish <output>",
    );
}
