// End-to-end test of macOS updates on a packaged GitDove.app, with a local feed and a throwaway key:
//
//   node scripts/test-updates.mjs release/<version>/mac-arm64/GitDove.app
//
// Set CASE to run only the cases whose names contain it.
//
// Makes disposable copies of the app as version 1.0.0 (installed) and 1.0.1 (the update), then
// checks that Sparkle rejects a tampered update, installs a downloaded update when GitDove quits,
// and installs and relaunches GitDove when the Restart toast is clicked. The copies have their own
// bundle identifier and user data, so an installed GitDove is never touched.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { writeAppcast } from "./release.mjs";
import { helperPath, readPlist, updateSettings, writePlist } from "./sparkle.mjs";

const source = resolve(process.argv[2] ?? "");
const id = `dev.gitdove.test.${randomUUID()}`;
// Real path: Sparkle relaunches the app from /private/var rather than the /var symlink.
const work = realpathSync(mkdtempSync(join(tmpdir(), "gitdove-updates-")));
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const seed = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url").toString("base64");
const publicKeyText = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString(
  "base64",
);

// Serves the feed and the update; `tampered` flips a byte of the archive.
let tampered = false;
const files = {};
const server = createServer((request, response) => {
  let body = files[request.url];
  if (!body) {
    response.writeHead(404).end();
    return;
  }
  if (request.url.endsWith(".zip") && tampered) {
    body = Buffer.from(body);
    body[body.length >> 1] ^= 0xff;
  }
  response.writeHead(200, { "content-length": body.length }).end(body);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}`;
const settings = updateSettings({ feedURL: `${base}/appcast.xml`, publicKey: publicKeyText });

const version = (app) => {
  try {
    return readPlist(join(app, "Contents/Info.plist")).CFBundleVersion;
  } catch {
    return null; // Being replaced.
  }
};

/** Copies `source` to `app` as the given version, set up for the local feed and test key. */
function copyApp(app, bundleVersion) {
  mkdirSync(join(app, ".."), { recursive: true });
  execFileSync("/usr/bin/ditto", [source, app]);
  // Sparkle connects to the loopback feed from the helper.
  const local = { NSAppTransportSecurity: { NSAllowsLocalNetworking: true } };
  const helper = join(app, helperPath);
  const helperInfo = join(helper, "Contents/Info.plist");
  writePlist(helperInfo, {
    ...readPlist(helperInfo),
    ...local,
    CFBundleIdentifier: `${id}.updater`,
  });
  const info = join(app, "Contents/Info.plist");
  writePlist(info, {
    ...readPlist(info),
    ...settings,
    ...local,
    CFBundleIdentifier: id,
    CFBundleVersion: bundleVersion,
    CFBundleShortVersionString: bundleVersion,
    // Applies when Sparkle relaunches the app, too.
    LSEnvironment: { GITDOVE_USER_DATA: join(work, "user-data") },
  });
  for (const code of [helper, app])
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", code], { stdio: "ignore" });
}

/** PIDs of GitDove main processes running from `app`. */
function running(app) {
  const exe = join(app, "Contents/MacOS/GitDove");
  return execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" })
    .split("\n")
    .map((line) => /^\s*(\d+) (.*)$/.exec(line))
    .filter((m) => m && (m[2] === exe || m[2].startsWith(`${exe} `)))
    .map((m) => Number(m[1]));
}

async function until(condition, what, timeout = 120_000) {
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(250)) {
    if (await condition()) return; // NOSONAR: polling is sequential by design.
  }
  throw new Error(`Timed out waiting until ${what}`);
}

/** Launches `app` and connects to its renderer. */
async function launch(app) {
  const child = spawn(join(app, "Contents/MacOS/GitDove"), ["--remote-debugging-port=0"], {
    env: { ...process.env, GITDOVE_USER_DATA: join(work, "user-data") },
  });
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise((done) => child.once("exit", done));
  const endpoint = await new Promise((done, fail) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = /DevTools listening on (ws:\S+)/.exec(stderr);
      if (match) done(match[1]);
    });
    child.once("exit", () => fail(new Error(`GitDove exited during startup:\n${stderr}`)));
  });
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent("page"));
  await page.evaluate(() => {
    window.statuses = [];
    window.gitdove.on("updater.status", (s) => window.statuses.push(s));
  });
  statuses = () => page.evaluate(() => window.statuses);
  const status = () =>
    page.evaluate(async () => (await window.gitdove.invoke("updater.status")).value);
  return { child, exited, browser, page, status };
}

/** Sparkle keeps downloads and settings per bundle identifier; start each case from scratch. */
function resetSparkle() {
  for (const domain of [id, `${id}.updater`]) {
    try {
      execFileSync("/usr/bin/defaults", ["delete", domain], { stdio: "ignore" });
    } catch {
      // Nothing stored yet.
    }
    rmSync(join(homedir(), "Library/Caches", domain), { recursive: true, force: true });
  }
}

const cases = {
  async "rejects a tampered update"(app) {
    tampered = true;
    const a = await launch(app);
    await until(async () => (await a.status()).kind === "error", "the update is rejected");
    a.child.kill("SIGTERM");
    await a.exited;
    await sleep(3000);
    assert.equal(version(app), "1.0.0");
    tampered = false;
  },

  async "installs on quit without relaunching"(app) {
    const a = await launch(app);
    await until(async () => (await a.status()).kind === "ready", "the update is ready");
    a.child.kill("SIGTERM");
    assert.equal(await a.exited, 0);
    await until(() => version(app) === "1.0.1", "the update is installed");
    await sleep(5000);
    assert.deepEqual(running(app), [], "GitDove was relaunched");
  },

  async "installs and relaunches on Restart"(app) {
    const a = await launch(app);
    const restart = a.page.getByRole("button", { name: "Restart" });
    await restart.waitFor({ timeout: 120_000 });
    await restart.click();
    assert.equal(await a.exited, 0);
    await until(() => version(app) === "1.0.1" && running(app).length > 0, "GitDove relaunches");
  },
};

/** Runs a case on a fresh copy of `installed`; returns whether it passed. */
async function runCase(name, run, installed) {
  resetSparkle();
  const app = join(work, name.replaceAll(" ", "-"), "GitDove.app");
  execFileSync("/usr/bin/ditto", [installed, app]);
  output = "";
  try {
    await run(app);
    console.log(`ok - ${name}`);
    return true;
  } catch (error) {
    const history = await statuses().catch(() => "unavailable");
    console.log(`not ok - ${name}\n${error.stack}\nStatuses: ${JSON.stringify(history)}`);
    console.log(`GitDove output:\n${output.slice(-4000)}`);
    return false;
  } finally {
    for (const pid of running(app)) process.kill(pid, "SIGKILL");
  }
}

// Diagnostics for the current case.
let output = "";
let statuses = async () => [];

let failed = false;
try {
  assert.equal(
    readPlist(join(source, "Contents/Info.plist")).CFBundleIdentifier,
    "dev.gitdove.app",
  );
  console.log("Preparing the update (1.0.1)");
  const update = join(work, "update/GitDove.app");
  copyApp(update, "1.0.1");
  const zip = join(work, "GitDove-1.0.1.zip");
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", update, zip]);
  const feed = join(work, "appcast.xml");
  await writeAppcast({ zip, url: `${base}/update.zip`, seed, output: feed, settings });
  files["/appcast.xml"] = readFileSync(feed);
  files["/update.zip"] = readFileSync(zip);
  const installed = join(work, "installed/GitDove.app");
  copyApp(installed, "1.0.0");

  for (const [name, run] of Object.entries(cases)) {
    if (!name.includes(process.env.CASE ?? "")) continue;
    // Cases share the bundle identifier, so they run one at a time.
    if (!(await runCase(name, run, installed))) failed = true; // NOSONAR
  }
} finally {
  server.close();
  resetSparkle();
  rmSync(work, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
