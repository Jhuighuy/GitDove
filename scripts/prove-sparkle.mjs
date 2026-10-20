import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import {
  adHocSign,
  createSparkleHelper,
  prepareSparkle,
  projectRoot,
  readPlist,
  updateSettings,
  writePlist,
} from "./sparkle.mjs";

if (process.platform !== "darwin") throw new Error("The Sparkle integration proof requires macOS");
const root = mkdtempSync(join(tmpdir(), "gitdove-update-proof-"));
const marker = join(root, "launches.txt");
writeFileSync(marker, "");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64");
const publicKeyText = publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("base64");
const identity = `dev.gitdove.proof.${randomUUID()}`;
let damaged = true;
let archive;
let feed;
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  let body;
  if (path === "/appcast.xml") body = feed;
  else if (path === "/update.zip") {
    body = Buffer.from(archive);
    if (damaged) body[body.length - 1] ^= 1;
  } else {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, { "content-length": body.length, "cache-control": "no-store" });
  response.end(body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const feedURL = `http://127.0.0.1:${server.address().port}/appcast.xml`;
let activeBridge;
const events = [];

function launchBridge(app, onEvent) {
  const child = spawn(
    join(app, "Contents/Resources/sparkle/GitDoveUpdater.app/Contents/MacOS/GitDoveUpdater"),
    [app],
  );
  activeBridge = child;
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Sparkle timed out: ${stderr}`));
    }, 90000);
    createInterface({ input: child.stdout }).on("line", (line) => {
      const event = JSON.parse(line);
      events.push({ test: damaged ? "tampered" : "valid", ...event });
      if (event.kind !== "downloading" || event.percent === 0 || event.percent === 100)
        console.log("Sparkle:", JSON.stringify(event));
      try {
        onEvent(event, child);
      } catch (error) {
        child.kill();
        reject(error);
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

try {
  const sparkle = await prepareSparkle();
  const host = join(root, "Proof");
  execFileSync("xcrun", [
    "clang",
    "-fobjc-arc",
    "-framework",
    "AppKit",
    join(projectRoot, "native/macos/proof-host.m"),
    "-o",
    host,
  ]);
  const createBundle = (directory, version) => {
    const app = join(directory, "GitDove Proof.app");
    mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
    copyFileSync(host, join(app, "Contents/MacOS/Proof"));
    writePlist(join(app, "Contents/Info.plist"), {
      CFBundleIdentifier: identity,
      CFBundleName: "GitDove Proof",
      CFBundleExecutable: "Proof",
      CFBundlePackageType: "APPL",
      CFBundleVersion: version,
      CFBundleShortVersionString: version,
      LSMinimumSystemVersion: "13.0",
      ProofMarker: marker,
      ...updateSettings(process.arch, { publicKey: publicKeyText, feedURL }),
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
    });
    const helper = join(app, "Contents/Resources/sparkle/GitDoveUpdater.app");
    createSparkleHelper(helper, sparkle);
    const helperPlist = join(helper, "Contents/Info.plist");
    writePlist(helperPlist, {
      ...readPlist(helperPlist),
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
    });
    adHocSign(app);
    return app;
  };
  const installed = createBundle(join(root, "installed"), "1.0.1");
  const next = createBundle(join(root, "release"), "1.0.2");
  const archivePath = join(root, "update.zip");
  execFileSync("/usr/bin/ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    next,
    archivePath,
  ]);
  archive = readFileSync(archivePath);
  const signature = sign(null, archive, privateKey).toString("base64");
  const appcast = `<?xml version="1.0" encoding="utf-8"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>GitDove Proof</title><item><title>GitDove 1.0.2</title><sparkle:version>1.0.2</sparkle:version><sparkle:shortVersionString>1.0.2</sparkle:shortVersionString><enclosure url="${feedURL.replace("appcast.xml", "update.zip")}" length="${archive.length}" type="application/octet-stream" sparkle:edSignature="${signature}" /></item></channel></rss>`;
  const feedPath = join(root, "appcast.xml");
  writeFileSync(feedPath, appcast);
  execFileSync(join(sparkle, "bin/sign_update"), ["--ed-key-file", "-", "-p", feedPath], {
    input: seed,
  });
  feed = readFileSync(feedPath);
  spawn("/usr/bin/open", ["-n", "-W", installed], { stdio: "ignore" }).unref();
  for (let tries = 0; !readFileSync(marker, "utf8") && tries < 100; tries++) await delay(100);
  assert.match(readFileSync(marker, "utf8"), /^1\.0\.1 /);

  const rejected = await launchBridge(installed, (event) => {
    assert.notEqual(event.kind, "ready", "A tampered archive must never become installable");
  });
  assert.notEqual(rejected.code, 0, "Tampered update must fail");
  assert.ok(events.some((event) => event.test === "tampered" && event.kind === "error"));
  assert.equal(readPlist(join(installed, "Contents/Info.plist")).CFBundleVersion, "1.0.1");
  console.log("PASS: tampered update rejected; A is unchanged");
  // Let Sparkle's out-of-process installer finish tearing down the rejected session.
  await delay(2000);

  damaged = false;
  const installedResult = await launchBridge(installed, (event, child) => {
    if (event.kind === "ready") {
      assert.equal(readPlist(join(installed, "Contents/Info.plist")).CFBundleVersion, "1.0.1");
      child.stdin.write("install\n");
    }
    assert.notEqual(event.kind, "error", `Valid update failed: ${JSON.stringify(event)}`);
  });
  assert.equal(installedResult.code, 0, installedResult.stderr);
  for (let tries = 0; !readFileSync(marker, "utf8").includes("1.0.2 ") && tries < 100; tries++)
    await delay(100);
  assert.equal(readPlist(join(installed, "Contents/Info.plist")).CFBundleVersion, "1.0.2");
  assert.match(readFileSync(marker, "utf8"), /1\.0\.2 /);
  const codeSignature = spawnSync("/usr/bin/codesign", ["-dv", installed], {
    encoding: "utf8",
  }).stderr;
  assert.match(codeSignature, /Signature=adhoc/);
  assert.ok(
    events.some(
      (event) => event.test === "valid" && event.kind === "installed" && event.relaunched,
    ),
  );
  const evidence = {
    result: "passed",
    platform: process.platform,
    arch: process.arch,
    sparkle: "2.10.0",
    appleCertificate: false,
    versions: readFileSync(marker, "utf8").trim().split("\n"),
    tamperedArchiveRejected: true,
    events,
    codeSignature,
  };
  const output = join(projectRoot, "out/update-proof");
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, `result-${process.arch}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(
    "PASS: verified A 1.0.1 → B 1.0.2 replacement and relaunch without an Apple certificate",
  );
} finally {
  activeBridge?.kill();
  if (existsSync(marker)) {
    for (const line of readFileSync(marker, "utf8").trim().split("\n")) {
      const pid = Number(line.split(" ")[1]);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") console.warn("Could not stop proof app:", error.message);
      }
    }
  }
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
