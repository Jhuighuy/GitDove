import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/** Tests that run real git, shells or file watchers: slow, so `npm run test:unit` skips them. */
const integration = [
  "src/main/git/repository*.test.ts",
  "src/main/git/watcher.test.ts",
  "src/main/exec/{hosts,runner,runner.*,spawn,terminate}.test.ts",
  "src/**/*.int.test.ts",
];

export default defineConfig({
  resolve: {
    alias: {
      "@shared": resolve(import.meta.dirname, "src/shared"),
      "@": resolve(import.meta.dirname, "src/renderer/src"),
    },
  },
  // As in the renderer build (electron.vite.config.ts): tests run the components the app ships.
  plugins: [react({ compiler: true })],
  test: {
    testTimeout: 30000,
    // Throwaway repositories must not pick up the developer's git configuration (commit signing,
    // hooks, fsmonitor, ...). Tests that need an identity or other settings set them explicitly.
    // "/dev/null" on every platform: Git for Windows maps it to NUL.
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
          exclude: [...configDefaults.exclude, ...integration],
        },
      },
      { extends: true, test: { name: "integration", include: integration } },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "**/*.d.ts",
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
