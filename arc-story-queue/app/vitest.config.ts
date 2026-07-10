import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Run tests against arc-contracts source so they never exercise a stale
      // dist artifact (W-000033), matching vite.config.ts.
      "arc-contracts": fileURLToPath(
        new URL("../packages/arc-contracts/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    // Playwright specs under e2e/ run via `npm run e2e`, not vitest.
    exclude: [...configDefaults.exclude, "e2e/**"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: {
      forks: {
        execArgv: ["--experimental-sqlite"],
      },
    },
  },
});
