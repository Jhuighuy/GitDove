import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

const shared = { "@shared": resolve(import.meta.dirname, "src/shared") };

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: {
      // Only true runtime dependencies (native modules, updater) stay external;
      // everything else (Effect included) is bundled for faster startup.
      externalizeDeps: true,
    },
  },
  preload: {
    resolve: { alias: shared },
    build: {
      // Sandboxed preload scripts must be CommonJS.
      rollupOptions: {
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    resolve: {
      alias: { ...shared, "@": resolve(import.meta.dirname, "src/renderer/src") },
    },
    plugins: [react(), tailwindcss()],
    // ES module workers can code-split (shiki loads grammars on demand).
    worker: { format: "es" },
    // Hidden maps: written for local debugging but not referenced from the bundles, and
    // electron-builder.yml leaves them out of the packages.
    build: { minify: true, sourcemap: "hidden" },
  },
});
