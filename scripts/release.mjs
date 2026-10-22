// Release tooling for CI (.github/workflows/ci.yml):
//
//   node scripts/release.mjs version
//     Prints the release version: package.json's major.minor plus the CI run number.
//   node scripts/release.mjs appcast <dir> <download URL prefix>
//     Signs the macOS ZIP in <dir> with SPARKLE_PRIVATE_KEY and writes appcast.xml next to it.
//   node scripts/release.mjs check <dir>
//     Fails unless every file in <dir> keeps its name as a GitHub release asset and every file
//     that the electron-updater manifests (latest*.yml) point to is there with the listed sha512.
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fetchSparkle, root, updateSettings } from "./sparkle.mjs";

export function releaseVersion(packageVersion, runNumber) {
  const [, major, minor] = /^(\d+)\.(\d+)\.\d+$/.exec(packageVersion) ?? [];
  if (!major || !/^[1-9]\d*$/.test(runNumber)) throw new Error("Invalid version or run number");
  return `${major}.${minor}.${runNumber}`;
}

const escapeXml = (text) =>
  String(text).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

/** A Sparkle feed offering one update. */
export function appcastXml({
  version,
  shortVersion,
  minimumSystemVersion,
  url,
  length,
  signature,
}) {
  const x = (value) => escapeXml(value);
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>GitDove</title>
    <item>
      <title>GitDove ${x(shortVersion)}</title>
      <sparkle:version>${x(version)}</sparkle:version>
      <sparkle:shortVersionString>${x(shortVersion)}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>${x(minimumSystemVersion)}</sparkle:minimumSystemVersion>
      <enclosure url="${x(url)}" length="${length}" type="application/octet-stream" sparkle:edSignature="${x(signature)}"/>
    </item>
  </channel>
</rss>
`;
}

/** Info.plist of the GitDove.app inside a ZIP built by electron-builder. */
export function archivedInfo(zip) {
  const plist = execFileSync("/usr/bin/unzip", ["-p", zip, "GitDove.app/Contents/Info.plist"]);
  return JSON.parse(
    execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
      input: plist,
      encoding: "utf8",
    }),
  );
}

/**
 * Signs `zip` and writes a signed feed for it to `output`. Refuses archives whose embedded update
 * settings differ from `settings`, and keys that don't match `settings.SUPublicEDKey`: either
 * would leave users with an app that can never update again.
 */
export async function writeAppcast({ zip, url, seed, output, settings }) {
  const info = archivedInfo(zip);
  for (const [key, value] of Object.entries(settings)) {
    if (info[key] !== value)
      throw new Error(`${basename(zip)}: ${key} is ${info[key]}, not ${value}`);
  }
  const signUpdate = join(await fetchSparkle(), "bin/sign_update");
  const sign = (args) => execFileSync(signUpdate, ["--ed-key-file", "-", ...args], { input: seed });
  const signature = sign(["-p", zip]).toString().trim();
  const publicKey = createPublicKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: Buffer.from(settings.SUPublicEDKey, "base64").toString("base64url"),
    },
    format: "jwk",
  });
  if (!verify(null, readFileSync(zip), publicKey, Buffer.from(signature, "base64")))
    throw new Error("The signing key does not match the public key embedded in GitDove");
  writeFileSync(
    output,
    appcastXml({
      version: info.CFBundleVersion,
      shortVersion: info.CFBundleShortVersionString,
      minimumSystemVersion: info.LSMinimumSystemVersion,
      url,
      length: statSync(zip).size,
      signature,
    }),
  );
  sign([output]);
}

/**
 * GitHub renames uploaded assets whose names contain other characters (a space becomes a dot),
 * which breaks every download URL computed from the local file name.
 */
const githubSafeName = /^[\w.-]+$/;

/** Files an electron-updater manifest points to, with their base64 SHA-512 when listed. */
export function manifestFiles(yaml) {
  const files = new Map();
  let url;
  for (const line of yaml.split(/\r?\n/)) {
    const entry = /^\s*(?:-\s+)?(url|path|sha512):(.*)$/.exec(line);
    if (!entry) continue;
    const key = entry[1];
    const value = entry[2].trim().replace(/^["']|["']$/g, "");
    if (key !== "sha512") {
      url = value;
      if (!files.has(url)) files.set(url, undefined);
    } else if (url !== undefined && files.get(url) === undefined) {
      files.set(url, value);
    }
  }
  return files;
}

const sha512Of = (file) => createHash("sha512").update(readFileSync(file)).digest("base64");

/** Reasons a release made of the files in `dir` would break downloads; empty if none. */
export function releaseProblems(dir) {
  const names = readdirSync(dir);
  const problems = names
    .filter((name) => !githubSafeName.test(name))
    .map((name) => `${name}: GitHub would rename this asset`);
  for (const manifest of names.filter((name) => /^latest.*\.yml$/.test(name))) {
    const files = manifestFiles(readFileSync(join(dir, manifest), "utf8"));
    if (files.size === 0) problems.push(`${manifest}: lists no files`);
    for (const [url, sha512] of files) {
      if (!names.includes(url)) {
        problems.push(`${manifest}: ${url} is not in the release`);
      } else if (sha512 !== undefined && sha512 !== sha512Of(join(dir, url))) {
        problems.push(`${manifest}: ${url} does not match its sha512`);
      }
    }
  }
  return problems;
}

async function main([command, ...args]) {
  if (command === "version") {
    const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const release = releaseVersion(version, process.env.GITHUB_RUN_NUMBER ?? "");
    console.log(release);
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `version=${release}\n`);
  } else if (command === "appcast" && args.length === 2) {
    const [dir, prefix] = args;
    const seed = process.env.SPARKLE_PRIVATE_KEY;
    if (!seed) throw new Error("SPARKLE_PRIVATE_KEY is not set");
    const entries = readdirSync(dir);
    const [zip, ...others] = entries
      .filter((name) => name.endsWith("-mac-arm64.zip"))
      .map((name) => join(dir, name));
    if (!zip || others.length) {
      throw new Error(
        `Expected one *-mac-arm64.zip in ${dir}, found: ${entries.join(", ") || "nothing"}`,
      );
    }
    const output = join(dir, "appcast.xml");
    await writeAppcast({
      zip,
      url: `${prefix}/${basename(zip)}`,
      seed,
      output,
      settings: updateSettings(),
    });
    console.log(`Wrote ${output} for ${basename(zip)}`);
  } else if (command === "check" && args.length === 1) {
    const problems = releaseProblems(args[0]);
    if (problems.length)
      throw new Error(`The release would break updates:\n${problems.join("\n")}`);
    console.log(`${args[0]}: every asset name and update manifest checks out`);
  } else {
    throw new Error(
      "usage: release.mjs version | appcast <dir> <download URL prefix> | check <dir>",
    );
  }
}

if (import.meta.main) await main(process.argv.slice(2));
