// Launches the built app with Playwright and runs a scenario, saving screenshots.
//   node scripts/drive.mjs <scenario.mjs> <outDir>
// The app uses the profile in GITDOVE_USER_DATA, or a throwaway one, never the real GitDove
// profile (which an installed GitDove may be using). Exits non-zero if the scenario fails.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { _electron as electron } from "playwright-core";

const [scenarioPath, outDir = "screenshots"] = process.argv.slice(2);
if (!scenarioPath) {
  console.error("usage: node scripts/drive.mjs <scenario.mjs> [outDir]");
  process.exit(64);
}
mkdirSync(outDir, { recursive: true });
const userData = process.env.GITDOVE_USER_DATA || mkdtempSync(join(tmpdir(), "gitdove-drive-"));
const app = await electron.launch({
  args: [resolve("out/main/index.js")],
  env: { ...process.env, GITDOVE_USER_DATA: userData },
});
const page = await app.firstWindow();
page.on("console", (m) => console.log(`[console.${m.type()}]`, m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
let n = 0;
const shot = async (name) => {
  const file = `${outDir}/${String(n++).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: file });
  console.log("screenshot", file);
};
try {
  const scenario = (await import(pathToFileURL(resolve(scenarioPath)).href)).default;
  await scenario({ app, page, shot });
} catch (e) {
  console.error("scenario failed:", e);
  process.exitCode = 1;
  await shot("failure").catch(() => {});
} finally {
  await app.close();
}
