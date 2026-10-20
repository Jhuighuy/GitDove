import { describe, expect, it } from "vitest";
import { formatBytes } from "@/lib/format";
import { fileKind, viewFor } from "./views";

describe("fileKind", () => {
  it("renders raster images only as images", () => {
    expect(fileKind("assets/Logo.PNG")).toEqual({
      id: "image",
      views: ["image"],
      mime: "image/png",
    });
    expect(fileKind("a.jpeg").mime).toBe("image/jpeg");
  });

  it("offers SVG as text and image", () => {
    expect(fileKind("icons/x.svg").views).toEqual(["diff", "image"]);
  });

  it("treats everything else, including dotfiles, as text", () => {
    for (const path of ["src/a.ts", "Makefile", ".png", "dir.png/file"]) {
      expect(fileKind(path).views).toEqual(["diff"]);
    }
  });
});

describe("viewFor", () => {
  const svg = fileKind("x.svg");

  it("defaults to the first view", () => {
    expect(viewFor(svg, {})).toBe("diff");
    expect(viewFor(fileKind("x.png"), {})).toBe("image");
  });

  it("uses a remembered view only if the kind has it", () => {
    expect(viewFor(svg, { svg: "image" })).toBe("image");
    expect(viewFor(fileKind("x.ts"), { text: "image" })).toBe("diff");
  });
});

describe("formatBytes", () => {
  it("picks a unit and precision", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(4300)).toBe("4.2 KB");
    expect(formatBytes(150 * 1024)).toBe("150 KB");
    expect(formatBytes(13 * 1024 * 1024)).toBe("13 MB");
    expect(formatBytes(5 * 1024 ** 4)).toBe("5120 GB");
  });
});
