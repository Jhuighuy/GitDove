import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@shared": resolve(import.meta.dirname, "src/shared") } },
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 30000,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov"],
      include: ["src/**/*.{ts,tsx}", "scripts/**/*.mjs"],
      exclude: ["**/*.d.ts"],
    },
  },
});
