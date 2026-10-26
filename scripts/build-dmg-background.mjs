// Render the editable vector artwork at 1× and 2× using the existing icon renderer.
// Outputs are committed so packaging does not need to regenerate artwork.
// npm run dmg:background -- --check verifies that the PNGs match their source.
import { readFileSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const check = process.argv.includes("--check");
const source = readFileSync("build/dmg-background.svg", "utf8");
for (const scale of [1, 2]) {
  const path = `build/dmg-background${scale === 2 ? "@2x" : ""}.png`;
  // Text is outlined in the SVG: no host fonts or network access are required.
  const rendered = new Resvg(source, {
    font: { loadSystemFonts: false },
    fitTo: { mode: "zoom", value: scale },
  }).render();
  const png = rendered.asPng();
  if (check) {
    if (!readFileSync(path).equals(png)) {
      throw new Error(`${path} is stale; run npm run dmg:background`);
    }
    console.log("verified", path, `${rendered.width}×${rendered.height}`);
  } else {
    writeFileSync(path, png);
    console.log("wrote", path, `${rendered.width}×${rendered.height}`);
  }
}
