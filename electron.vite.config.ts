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
    build: { minify: true, sourcemap: true },
  },
});
