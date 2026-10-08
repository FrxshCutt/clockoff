import base from "@clockoff/config/eslint/base";

/**
 * Dependency direction (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §3.2): @clockoff/integrations depends on
 * this package, never the other way round (apps/web/src/server/integrations/dependencyDirection.test.ts checks
 * it as well).
 */
export default [
  ...base,
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@clockoff/integrations", "@clockoff/integrations/*"],
              message:
                "@clockoff/integrations depends on this package, not the reverse (plan §3.2): move the shared contract here instead.",
            },
          ],
        },
      ],
    },
  },
];
