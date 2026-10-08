import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Dependency direction (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §3.2), checked on import specifiers:
 *
 *   @clockoff/shared ← @clockoff/integrations ← apps/web/src/server/integrations/** ← API routes / jobs
 *
 * The Work Mode engine (shared/workMode, server/workState, server/sync, server/breaks) and the modules that
 * expose integration writers (server/shifts, server/employees) read Shift rows and never import integration
 * code; shared and validation never import the integrations package; the package never imports Prisma,
 * Next.js, React, pino or the web app; and in the web app only the integrations server module, its API routes,
 * the Mock Planday dev routes and the mock server script import it. ESLint `no-restricted-imports` enforces the
 * same rules while editing.
 */

const WEB = path.resolve(import.meta.dirname, "../../..");
const ROOT = path.resolve(WEB, "../..");
const SOURCE = /\.(?:ts|tsx|mts|mjs|js)$/;
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "coverage", ".turbo", "generated"]);

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...sourceFiles(path.join(dir, entry.name)));
    } else if (SOURCE.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/** Static and dynamic import / export / require specifiers of a source file (comments stripped first). */
function importSpecifiers(code: string): string[] {
  const stripped = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /^\s*import\s*["']([^"']+)["']/gm,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  return patterns.flatMap((pattern) => [...stripped.matchAll(pattern)].map((m) => m[1]!));
}

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

/** Absolute target of a relative or `@/` specifier, else null (a package import). */
function resolveLocal(file: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) return path.join(WEB, "src", specifier.slice(2));
  if (specifier.startsWith(".")) return path.resolve(path.dirname(file), specifier);
  return null;
}

const isIntegrationsPackage = (specifier: string) =>
  specifier === "@clockoff/integrations" || specifier.startsWith("@clockoff/integrations/");

function violations(
  files: readonly string[],
  isForbidden: (specifier: string, file: string) => boolean,
): string[] {
  return files.flatMap((file) =>
    importSpecifiers(readFileSync(file, "utf8"))
      .filter((specifier) => isForbidden(specifier, file))
      .map((specifier) => `${rel(file)} imports ${specifier}`),
  );
}

describe("importSpecifiers", () => {
  it("finds static, side-effect, dynamic and require imports, ignoring comments", () => {
    const code = [
      'import { a } from "@clockoff/shared";',
      'import type { B } from "./b";',
      'export * from "../c";',
      'import "./side-effect";',
      'const d = await import("@clockoff/integrations/planday");',
      'const e = require("pino");',
      '// import { f } from "@clockoff/db";',
      '/* import { g } from "next"; */',
      'const url = "https://example.com"; // from "nowhere"',
    ].join("\n");
    expect(importSpecifiers(code).sort()).toEqual(
      [
        "../c",
        "./b",
        "./side-effect",
        "@clockoff/integrations/planday",
        "@clockoff/shared",
        "pino",
      ].sort(),
    );
  });
});

describe("dependency direction (plan §3.2)", () => {
  it("the Work Mode engine and the integration-writer modules never import integration code", () => {
    const integrationsDir = path.join(WEB, "src", "server", "integrations");
    const files = [
      ...["workState", "sync", "breaks", "shifts", "employees"].flatMap((name) =>
        sourceFiles(path.join(WEB, "src", "server", name)),
      ),
      ...sourceFiles(path.join(ROOT, "packages", "shared", "src", "workMode")),
    ];
    expect(files.length).toBeGreaterThan(20);
    expect(
      violations(files, (specifier, file) => {
        if (isIntegrationsPackage(specifier)) return true;
        if (/(^|\/)server\/integrations(\/|$)/.test(specifier)) return true;
        const local = resolveLocal(file, specifier);
        return (
          local !== null &&
          (local === integrationsDir || local.startsWith(integrationsDir + path.sep))
        );
      }),
    ).toEqual([]);
  });

  it("@clockoff/shared and @clockoff/validation never import @clockoff/integrations", () => {
    const files = ["shared", "validation"].flatMap((name) =>
      sourceFiles(path.join(ROOT, "packages", name, "src")),
    );
    expect(files.length).toBeGreaterThan(20);
    expect(violations(files, isIntegrationsPackage)).toEqual([]);
  });

  it("@clockoff/integrations depends on @clockoff/shared and zod only, never on Prisma, Next.js, React, pino or the web app", () => {
    const packageDir = path.join(ROOT, "packages", "integrations");
    const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(["@clockoff/shared", "zod"]);
    const forbidden =
      /^(?:@clockoff\/(?:db|validation)|@prisma\/client|next|react|react-dom|pino)(?:\/|$)|^@\//;
    const srcDir = path.join(packageDir, "src");
    const files = sourceFiles(srcDir);
    expect(files.length).toBeGreaterThan(0);
    expect(
      violations(files, (specifier, file) => {
        if (forbidden.test(specifier)) return true;
        const local = resolveLocal(file, specifier);
        // Relative imports stay inside the package's own src/.
        return local !== null && !local.startsWith(srcDir);
      }),
    ).toEqual([]);
  });

  it("in the web app only the integrations module, its routes, the mock dev routes and the mock script import it", () => {
    const allowed = [
      path.join(WEB, "src", "server", "integrations"),
      path.join(WEB, "src", "app", "api", "integrations"),
      path.join(WEB, "src", "app", "api", "dev", "mock-planday"),
    ];
    const isAllowed = (file: string) =>
      allowed.some((dir) => file.startsWith(dir + path.sep)) ||
      file === path.join(WEB, "scripts", "mock-planday.mts");
    const files = [
      ...sourceFiles(path.join(WEB, "src")),
      ...sourceFiles(path.join(WEB, "scripts")),
    ].filter((file) => !isAllowed(file) && statSync(file).isFile());
    expect(files.length).toBeGreaterThan(100);
    // The worker (src/worker/**) is covered too: it reaches the package only through src/server/integrations.
    expect(files.some((file) => file.includes(`${path.sep}worker${path.sep}`))).toBe(true);
    expect(violations(files, isIntegrationsPackage)).toEqual([]);
  });
});
