import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Process boundaries of the Railway deployment: the web service (everything Next.js bundles from
 * apps/web/src) runs no background jobs and never bridges pushes; both belong to the worker process
 * (src/worker), whose entry is bundled separately. Events reach every process through Postgres
 * LISTEN/NOTIFY, so a second bridge in web would send duplicate pushes, and a job in web would be
 * interrupted by every web deploy.
 *
 * Scans the TypeScript AST (comments and strings are ignored) of every non-test source file outside
 * src/worker.
 */

const SRC = path.resolve(import.meta.dirname, "..");
const WORKER_DIR = path.join(SRC, "worker");

/** Modules allowed to call the job entry points: where they are defined (the worker calls them too). */
const JOB_ENTRY_POINTS: Record<string, string[]> = {
  runWorkModeTick: ["server/workState/workStateJob.ts"],
  runScheduleUpkeep: ["server/workState/workStateJob.ts"],
  sweepExpiredOverrides: ["server/workState/workStateJob.ts"],
  runScheduledIntegrationSyncs: ["server/integrations/scheduledSync.ts"],
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full === WORKER_DIR) continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

interface Scan {
  /** Every module specifier: static imports, re-exports, `import()` and `require()`. */
  specifiers: string[];
  /** Names of called functions (`foo(…)` and `x.foo(…)`). */
  calls: string[];
}

function scan(file: string): Scan {
  return scanText(file, readFileSync(file, "utf8"));
}

function scanText(fileName: string, text: string): Scan {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const calls: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const [first] = node.arguments;
      if (
        (callee.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(callee) && callee.text === "require")) &&
        first &&
        ts.isStringLiteralLike(first)
      ) {
        specifiers.push(first.text);
      }
      if (ts.isIdentifier(callee)) calls.push(callee.text);
      else if (ts.isPropertyAccessExpression(callee)) calls.push(callee.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { specifiers, calls };
}

/** Absolute path a specifier points at (`@/…` alias or relative), or null for packages. */
function resolveSpecifier(file: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) return path.join(SRC, specifier.slice(2));
  if (specifier.startsWith(".")) return path.resolve(path.dirname(file), specifier);
  return null;
}

const rel = (file: string) => path.relative(SRC, file).split(path.sep).join("/");

const files = sourceFiles(SRC);
const scans = new Map(files.map((file) => [file, scan(file)] as const));

describe("web/worker process boundaries", () => {
  it("scans the web sources (sanity)", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => rel(f) === "instrumentation.ts")).toBe(true);
    expect(files.some((f) => rel(f).startsWith("worker/"))).toBe(false);
  });

  it("no web module imports the worker (src/worker)", () => {
    const offenders: string[] = [];
    for (const [file, { specifiers }] of scans) {
      for (const specifier of specifiers) {
        const target = resolveSpecifier(file, specifier);
        if (
          specifier === "@/worker" ||
          specifier.startsWith("@/worker/") ||
          (target !== null && (target === WORKER_DIR || target.startsWith(WORKER_DIR + path.sep)))
        ) {
          offenders.push(`${rel(file)} → ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no web module schedules jobs (node-cron)", () => {
    const offenders = [...scans]
      .filter(([, { specifiers }]) => specifiers.some((s) => s === "node-cron"))
      .map(([file]) => rel(file));
    expect(offenders).toEqual([]);
  });

  it("job entry points are only called where they are defined (the worker runs them)", () => {
    const offenders: string[] = [];
    for (const [file, { calls }] of scans) {
      for (const [name, allowed] of Object.entries(JOB_ENTRY_POINTS)) {
        if (calls.includes(name) && !allowed.includes(rel(file)))
          offenders.push(`${rel(file)}: ${name}()`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("only the worker enables the push bridge", () => {
    const offenders = [...scans]
      .filter(
        ([file, { calls }]) =>
          rel(file) !== "server/realtime/pushBridge.ts" && calls.includes("enablePushBridge"),
      )
      .map(([file]) => rel(file));
    expect(offenders).toEqual([]);
  });

  it("src/instrumentation.ts imports only the shutdown hook and the event bus", () => {
    const instrumentation = path.join(SRC, "instrumentation.ts");
    expect([...new Set(scans.get(instrumentation)!.specifiers)].sort()).toEqual([
      "@/server/events",
      "@/server/lifecycle/webShutdown",
    ]);
  });
});

describe("the scanner itself", () => {
  it("finds static, dynamic, re-export and require specifiers and calls, ignoring comments and strings", () => {
    const text = [
      `import a from "@/worker/x";`,
      `export { b } from "../worker/y";`,
      `// import c from "node-cron"; enablePushBridge();`,
      `/* runWorkModeTick() */`,
      `const s = "enablePushBridge()";`,
      `void import("node-cron");`,
      `const r = require("pg");`,
      `bridge.enablePushBridge(bus);`,
      `runWorkModeTick(new Date());`,
    ].join("\n");
    const { specifiers, calls } = scanText("fixture.ts", text);
    expect(specifiers).toEqual(["@/worker/x", "../worker/y", "node-cron", "pg"]);
    expect(calls).toEqual(["require", "enablePushBridge", "runWorkModeTick"]);
    expect(resolveSpecifier(path.join(SRC, "app", "x.ts"), "../worker/y")).toBe(
      path.join(WORKER_DIR, "y"),
    );
  });
});
