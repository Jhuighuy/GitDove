// Launches the built app with Playwright and runs a scenario, saving screenshots.
//   node scripts/drive.mjs <scenario.mjs> <outDir>
import { _electron as electron } from "playwright-core";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const [scenarioPath, outDir = "screenshots"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const app = await electron.launch({
  args: [resolve("out/main/index.js")],
  env: { ...process.env, GITDOVE_USER_DATA: process.env.GITDOVE_USER_DATA ?? "" },
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
  const scenario = (await import(resolve(scenarioPath))).default;
  await scenario({ app, page, shot });
} catch (e) {
  console.error("scenario failed:", e);
  await shot("failure").catch(() => {});
} finally {
  await app.close();
}
