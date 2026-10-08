import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectRuntimeDeps } from "../../scripts/collect-runtime-deps.mjs";
import { FORBIDDEN_INPUT, forbiddenInputs } from "../../scripts/build-worker.mjs";

type Placed = Array<{ name: string; version: string; dir: string }>;
const collect = collectRuntimeDeps as (opts: {
  fromDir: string;
  outDir: string;
  packages: string[];
}) => Placed;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** A package in a pnpm-like store: `<root>/store/<id>/node_modules/<name>`. */
function storePackage(
  root: string,
  id: string,
  manifest: { name: string; version: string; [key: string]: unknown },
): string {
  const dir = path.join(root, "store", id, "node_modules", manifest.name);
  write(path.join(dir, "package.json"), JSON.stringify(manifest));
  write(
    path.join(dir, "index.js"),
    `module.exports = ${JSON.stringify(`${manifest.name}@${manifest.version}`)};`,
  );
  return dir;
}

function link(target: string, at: string): void {
  mkdirSync(path.dirname(at), { recursive: true });
  symlinkSync(target, at, "dir");
}

/**
 * app → a@1 (deps: b@1, c@2; optional: present-opt, missing-opt) and @prisma/client;
 * b@1 → c@1 (conflicts with a's c@2 → nested under b).
 */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "collect-deps-"));
  dirs.push(root);
  const a = storePackage(root, "a@1", {
    name: "a",
    version: "1.0.0",
    dependencies: { b: "1.0.0", c: "2.0.0" },
    optionalDependencies: { "present-opt": "1.0.0", "missing-opt": "1.0.0" },
  });
  const b = storePackage(root, "b@1", {
    name: "b",
    version: "1.0.0",
    dependencies: { c: "1.0.0" },
  });
  const c1 = storePackage(root, "c@1", { name: "c", version: "1.0.0" });
  const c2 = storePackage(root, "c@2", { name: "c", version: "2.0.0" });
  const opt = storePackage(root, "present-opt@1", { name: "present-opt", version: "1.0.0" });
  // pnpm puts each package's dependencies next to it as symlinks.
  link(b, path.join(root, "store", "a@1", "node_modules", "b"));
  link(c2, path.join(root, "store", "a@1", "node_modules", "c"));
  link(opt, path.join(root, "store", "a@1", "node_modules", "present-opt"));
  link(c1, path.join(root, "store", "b@1", "node_modules", "c"));
  // A symlinked file inside a package, and a nested node_modules that must not be copied.
  write(path.join(root, "shared", "linked.js"), "module.exports = 'linked';");
  symlinkSync(path.join(root, "shared", "linked.js"), path.join(a, "linked.js"));
  write(path.join(a, "node_modules", ".bin", "tool"), "#!/bin/sh");

  const client = storePackage(root, "client@6", { name: "@prisma/client", version: "6.19.3" });
  write(
    path.join(root, "store", "client@6", "node_modules", ".prisma", "client", "default.js"),
    "module.exports = { generated: true };",
  );

  const app = path.join(root, "app");
  link(a, path.join(app, "node_modules", "a"));
  link(client, path.join(app, "node_modules", "@prisma", "client"));
  return { root, app, out: path.join(root, "out") };
}

describe("collectRuntimeDeps", () => {
  it("copies the dependency closure flat, nests a conflicting version and skips missing optionals", () => {
    const { app, out } = fixture();
    const placed = collect({ fromDir: app, outDir: out, packages: ["a"] });
    expect(placed).toEqual([
      { name: "a", version: "1.0.0", dir: path.join("node_modules", "a") },
      { name: "b", version: "1.0.0", dir: path.join("node_modules", "b") },
      { name: "c", version: "2.0.0", dir: path.join("node_modules", "c") },
      { name: "present-opt", version: "1.0.0", dir: path.join("node_modules", "present-opt") },
      { name: "c", version: "1.0.0", dir: path.join("node_modules", "b", "node_modules", "c") },
    ]);
    // Node resolution from the copies picks the right versions.
    const fromA = createRequire(path.join(out, "node_modules", "a", "index.js"));
    const fromB = createRequire(path.join(out, "node_modules", "b", "index.js"));
    expect(fromA("c")).toBe("c@2.0.0");
    expect(fromB("c")).toBe("c@1.0.0");
    expect(existsSync(path.join(out, "node_modules", "missing-opt"))).toBe(false);
  });

  it("dereferences symlinks and leaves a package's own node_modules behind", () => {
    const { app, out } = fixture();
    collect({ fromDir: app, outDir: out, packages: ["a"] });
    const linked = path.join(out, "node_modules", "a", "linked.js");
    expect(lstatSync(linked).isSymbolicLink()).toBe(false);
    expect(readFileSync(linked, "utf8")).toContain("linked");
    expect(lstatSync(path.join(out, "node_modules", "a")).isSymbolicLink()).toBe(false);
    expect(existsSync(path.join(out, "node_modules", "a", "node_modules"))).toBe(false);
  });

  it("copies the generated .prisma sibling with @prisma/client, and asks for prisma generate when missing", () => {
    const { root, app, out } = fixture();
    collect({ fromDir: app, outDir: out, packages: ["@prisma/client"] });
    expect(
      readFileSync(path.join(out, "node_modules", ".prisma", "client", "default.js"), "utf8"),
    ).toContain("generated");

    rmSync(path.join(root, "store", "client@6", "node_modules", ".prisma"), { recursive: true });
    expect(() =>
      collect({ fromDir: app, outDir: path.join(root, "out2"), packages: ["@prisma/client"] }),
    ).toThrow(/prisma generate/);
  });

  it("fails on a package that is not installed", () => {
    const { app, out } = fixture();
    expect(() => collect({ fromDir: app, outDir: out, packages: ["nope"] })).toThrow(
      /nope is not installed/,
    );
  });
});

describe("build-worker next/react guard", () => {
  it("matches plain and pnpm store paths of next, react and react-dom only", () => {
    const re = FORBIDDEN_INPUT;
    expect(
      re.test(
        "../../node_modules/.pnpm/next@15.5.27_react@19.3.0/node_modules/next/dist/server/web/exports/index.js",
      ),
    ).toBe(true);
    expect(re.test("node_modules/react/index.js")).toBe(true);
    expect(
      re.test(
        "../../node_modules/.pnpm/react-dom@19.3.0_react@19.3.0/node_modules/react-dom/server.js",
      ),
    ).toBe(true);
    expect(
      re.test("../../node_modules/.pnpm/next-themes@0.4.6/node_modules/next-themes/dist/index.js"),
    ).toBe(false);
    expect(re.test("../../node_modules/.pnpm/pino@10.4.0/node_modules/pino/pino.js")).toBe(false);
    expect(re.test("src/server/realtime/next/handler.ts")).toBe(false);
    expect(
      forbiddenInputs({
        "src/worker/main.ts": {},
        "node_modules/react/index.js": {},
      }),
    ).toEqual(["node_modules/react/index.js"]);
  });
});
