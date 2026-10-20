// electron-builder hook: embeds the Sparkle updater into GitDove.app before it is signed.
import { join } from "node:path";
import { Arch } from "electron-builder";
import { embedUpdater } from "./sparkle.mjs";

export default async function afterPack({ electronPlatformName, appOutDir, arch, packager }) {
  if (electronPlatformName !== "darwin") return;
  if (Arch[arch] !== "arm64") throw new Error("macOS builds are Apple silicon (arm64) only");
  await embedUpdater(join(appOutDir, `${packager.appInfo.productFilename}.app`));
}
