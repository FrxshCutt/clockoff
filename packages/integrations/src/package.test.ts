import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The package's own shape (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §3.1, §3.2): runtime dependencies
 * are @clockoff/shared and zod only (no Prisma, Next.js, React or pino, so the worker bundle stays free of
 * them), the entry points are fixed, and Mock Planday is reachable only through its own subpath.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  name: string;
  type: string;
  exports: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

describe("@clockoff/integrations", () => {
  it("depends only on @clockoff/shared and zod at runtime", () => {
    expect(manifest.name).toBe("@clockoff/integrations");
    expect(manifest.type).toBe("module");
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(["@clockoff/shared", "zod"]);
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();
  });

  it("exposes the root, core, planday and planday/mock entry points", () => {
    expect(manifest.exports).toEqual({
      ".": "./src/index.ts",
      "./core": "./src/core/index.ts",
      "./planday": "./src/planday/index.ts",
      "./planday/mock": "./src/planday/mock/index.ts",
    });
  });

  it("keeps Mock Planday out of the root and planday barrels", () => {
    for (const barrel of ["src/index.ts", "src/planday/index.ts"]) {
      const code = readFileSync(path.join(ROOT, barrel), "utf8")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("//"))
        .join("\n");
      expect(code, barrel).not.toMatch(/from\s+["'][^"']*mock[^"']*["']/);
    }
  });

  it("loads every entry point", async () => {
    await expect(import("./index")).resolves.toBeDefined();
    await expect(import("./core/index")).resolves.toBeDefined();
    await expect(import("./planday/index")).resolves.toBeDefined();
    await expect(import("./planday/mock/index")).resolves.toBeDefined();
  });
});
