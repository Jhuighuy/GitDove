// Generates all app icon assets from build/icon.svg.
//
//   npm run icons
//
// Outputs (committed, so packaging needs no extra tools):
//   build/icon.png       1024px, macOS grid (tile with transparent margin)
//   build/icon.icns      macOS (needs `iconutil`, i.e. run on macOS)
//   build/icon.ico       Windows, tile cropped to fill the canvas
//   build/icons/NxN.png  Linux, cropped
//   resources/icon.png   window/dock icon at runtime, cropped
//   src/renderer/src/assets/icon.svg  in-app logo, cropped
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const source = readFileSync("build/icon.svg", "utf8");
const FULL = 'viewBox="0 0 1024 1024"';
// Windows and Linux icons have no grid margin convention; keep a small one.
const cropped = source.replace(FULL, 'viewBox="76 76 872 872"');

const render = (svg, size) =>
  new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();

const write = (path, data) => {
  writeFileSync(path, data);
  console.log("wrote", path);
};

// macOS
write("build/icon.png", render(source, 1024));
if (process.platform === "darwin") {
  const dir = join(mkdtempSync(join(tmpdir(), "gitdove-icon-")), "icon.iconset");
  mkdirSync(dir);
  for (const size of [16, 32, 128, 256, 512]) {
    writeFileSync(join(dir, `icon_${size}x${size}.png`), render(source, size));
    writeFileSync(join(dir, `icon_${size}x${size}@2x.png`), render(source, size * 2));
  }
  execFileSync("iconutil", ["-c", "icns", dir, "-o", "build/icon.icns"]);
  rmSync(dir, { recursive: true, force: true });
  console.log("wrote build/icon.icns");
} else {
  console.warn("skipping build/icon.icns (requires macOS iconutil)");
}

// Windows: an ICO container with PNG-encoded entries (supported since Vista).
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const images = icoSizes.map((s) => render(cropped, s));
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach((png, i) => {
  const size = icoSizes[i];
  const e = 6 + 16 * i;
  header.writeUInt8(size >= 256 ? 0 : size, e);
  header.writeUInt8(size >= 256 ? 0 : size, e + 1);
  header.writeUInt8(0, e + 2);
  header.writeUInt8(0, e + 3);
  header.writeUInt16LE(1, e + 4);
  header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(png.length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += png.length;
});
write("build/icon.ico", Buffer.concat([header, ...images]));

// Linux
mkdirSync("build/icons", { recursive: true });
for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
  write(`build/icons/${size}x${size}.png`, render(cropped, size));
}

// Runtime assets
mkdirSync("resources", { recursive: true });
write("resources/icon.png", render(cropped, 512));
mkdirSync("src/renderer/src/assets", { recursive: true });
write("src/renderer/src/assets/icon.svg", cropped);
