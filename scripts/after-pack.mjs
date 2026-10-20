import { join } from "node:path";
import {
  createSparkleHelper,
  prepareSparkle,
  readPlist,
  updateSettings,
  writePlist,
} from "./sparkle.mjs";

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const arch = { 1: "x64", 3: "arm64" }[context.arch];
  if (!arch) throw new Error(`Unsupported macOS architecture: ${context.arch}`);
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const sparkle = await prepareSparkle();
  createSparkleHelper(join(app, "Contents/Resources/sparkle/GitDoveUpdater.app"), sparkle, arch);
  const plist = join(app, "Contents/Info.plist");
  writePlist(plist, { ...readPlist(plist), ...updateSettings(arch) });
}
