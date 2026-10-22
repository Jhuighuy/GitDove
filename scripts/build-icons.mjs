// Generates all app icon assets from build/icon.svg.
//
//   npm run icons
//
// Outputs (committed; macOS packaging compiles Fold.icon with Xcode 26+):
//   build/Fold.icon/Assets/*.svg  macOS vector layers; materials live in icon.json
//   build/icon.png       1024px, macOS grid (tile with transparent margin)
//   build/icon.icns      static macOS fallback (generation needs macOS iconutil)
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

// Icon Composer supplies its own full-bleed background and system mask. Map the
// existing 824px tile to a 1024px canvas, without baking in the desktop margin.
// Keep the dove's facets on one glass surface so they retain their paper folds.
const defs = source.match(/<defs>([\s\S]*?)<\/defs>/)[1];
const artworkTransform = source.match(/<g transform="([^"]+)"/)[1];
const layer = (names) => {
  const groups = names
    .map((name) => {
      const match = source.match(new RegExp(`<g id="${name}"[\\s\\S]*?<\\/g>`));
      if (!match) throw new Error(`Missing icon group: ${name}`);
      return match[0];
    })
    .join("\n");
  const gradients = [...defs.matchAll(/<linearGradient\b[\s\S]*?<\/linearGradient>/g)]
    .map(([gradient]) => gradient)
    .filter((gradient) => groups.includes(`url(#${gradient.match(/id="([^"]+)"/)[1]})`))
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <!-- Generated from build/icon.svg by npm run icons. -->
  <defs>${gradients}</defs>
  <g transform="scale(${1024 / 824}) translate(-100 -100)">
    <g transform="${artworkTransform}">
${groups}
    </g>
  </g>
</svg>\n`;
};
mkdirSync("build/Fold.icon/Assets", { recursive: true });
write("build/Fold.icon/Assets/git-branch.svg", layer(["git-branch"]));
write(
  "build/Fold.icon/Assets/dove.svg",
  layer(["tail", "rear-wing-layer", "body", "foreground-wing", "beak"]),
);

// Development Dock icon and static fallback for packaging without Xcode.
write("build/icon.png", render(source, 1024));
if (process.platform === "darwin") {
  const temp = mkdtempSync(join(tmpdir(), "gitdove-icon-"));
  const iconset = join(temp, "icon.iconset");
  try {
    mkdirSync(iconset);
    for (const size of [16, 32, 128, 256, 512]) {
      writeFileSync(join(iconset, `icon_${size}x${size}.png`), render(source, size));
      writeFileSync(join(iconset, `icon_${size}x${size}@2x.png`), render(source, size * 2));
    }
    execFileSync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", "build/icon.icns"]);
    console.log("wrote build/icon.icns");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
} else {
  console.warn("keeping committed build/icon.icns (regenerate on macOS with iconutil)");
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
