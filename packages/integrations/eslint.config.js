import base from "@clockoff/config/eslint/base";

/**
 * Dependency direction (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §3.2): @clockoff/integrations depends
 * on @clockoff/shared and zod only. It never reaches the database, Next.js, React, pino or the web app; those
 * stay in apps/web, which adapts this package. package.json has no such dependency, and this rule is the
 * second line (apps/web/src/server/integrations/dependencyDirection.test.ts checks both).
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
              group: [
                "@clockoff/db",
                "@clockoff/db/*",
                "@prisma/client",
                "@prisma/client/*",
                "next",
                "next/*",
                "react",
                "react/*",
                "react-dom",
                "react-dom/*",
                "pino",
                "pino/*",
                "@/*",
                "**/apps/web/**",
              ],
              message:
                "@clockoff/integrations is free of Prisma, Next.js, React, pino and apps/web (plan §3.2): take what you need as an injected dependency.",
            },
          ],
        },
      ],
    },
  },
];
