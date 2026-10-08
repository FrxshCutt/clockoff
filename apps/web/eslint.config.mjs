import next from "@clockoff/config/eslint/next";

/**
 * Dependency direction (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §3.2): in the web app only the
 * integrations server module, its API routes, the Mock Planday dev routes and the mock server script import
 * @clockoff/integrations; the worker and every other module reach it through `src/server/integrations/**`.
 * The integration tests (`test/**`) and the e2e suite may import it too (the mock and its fixture).
 * `src/server/integrations/dependencyDirection.test.ts` checks the same rules.
 */
const INTEGRATIONS_PACKAGE_ALLOWED = [
  "src/server/integrations/**",
  "src/app/api/integrations/**",
  "src/app/api/dev/mock-planday/**",
  "scripts/mock-planday.mts",
  "test/**",
  "e2e/**",
];

const config = [
  ...next,
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.mjs", "**/*.js"],
    ignores: INTEGRATIONS_PACKAGE_ALLOWED,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@clockoff/integrations", "@clockoff/integrations/*"],
              message:
                "Only src/server/integrations/**, src/app/api/integrations/**, src/app/api/dev/mock-planday/** and scripts/mock-planday.mts import @clockoff/integrations (plan §3.2); go through src/server/integrations instead.",
            },
          ],
        },
      ],
    },
  },
];

export default config;
