import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, normalizeSettings, stepZoom } from "./settings";

describe("normalizeSettings", () => {
  it("fills in the defaults", () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings([1, 2])).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ theme: "dark" })).toEqual({ ...DEFAULT_SETTINGS, theme: "dark" });
  });

  it("drops invalid values and unknown keys", () => {
    expect(
      normalizeSettings({
        theme: "blue",
        syntaxThemeLight: "vitesse-dark",
        syntaxThemeDark: "dracula",
        codeFontSize: 12.5,
        zoom: 3,
        tabSize: 3,
        codeFont: "a\nb",
        ligatures: "yes",
        extra: 1,
      }),
    ).toEqual({ ...DEFAULT_SETTINGS, syntaxThemeDark: "dracula" });
  });

  it("trims text", () => {
    expect(normalizeSettings({ codeFont: "  Fira Code ", terminal: " " })).toMatchObject({
      codeFont: "Fira Code",
      terminal: "",
    });
  });
});

describe("stepZoom", () => {
  it("moves between the zoom levels and stops at the ends", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -2)).toBe(0.8);
    expect(stepZoom(0.8, -1)).toBe(0.8);
    expect(stepZoom(1.5, 1)).toBe(1.5);
  });

  it("starts from the nearest level above a zoom that is none", () => {
    expect(stepZoom(1.05, 0)).toBe(1.1);
    expect(stepZoom(9, -1)).toBe(1.25);
  });
});
