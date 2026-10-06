import { defineConfig } from "vitest/config";
import path from "node:path";

// Two projects: `unit` (pure TS, fast, no DB) and `integration` (route handlers + services against
// TEST_DATABASE_URL, which the global setup resets). Both share the `@/` alias.
//
// No @vitejs/plugin-react: suites run in the node environment and only need esbuild's JSX transform.
// (plugin-react 6 requires Vite 8; Vitest 3 resolves Vite 7.)
export default defineConfig({
  esbuild: { jsx: "automatic" },
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
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
