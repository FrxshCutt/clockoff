#!/usr/bin/env node
/**
 * Bundle the worker (`src/worker/main.ts`) into one ESM file for the Railway worker image:
 *
 *   node apps/web/scripts/build-worker.mjs [--outdir <dir>]      (default <web>/dist/worker)
 *   pnpm --filter @clockoff/web build:worker
 *
 * Every path resolves from this script's own location (`<web>` = apps/web), so the output is the same
 * whatever the working directory; only an explicit `--outdir` resolves against the current directory.
 *
 * - esbuild → `<out>/main.mjs` (platform node, target node22, ESM, linked source map, metafile), with a
 *   `require` shim banner for bundled CommonJS code.
 * - External (copied next to the bundle by `collect-runtime-deps.mjs`): `@prisma/client` + the generated
 *   `.prisma/client` (query engine), `@node-rs/argon2` (native); `pg-native` is never used.
 * - `next/server` maps to `src/worker/shims/next-server.ts`; the build FAILS if Next.js or React end up in
 *   the bundle (the web app's code must not leak into the worker's dependency graph).
 * - `process.env.LOG_SERVICE_NAME` is fixed to "clockoff-worker" (the logger's `service` binding).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { collectRuntimeDeps } from "./collect-runtime-deps.mjs";

const WEB_DIR = path.resolve(import.meta.dirname, "..");

/** Metafile inputs that must never be bundled (plain and pnpm `.pnpm/<id>/node_modules/` paths). */
export const FORBIDDEN_INPUT =
  /(^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(next|react|react-dom)\//;

export const BUNDLE_EXTERNALS = [
  "@prisma/client",
  ".prisma/client",
  "@node-rs/argon2",
  "pg-native",
];
/** The logger's `service` binding inside the bundle. */
export const WORKER_LOG_SERVICE = "clockoff-worker";

/** Externals the bundle needs at runtime, copied into `<out>/node_modules`. */
export const RUNTIME_PACKAGES = ["@prisma/client", "@node-rs/argon2"];

export function forbiddenInputs(inputs) {
  return Object.keys(inputs).filter((input) =>
    FORBIDDEN_INPUT.test(input.split(path.sep).join("/")),
  );
}

const nextServerShim = {
  name: "next-server-shim",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^next\/server(\.js)?$/ }, () => ({
      path: path.join(WEB_DIR, "src", "worker", "shims", "next-server.ts"),
    }));
  },
};

export async function buildWorker({ outDir = path.join(WEB_DIR, "dist", "worker") } = {}) {
  const out = path.resolve(outDir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const result = await build({
    absWorkingDir: WEB_DIR,
    entryPoints: [path.join(WEB_DIR, "src", "worker", "main.ts")],
    outfile: path.join(out, "main.mjs"),
    tsconfig: path.join(WEB_DIR, "tsconfig.json"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    sourcemap: "linked",
    metafile: true,
    legalComments: "none",
    logLevel: "warning",
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
    external: BUNDLE_EXTERNALS,
    // Log lines say `service: "clockoff-worker"` (src/lib/logger.ts) whatever the runtime environment.
    define: { "process.env.LOG_SERVICE_NAME": JSON.stringify(WORKER_LOG_SERVICE) },
    plugins: [nextServerShim],
  });

  const forbidden = forbiddenInputs(result.metafile.inputs);
  if (forbidden.length > 0) {
    throw new Error(
      `build-worker: Next.js / React must not be bundled into the worker; found ${forbidden.length} input(s), e.g. ${forbidden.slice(0, 3).join(", ")}`,
    );
  }
  writeFileSync(path.join(out, "meta.json"), JSON.stringify(result.metafile));

  const placed = collectRuntimeDeps({ fromDir: WEB_DIR, outDir: out, packages: RUNTIME_PACKAGES });
  const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
  return {
    outDir: out,
    bundleBytes: bytes,
    runtimePackages: placed.map((p) => `${p.name}@${p.version}`),
  };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--outdir") {
      const value = argv[++i];
      if (!value) throw new Error("usage: build-worker.mjs [--outdir <dir>]");
      options.outDir = path.resolve(process.cwd(), value);
    } else {
      throw new Error(`build-worker: unknown argument ${argv[i]}`);
    }
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const summary = await buildWorker(parseArgs(process.argv.slice(2)));
    console.log(
      `build-worker: ${path.relative(process.cwd(), summary.outDir) || "."}/main.mjs ` +
        `(${(summary.bundleBytes / 1024 / 1024).toFixed(1)} MB incl. map) + ${summary.runtimePackages.join(", ")}`,
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
