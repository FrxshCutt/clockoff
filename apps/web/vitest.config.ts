import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Two projects: `unit` (pure TS, fast, no DB) and `integration` (route handlers + services against
// TEST_DATABASE_URL). Both share the `@/` alias.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
          exclude: ["src/**/*.integration.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["src/**/*.integration.test.ts", "test/integration/**/*.test.ts"],
          environment: "node",
          globalSetup: ["./test/integration/global-setup.ts"],
          setupFiles: ["./test/integration/setup.ts"],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
