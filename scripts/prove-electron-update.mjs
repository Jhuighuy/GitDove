import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createPackageWithOptions, extractAll } from "@electron/asar";
import { chromium } from "playwright-core";
import {
  adHocSign,
  prepareSparkle,
  projectRoot,
  readPlist,
  updateSettings,
  writePlist,
} from "./sparkle.mjs";

if (process.platform !== "darwin") throw new Error("The packaged update proof requires macOS");
const input = resolve(process.argv[2] ?? "release/0.1.0");
const original = input.endsWith(".app")
  ? input
  : readdirSync(input)
      .map((name) => join(input, name, "GitDove.app"))
      .find((path) => existsSync(path));
if (
  !original ||
  readPlist(join(original, "Contents/Info.plist")).CFBundleIdentifier !== "dev.gitdove.app"
)
  throw new Error("Pass a packaged GitDove.app or its release directory");
const root = mkdtempSync(join(tmpdir(), "gitdove-electron-proof-"));
const marker = join(root, "launches.txt");
writeFileSync(marker, "");
const profile = join(root, "profile");
const identity = `dev.gitdove.proof.${randomUUID()}`;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicText = publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("base64");
const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64");
const output = join(projectRoot, "out/update-proof");
mkdirSync(output, { recursive: true });
let archive;
let feed;
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  const body = path === "/appcast.xml" ? feed : path === "/update.zip" ? archive : null;
  if (!body) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, { "content-length": body.length, "cache-control": "no-store" });
  response.end(body);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
let page;
let launchPID;
let diagnostics = "";

async function deadline(promise, timeout, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function createBundle(name, version) {
  const destination = join(root, name, "GitDove.app");
  mkdirSync(join(root, name));
  execFileSync("/usr/bin/ditto", [original, destination]);
  const archivePath = join(destination, "Contents/Resources/app.asar");
  const extracted = join(root, `asar-${name}`);
  extractAll(archivePath, extracted);
  const packageFile = join(extracted, "package.json");
  const metadata = JSON.parse(readFileSync(packageFile, "utf8"));
  metadata.version = version;
  writeFileSync(packageFile, JSON.stringify(metadata));
  const main = join(extracted, metadata.main);
  // Instrument only these disposable copies: attest runtime version after the renderer loads.
  const prelude = `import{app as proofApp}from'electron';import{appendFileSync as proofLog}from'node:fs';proofApp.disableHardwareAcceleration();proofApp.on('browser-window-created',(_event,window)=>window.webContents.once('did-finish-load',()=>proofLog(${JSON.stringify(marker)},proofApp.getVersion()+' '+process.pid+'\\n')));\n`;
  writeFileSync(main, prelude + readFileSync(main, "utf8"));
  rmSync(archivePath);
  rmSync(`${archivePath}.unpacked`, { recursive: true, force: true });
  await createPackageWithOptions(extracted, archivePath, {
    unpackDir: "node_modules/@parcel",
    unpack: "resources/**",
  });
  const info = join(destination, "Contents/Info.plist");
  writePlist(info, {
    ...readPlist(info),
    CFBundleIdentifier: identity,
    CFBundleVersion: version,
    CFBundleShortVersionString: version,
    ...updateSettings(process.arch, { publicKey: publicText, feedURL: `${base}/appcast.xml` }),
    LSEnvironment: { GITDOVE_USER_DATA: profile },
    NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
  });
  const helperInfo = join(
    destination,
    "Contents/Resources/sparkle/GitDoveUpdater.app/Contents/Info.plist",
  );
  writePlist(helperInfo, {
    ...readPlist(helperInfo),
    NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
  });
  adHocSign(destination);
  rmSync(extracted, { recursive: true, force: true });
  return destination;
}

try {
  console.log("Preparing isolated packaged GitDove A/B copies");
  const a = await createBundle("installed", "1.0.1");
  const b = await createBundle("release", "1.0.2");
  const zip = join(root, "update.zip");
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", b, zip]);
  archive = readFileSync(zip);
  const signature = sign(null, archive, privateKey).toString("base64");
  const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>GitDove Proof</title><item><title>GitDove 1.0.2</title><sparkle:version>1.0.2</sparkle:version><sparkle:shortVersionString>1.0.2</sparkle:shortVersionString><enclosure url="${base}/update.zip" length="${archive.length}" type="application/octet-stream" sparkle:edSignature="${signature}" /></item></channel></rss>`;
  const feedPath = join(root, "appcast.xml");
  writeFileSync(feedPath, xml);
  const sparkle = await prepareSparkle();
  execFileSync(join(sparkle, "bin/sign_update"), ["--ed-key-file", "-", "-p", feedPath], {
    input: seed,
  });
  feed = readFileSync(feedPath);
  const child = spawn(join(a, "Contents/MacOS/GitDove"), ["--remote-debugging-port=0"], {
    env: { ...process.env, GITDOVE_USER_DATA: profile },
  });
  launchPID = child.pid;
  const exited = new Promise((done) => child.once("exit", (code) => done(code)));
  child.stdout.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-16000);
  });
  const endpoint = await deadline(
    new Promise((done, reject) => {
      let text = "";
      child.stderr.on("data", (chunk) => {
        diagnostics = (diagnostics + chunk).slice(-16000);
        text += chunk;
        const match = /ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+/.exec(text);
        if (match) done(match[0]);
      });
      child.once("error", reject);
    }),
    30000,
    "Packaged app did not start its renderer debugger",
  );
  // Renderer CDP avoids a Node inspector holding the old process open during quit.
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  page = context.pages()[0] ?? (await context.waitForEvent("page"));
  page.on("pageerror", (error) => {
    diagnostics += `\nRenderer error: ${error.stack}\n`;
  });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(
    async () => {
      const result = await window.gitdove.invoke("updater.status");
      return result.ok && result.value.kind === "ready";
    },
    null,
    { timeout: 90000 },
  );
  assert.match(readFileSync(marker, "utf8"), /^1\.0\.1 /);
  const restart = page.getByRole("button", { name: "Restart", exact: true });
  await restart.waitFor({ state: "visible" });
  await page.screenshot({ path: join(output, `electron-ready-${process.arch}.png`) });
  await restart.evaluate((button) => button.click());
  assert.equal(await deadline(exited, 30000, "A did not complete its shutdown"), 0);
  for (
    let attempt = 0;
    attempt < 300 && !readFileSync(marker, "utf8").includes("1.0.2 ");
    attempt++
  )
    await delay(100);
  const versions = readFileSync(marker, "utf8").trim().split("\n");
  assert.ok(
    versions.some((entry) => entry.startsWith("1.0.2 ")),
    "B did not load its renderer after relaunch",
  );
  assert.equal(readPlist(join(a, "Contents/Info.plist")).CFBundleVersion, "1.0.2");
  writeFileSync(
    join(output, `electron-result-${process.arch}.json`),
    `${JSON.stringify({ result: "passed", appleCertificate: false, versions, toastRestart: true, rendererLoadedAfterRelaunch: true }, null, 2)}\n`,
  );
  console.log(
    "PASS: packaged GitDove A → Restart toast → B; B renderer loaded, no Apple certificate",
  );
} catch (error) {
  if (page && !page.isClosed()) {
    diagnostics += `\nRenderer state: ${await page
      .evaluate(() => document.body.innerText)
      .catch(() => "unavailable")}\n`;
    await page
      .screenshot({ path: join(output, `electron-failure-${process.arch}.png`), timeout: 5000 })
      .catch(() => {});
  }
  writeFileSync(
    join(output, `electron-error-${process.arch}.log`),
    `${error.stack}\n${diagnostics}`,
  );
  throw error;
} finally {
  const pids = new Set([
    launchPID,
    ...readFileSync(marker, "utf8")
      .trim()
      .split("\n")
      .map((line) => Number(line.split(" ")[1])),
  ]);
  for (const pid of pids) {
    if (Number.isInteger(pid) && pid > 0)
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
  }
  await browser?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await delay(1000);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
