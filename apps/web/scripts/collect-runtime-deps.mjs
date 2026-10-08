#!/usr/bin/env node
/**
 * Copy the runtime dependency closure of some installed packages into `<out>/node_modules`, as plain
 * files a `node` process can resolve without pnpm's symlinked store:
 *
 *   node apps/web/scripts/collect-runtime-deps.mjs --from <dir> --out <dir> <package>…
 *
 * Used by the images (docker/*), not at runtime:
 *   - the worker bundle (`build-worker.mjs`) keeps `@prisma/client` (+ the generated `.prisma/client`
 *     with the query engine) and `@node-rs/argon2` (native) external and copies them next to `main.mjs`;
 *   - the web image copies the Prisma CLI closure for the pre-deploy `migrate deploy` (`--from packages/db
 *     --out /opt/migrate prisma`).
 *
 * Closure = `dependencies` + the `optionalDependencies` that are installed (pnpm installs only the
 * current platform's native packages; missing optional ones are skipped). Each package is located the way
 * Node resolves it (walking up `node_modules` from the dependent's real directory) and copied
 * dereferenced (symlinks become files), without its own nested `node_modules`. The layout is npm-style:
 * flat when names are unique, and a package that conflicts with an already placed version of the same
 * name is nested under its dependent (`<dependent>/node_modules/<name>`). Whenever `@prisma/client` is
 * collected, the generated `.prisma` directory next to it is copied too (an error asks for
 * `prisma generate` when it is missing). Deterministic: only files the frozen-lockfile install produced,
 * no network.
 */
import { cpSync, existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The real directory of `name` as Node would resolve it from `fromDir`, or null. */
export function findInstalledPackage(name, fromDir) {
  let dir = path.resolve(fromDir);
  for (;;) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readPackageJson(dir) {
  return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
}

function copyPackage(from, to) {
  cpSync(from, to, {
    recursive: true,
    dereference: true,
    // A package's own nested node_modules (e.g. `.bin` links, caches) is never part of the closure:
    // its dependencies are collected individually.
    filter: (source) => !path.relative(from, source).split(path.sep).includes("node_modules"),
  });
}

/** `<node_modules>/.prisma` next to an installed `@prisma/client`. */
function prismaSiblingDir(clientDir) {
  return path.join(clientDir, "..", "..", ".prisma");
}

/**
 * Copy the closure of `packages` (resolved from `fromDir`) into `<outDir>/node_modules`.
 * Returns the placed packages (`{ name, version, dir }`, `dir` relative to `outDir`) in placement order.
 */
export function collectRuntimeDeps({ fromDir, outDir, packages }) {
  const outRoot = path.resolve(outDir);
  /** Absolute placed package dir → { name, version }. */
  const placements = new Map();
  const placed = [];

  /** node_modules directories Node searches from a package placed at `pkgDir`, nearest first. */
  function searchDirs(pkgDir) {
    const dirs = [];
    let dir = pkgDir;
    for (;;) {
      if (path.basename(dir) !== "node_modules") dirs.push(path.join(dir, "node_modules"));
      if (dir === outRoot) break;
      const parent = path.dirname(dir);
      if (parent === dir || !parent.startsWith(outRoot)) break;
      dir = parent;
    }
    return dirs;
  }

  function place(name, version, requirerDir) {
    const dirs = searchDirs(requirerDir);
    for (let i = 0; i < dirs.length; i += 1) {
      const candidate = path.join(dirs[i], name);
      const existing = placements.get(candidate);
      if (!existing) continue;
      if (existing.version === version) return { dir: candidate, existing: true };
      if (i === 0) {
        throw new Error(
          `collect-runtime-deps: ${name} is needed at ${existing.version} and ${version} by the same dependent`,
        );
      }
      // Shadowed by another version further up: nest under the dependent (npm-style).
      return { dir: path.join(dirs[0], name), existing: false };
    }
    return { dir: path.join(dirs[dirs.length - 1], name), existing: false };
  }

  const queue = packages.map((name) => {
    const source = findInstalledPackage(name, fromDir);
    if (!source) {
      throw new Error(`collect-runtime-deps: ${name} is not installed (looked from ${fromDir})`);
    }
    return { name, source, requirerDir: outRoot, requiredBy: "(root)" };
  });

  while (queue.length > 0) {
    const { name, source, requirerDir, requiredBy } = queue.shift();
    const manifest = readPackageJson(source);
    const target = place(name, manifest.version, requirerDir);
    if (target.existing) continue;

    copyPackage(source, target.dir);
    placements.set(target.dir, { name, version: manifest.version });
    placed.push({ name, version: manifest.version, dir: path.relative(outRoot, target.dir) });

    if (name === "@prisma/client") {
      const generated = prismaSiblingDir(source);
      if (!existsSync(path.join(generated, "client", "default.js"))) {
        throw new Error(
          "collect-runtime-deps: the generated Prisma client (.prisma/client) is missing next to @prisma/client; run `prisma generate` first",
        );
      }
      copyPackage(generated, prismaSiblingDir(target.dir));
    }

    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      const depSource = findInstalledPackage(dep, source);
      if (!depSource) {
        throw new Error(
          `collect-runtime-deps: ${dep} (a dependency of ${name}, required by ${requiredBy}) is not installed`,
        );
      }
      queue.push({ name: dep, source: depSource, requirerDir: target.dir, requiredBy: name });
    }
    for (const dep of Object.keys(manifest.optionalDependencies ?? {})) {
      // Platform packages of other platforms are not installed: skipping them is the point.
      const depSource = findInstalledPackage(dep, source);
      if (depSource)
        queue.push({ name: dep, source: depSource, requirerDir: target.dir, requiredBy: name });
    }
  }
  return placed;
}

function parseArgs(argv) {
  const options = { from: null, out: null, packages: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--from") options.from = argv[++i] ?? null;
    else if (arg === "--out") options.out = argv[++i] ?? null;
    else options.packages.push(arg);
  }
  if (!options.from || !options.out || options.packages.length === 0) {
    throw new Error("usage: collect-runtime-deps.mjs --from <dir> --out <dir> <package>…");
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const placed = collectRuntimeDeps({
      fromDir: path.resolve(options.from),
      outDir: path.resolve(options.out),
      packages: options.packages,
    });
    console.log(
      `collect-runtime-deps: ${placed.length} packages → ${path.resolve(options.out)}/node_modules`,
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
