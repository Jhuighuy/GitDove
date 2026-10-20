import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": resolve(import.meta.dirname, "src/shared"),
      "@": resolve(import.meta.dirname, "src/renderer/src"),
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
    testTimeout: 30000,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov"],
      include: ["src/**/*.{ts,tsx}", "scripts/**/*.mjs"],
      exclude: [
        "**/*.d.ts",
        "**/*.test.mjs",
        "scripts/test-updates.mjs",
        // Entry points that only wire things together inside Electron.
        "src/main/index.ts",
        "src/preload/index.ts",
        "src/renderer/src/main.tsx",
        // Generated shadcn components.
        "src/renderer/src/components/ui/**",
      ],
    },
  },
});
