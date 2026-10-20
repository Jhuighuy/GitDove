// Release tooling for CI (.github/workflows/ci.yml):
//
//   node scripts/release.mjs version
//     Prints the release version: package.json's major.minor plus the CI run number.
//   node scripts/release.mjs appcast <dir> <download URL prefix>
//     Signs the macOS ZIP in <dir> with SPARKLE_PRIVATE_KEY and writes appcast.xml next to it.
import { execFileSync } from "node:child_process";
import { createPublicKey, verify } from "node:crypto";
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
  const plist = execFileSync("unzip", ["-p", zip, "GitDove.app/Contents/Info.plist"]);
  return JSON.parse(
    execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], {
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
    const [zip, ...others] = readdirSync(dir)
      .filter((name) => name.endsWith("-mac-arm64.zip"))
      .map((name) => join(dir, name));
    if (!zip || others.length) throw new Error(`Expected one macOS ZIP in ${dir}`);
    const output = join(dir, "appcast.xml");
    await writeAppcast({
      zip,
      url: `${prefix}/${basename(zip)}`,
      seed,
      output,
      settings: updateSettings(),
    });
    console.log(`Wrote ${output} for ${basename(zip)}`);
  } else {
    throw new Error("usage: release.mjs version | appcast <dir> <download URL prefix>");
  }
}

if (import.meta.main) await main(process.argv.slice(2));
