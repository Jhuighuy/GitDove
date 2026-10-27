import { useEffect } from "react";
import { useSettings } from "@/stores/settings";

/** A CSS font family name. */
const cssString = (s: string) => `"${s.replaceAll(/["\\]/g, "\\$&")}"`;

/**
 * Applies the appearance settings that CSS picks up: the code font (`--code-font`, used by
 * `font-mono`) and whether it draws ligatures. The theme needs nothing here: the main process
 * sets it for the whole app, which `prefers-color-scheme` (and so `next-themes`) follows.
 */
export function SettingsSync() {
  const codeFont = useSettings((s) => s.codeFont);
  const ligatures = useSettings((s) => s.ligatures);
  useEffect(() => {
    const root = document.documentElement;
    // The bundled font stands in for a font that is not installed.
    if (codeFont)
      root.style.setProperty("--code-font", `${cssString(codeFont)}, "JetBrains Mono Variable"`);
    else root.style.removeProperty("--code-font");
  }, [codeFont]);
  useEffect(() => {
    document.documentElement.dataset.ligatures = ligatures ? "on" : "off";
  }, [ligatures]);
  return null;
}
