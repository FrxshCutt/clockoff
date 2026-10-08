import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The worker bundle (D14): `scripts/build-worker.mjs` gives the same output whatever the working
 * directory, the bundle runs `list` with no environment at all, contains no Next.js / React, and ships
 * the generated Prisma client and argon2 next to `main.mjs`.
 */

const WEB_DIR = path.resolve(import.meta.dirname, "../..");
const REPO_ROOT = path.resolve(WEB_DIR, "../..");
const SCRIPT = path.join(WEB_DIR, "scripts", "build-worker.mjs");
const tmp = mkdtempSync(path.join(tmpdir(), "worker-bundle-"));
/** No app environment at all: `list` and the native-module check must not need one. */
const BARE_ENV = { PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv;

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function build(cwd: string, outDir: string): void {
  execFileSync(process.execPath, [path.relative(cwd, SCRIPT), "--outdir", outDir], {
    cwd,
    stdio: "pipe",
    env: BARE_ENV,
  });
}

describe("worker bundle", () => {
  it("builds from the repo root and from apps/web, runs `list` without env and ships its externals", () => {
    const fromRoot = path.join(tmp, "root");
    const fromWeb = path.join(tmp, "web");
    build(REPO_ROOT, path.relative(REPO_ROOT, fromRoot));
    build(WEB_DIR, path.relative(WEB_DIR, fromWeb));

    for (const out of [fromRoot, fromWeb]) {
      expect(existsSync(path.join(out, "main.mjs"))).toBe(true);
      expect(existsSync(path.join(out, "main.mjs.map"))).toBe(true);
      expect(existsSync(path.join(out, "node_modules", ".prisma", "client", "default.js"))).toBe(
        true,
      );
      expect(existsSync(path.join(out, "node_modules", "@prisma", "client", "package.json"))).toBe(
        true,
      );
      expect(existsSync(path.join(out, "node_modules", "@node-rs", "argon2", "package.json"))).toBe(
        true,
      );

      const meta = JSON.parse(readFileSync(path.join(out, "meta.json"), "utf8")) as {
        inputs: Record<string, unknown>;
      };
      const inputs = Object.keys(meta.inputs);
      expect(inputs.some((i) => i.endsWith("src/worker/main.ts"))).toBe(true);
      expect(
        inputs.filter((i) =>
          /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(next|react|react-dom)\//.test(i),
        ),
      ).toEqual([]);
      expect(inputs.some((i) => i.endsWith("src/worker/shims/next-server.ts"))).toBe(true);
      // The logger's `service` binding is fixed at build time (no runtime env var can turn it back to web).
      const bundle = readFileSync(path.join(out, "main.mjs"), "utf8");
      expect(bundle).toContain('"clockoff-worker"');
      expect(bundle).not.toContain("process.env.LOG_SERVICE_NAME");

      const list = spawnSync(process.execPath, ["main.mjs", "list"], {
        cwd: out,
        env: BARE_ENV,
        encoding: "utf8",
      });
      expect(list.status, list.stderr).toBe(0);
      expect(
        list.stdout
          .trim()
          .split("\n")
          .map((l) => l.split("\t")[0]),
      ).toEqual(["work-mode-tick", "override-expiry", "schedule-upkeep", "integrations-sync"]);

      const natives = spawnSync(
        process.execPath,
        ["-e", "require('@prisma/client'); require('@node-rs/argon2'); console.log('ok')"],
        { cwd: out, env: BARE_ENV, encoding: "utf8" },
      );
      expect(natives.status, natives.stderr).toBe(0);
    }

    // Same bundle whichever directory it was built from.
    expect(readFileSync(path.join(fromRoot, "main.mjs"), "utf8")).toBe(
      readFileSync(path.join(fromWeb, "main.mjs"), "utf8"),
    );
  }, 120_000);
});
