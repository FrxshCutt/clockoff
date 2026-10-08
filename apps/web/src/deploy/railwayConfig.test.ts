import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseEnv, SHUTDOWN_GRACE_MAX_MS } from "@/lib/env";
import { WORKER_SHUTDOWN_FIXED_BUDGET_MS } from "@/worker/shutdown";

/**
 * The Railway deployment as code: railway/{web,worker}.json (one settings file per service), applied by
 * .railway/railway.ts (Railway's infrastructure as code — new services no longer read railway.json),
 * docker/{web,worker}/Dockerfile, docker/web/migrate.sh (the web pre-deploy command) and .dockerignore.
 * Field names were checked against https://railway.com/railway.schema.json; these tests pin the values
 * the runtime relies on (draining vs. the shutdown grace, memory vs. the heap caps, health check and
 * migrations on web only) and the images' security/determinism rules.
 */

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const MiB = 1024 * 1024;

interface RailwayConfig {
  $schema?: string;
  build: { builder: string; dockerfilePath: string; watchPatterns: string[] };
  deploy: {
    preDeployCommand?: string | string[];
    preDeployTimeoutSeconds?: number;
    healthcheckPath?: string;
    healthcheckTimeout?: number;
    restartPolicyType: string;
    restartPolicyMaxRetries: number;
    numReplicas: number;
    sleepApplication: boolean;
    overlapSeconds: number;
    drainingSeconds: number;
    limitOverride: { containers: { memoryBytes: number } };
  };
}

const web = JSON.parse(read("railway/web.json")) as RailwayConfig;
const worker = JSON.parse(read("railway/worker.json")) as RailwayConfig;
const webDockerfile = read("docker/web/Dockerfile");
const workerDockerfile = read("docker/worker/Dockerfile");

/** SHUTDOWN_GRACE_MS's default, read from the env schema itself. */
const defaultGraceSeconds =
  parseEnv({
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    APP_URL: "http://localhost:3000",
    SESSION_SECRET: "s".repeat(64),
    MOBILE_JWT_SECRET: "m".repeat(64),
    INTEGRATION_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  }).env.SHUTDOWN_GRACE_MS / 1000;

/** A Dockerfile without its comment lines. */
function instructions(dockerfile: string): string {
  return dockerfile
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

/** `--max-old-space-size=<MiB>` from a Dockerfile's NODE_OPTIONS. */
function heapCapMiB(dockerfile: string): number {
  const match = /NODE_OPTIONS="?[^\n]*--max-old-space-size=(\d+)/.exec(dockerfile);
  expect(match, "NODE_OPTIONS sets --max-old-space-size").not.toBeNull();
  return Number(match![1]);
}

describe("railway/web.json and railway/worker.json", () => {
  it("build both services from their own Dockerfile", () => {
    for (const [name, config] of [
      ["web", web],
      ["worker", worker],
    ] as const) {
      expect(config.$schema).toBe("https://railway.com/railway.schema.json");
      expect(config.build.builder).toBe("DOCKERFILE");
      expect(config.build.dockerfilePath).toBe(`docker/${name}/Dockerfile`);
      expect(existsSync(path.join(ROOT, config.build.dockerfilePath))).toBe(true);
      // Changes to the service's own image or config file must redeploy it.
      expect(config.build.watchPatterns).toEqual(
        expect.arrayContaining([
          "apps/web/**",
          "packages/**",
          "pnpm-lock.yaml",
          `docker/${name}/**`,
          `railway/${name}.json`,
        ]),
      );
    }
    expect(web.build.watchPatterns).not.toContain("docker/worker/**");
    expect(worker.build.watchPatterns).not.toContain("docker/web/**");
  });

  it("restart on failure, one always-on replica each", () => {
    for (const config of [web, worker]) {
      expect(config.deploy.restartPolicyType).toBe("ON_FAILURE");
      expect(config.deploy.restartPolicyMaxRetries).toBe(10);
      expect(config.deploy.numReplicas).toBe(1);
      expect(config.deploy.sleepApplication).toBe(false);
    }
  });

  it("size web at 512 MiB and the worker at 256 MiB, with heap caps well inside", () => {
    expect(web.deploy.limitOverride.containers.memoryBytes).toBe(512 * MiB);
    expect(worker.deploy.limitOverride.containers.memoryBytes).toBe(256 * MiB);
    // Prisma's engine, buffers and code live outside the V8 heap: keep ≥ 35 % headroom.
    expect(heapCapMiB(webDockerfile)).toBeLessThanOrEqual(512 * 0.65);
    expect(heapCapMiB(workerDockerfile)).toBeLessThanOrEqual(256 * 0.65);
  });

  it("drain long enough for the graceful shutdown before SIGKILL, for any allowed SHUTDOWN_GRACE_MS", () => {
    expect(defaultGraceSeconds).toBe(20);
    // SHUTDOWN_GRACE_MS is one shared variable: check the largest value the schema accepts, plus a
    // margin for process exit and log flushing.
    const marginMs = 3_000;
    expect(() =>
      parseEnv({
        DATABASE_URL: "postgresql://u:p@localhost:5432/db",
        APP_URL: "http://localhost:3000",
        SESSION_SECRET: "s".repeat(64),
        MOBILE_JWT_SECRET: "m".repeat(64),
        INTEGRATION_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
        SHUTDOWN_GRACE_MS: String(SHUTDOWN_GRACE_MAX_MS + 1),
      }),
    ).toThrow(/SHUTDOWN_GRACE_MS/);
    // Web: stream close + in-flight requests, cut off at SHUTDOWN_GRACE_MS, then process exit.
    expect(web.deploy.drainingSeconds * 1000).toBeGreaterThanOrEqual(
      SHUTDOWN_GRACE_MAX_MS + marginMs,
    );
    // Worker: jobs finish within SHUTDOWN_GRACE_MS, and the fixed steps (stop timers, push hand-over,
    // mark stopped, unlock, close LISTEN, settle, Prisma) take up to 20.5 s more.
    expect(WORKER_SHUTDOWN_FIXED_BUDGET_MS).toBe(20_500);
    expect(worker.deploy.drainingSeconds * 1000).toBeGreaterThanOrEqual(
      SHUTDOWN_GRACE_MAX_MS + WORKER_SHUTDOWN_FIXED_BUDGET_MS + marginMs,
    );
    // Web overlaps so a deploy never drops traffic; a worker never overlaps (one scheduler at a time,
    // the advisory locks cover the rest).
    expect(web.deploy.overlapSeconds).toBeGreaterThan(0);
    expect(worker.deploy.overlapSeconds).toBe(0);
  });

  it("health-check and migrate on web only", () => {
    expect(web.deploy.healthcheckPath).toBe("/api/health");
    expect(existsSync(path.join(ROOT, "apps/web/src/app/api/health/route.ts"))).toBe(true);
    expect(web.deploy.healthcheckTimeout).toBeGreaterThanOrEqual(60);
    expect(web.deploy.preDeployCommand).toBe("/app/migrate.sh");
    expect(web.deploy.preDeployTimeoutSeconds).toBeGreaterThanOrEqual(120);
    // The pre-deploy command runs inside the web image: the script must be there, executable.
    expect(webDockerfile).toMatch(/COPY [^\n]*docker\/web\/migrate\.sh \.\/migrate\.sh/);
    expect(webDockerfile).toMatch(/chmod 0755 \/app\/migrate\.sh/);

    expect(worker.deploy).not.toHaveProperty("healthcheckPath");
    expect(worker.deploy).not.toHaveProperty("healthcheckTimeout");
    expect(worker.deploy).not.toHaveProperty("preDeployCommand");
    expect(worker.deploy).not.toHaveProperty("preDeployTimeoutSeconds");
  });

  it("leave the region out (chosen when the service is created)", () => {
    expect(web.deploy).not.toHaveProperty("region");
    expect(worker.deploy).not.toHaveProperty("region");
  });
});

describe("docker/web/Dockerfile and docker/worker/Dockerfile", () => {
  const rootPackage = JSON.parse(read("package.json")) as { packageManager: string };
  const pnpmVersion = /^pnpm@(\d+\.\d+\.\d+)$/.exec(rootPackage.packageManager)?.[1];

  it.each([
    ["web", webDockerfile],
    ["worker", workerDockerfile],
  ])("%s: deterministic, unprivileged, Node as PID 1", (_name, dockerfile) => {
    expect(pnpmVersion).toBeDefined();
    expect(dockerfile).toContain(`npm install -g pnpm@${pnpmVersion}`);
    // Exact release + index digest: a rebuild never picks up a different base image.
    expect(dockerfile).toMatch(
      /^ARG NODE_IMAGE=node:22\.\d+\.\d+-bookworm-slim@sha256:[0-9a-f]{64}$/m,
    );
    expect(dockerfile).toContain("pnpm install --frozen-lockfile");
    const code = instructions(dockerfile);
    expect(code).not.toMatch(/corepack/i);
    // Railway requires service-prefixed cache ids; the build stays cache-mount free.
    expect(code).not.toMatch(/--mount=type=cache/);
    // Next's own signal handling must stay on (graceful shutdown).
    expect(code).not.toContain("NEXT_MANUAL_SIG_HANDLE");
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toMatch(/^ENV NODE_ENV=production\b/m);
    // Exec form: node receives SIGTERM directly (no shell, no pnpm in between).
    const cmds = dockerfile.match(/^CMD .*$/gm) ?? [];
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatch(/^CMD \["node", "[^"]+"\]$/);
    // The last stage (the image) starts from the plain OS stage, not from a build stage.
    const stages = [...dockerfile.matchAll(/^FROM (\S+) AS (\S+)$/gm)].map((m) => [m[1], m[2]]);
    expect(stages.at(-1)).toEqual(["os", "runner"]);
    expect(stages[0]).toEqual(["${NODE_IMAGE}", "os"]);
  });

  it("web runs the standalone server on 0.0.0.0:$PORT and ships static + public + migrations", () => {
    expect(webDockerfile).toContain('CMD ["node", "apps/web/server.js"]');
    expect(webDockerfile).toMatch(/^ENV HOSTNAME=0\.0\.0\.0 PORT=3000\b/m);
    expect(webDockerfile).toContain("/repo/apps/web/.next/standalone ./");
    expect(webDockerfile).toContain("/repo/apps/web/.next/static ./apps/web/.next/static");
    expect(webDockerfile).toContain("/repo/apps/web/public ./apps/web/public");
    expect(webDockerfile).toContain("/opt/migrate ./migrate");
  });

  it("worker runs the esbuild bundle", () => {
    expect(workerDockerfile).toContain("node apps/web/scripts/build-worker.mjs");
    expect(workerDockerfile).toContain("/repo/apps/web/dist/worker/ ./");
    expect(workerDockerfile).toContain('CMD ["node", "main.mjs"]');
    expect(workerDockerfile).not.toContain("next build");
  });
});

describe(".dockerignore", () => {
  const lines = read(".dockerignore")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));

  it("keeps secrets, local installs and build output out of the build context", () => {
    expect(lines).toEqual(
      expect.arrayContaining([
        "**/.env",
        "**/.env.*",
        "**/node_modules",
        "**/.next",
        "**/dist",
        ".git",
        "apps/ios",
      ]),
    );
    // Nothing re-includes an env file.
    expect(lines.filter((l) => l.startsWith("!"))).toEqual([]);
  });
});

describe("docker/web/migrate.sh", () => {
  const script = read("docker/web/migrate.sh");

  it("prefers the direct URL, refuses pooled strings and execs the Prisma CLI", () => {
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain("set -eu");
    expect(script).toContain('url="${DIRECT_URL:-$DATABASE_URL}"');
    expect(script).toContain("*-pooler.*|*pgbouncer=true*)");
    expect(script).toMatch(
      /^exec node node_modules\/prisma\/build\/index\.js migrate deploy --schema prisma\/schema\.prisma$/m,
    );
    // Never echo a connection string.
    expect(script).not.toMatch(/echo[^\n]*\$(?:url|DATABASE_URL|DIRECT_URL)/);
  });

  it("is committed executable", () => {
    const mode = spawnSync("git", ["ls-files", "-s", "docker/web/migrate.sh"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    // Untracked until the change is committed: then check the file mode on disk instead.
    if (mode.status === 0 && mode.stdout.trim() !== "") {
      expect(mode.stdout.startsWith("100755")).toBe(true);
    } else {
      expect(spawnSync("test", ["-x", path.join(ROOT, "docker/web/migrate.sh")]).status).toBe(0);
    }
  });

  describe("executed with sh and a stub node", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "clockoff-migrate-"));
    const bin = path.join(dir, "bin");
    const record = path.join(dir, "node-called.txt");
    mkdirSync(bin);
    mkdirSync(path.join(dir, "migrate"));
    writeFileSync(path.join(dir, "migrate.sh"), script);
    writeFileSync(
      path.join(bin, "node"),
      `#!/bin/sh\nprintf '%s\\n' "$PWD" "$DATABASE_URL" "$CHECKPOINT_DISABLE" "$*" > "${record}"\n`,
    );
    chmodSync(path.join(bin, "node"), 0o755);

    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    const NEON_POOLED =
      "postgresql://app:s3cret@ep-x-123-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require&pgbouncer=true";
    const NEON_DIRECT =
      "postgresql://app:s3cret@ep-x-123.eu-west-2.aws.neon.tech/neondb?sslmode=require";

    function run(env: Record<string, string>) {
      rmSync(record, { force: true });
      const result = spawnSync("sh", [path.join(dir, "migrate.sh")], {
        // Only these variables: nothing from the developer's or CI's environment leaks in.
        env: { NODE_ENV: "test", PATH: `${bin}:/usr/bin:/bin`, ...env },
        encoding: "utf8",
      });
      return {
        status: result.status,
        output: `${result.stdout}${result.stderr}`,
        node: existsSync(record) ? readFileSync(record, "utf8").split("\n") : null,
      };
    }

    it("refuses a pooled DIRECT_URL without printing it (node never runs)", () => {
      const r = run({ DATABASE_URL: NEON_POOLED, DIRECT_URL: NEON_POOLED });
      expect(r.status).toBe(1);
      expect(r.output).toMatch(/refusing a pooled connection string/);
      expect(r.output).not.toContain("s3cret");
      expect(r.output).not.toContain("ep-x-123");
      expect(r.node).toBeNull();
    });

    it("refuses a pooled DATABASE_URL fallback when DIRECT_URL is unset", () => {
      const r = run({ DATABASE_URL: NEON_POOLED });
      expect(r.status).toBe(1);
      expect(r.node).toBeNull();
      const bouncer = run({
        DATABASE_URL: "postgresql://u:p@db.example.com:6432/db?pgbouncer=true",
      });
      expect(bouncer.status).toBe(1);
    });

    it("requires DATABASE_URL", () => {
      const r = run({ DIRECT_URL: NEON_DIRECT });
      expect(r.status).not.toBe(0);
      expect(r.output).toMatch(/DATABASE_URL must be set/);
      expect(r.node).toBeNull();
    });

    it("runs prisma migrate deploy from ./migrate with DATABASE_URL set to the direct URL", () => {
      const r = run({ DATABASE_URL: NEON_POOLED, DIRECT_URL: NEON_DIRECT });
      expect(r.status).toBe(0);
      expect(r.output).not.toContain("s3cret");
      const [cwd, databaseUrl, checkpoint, args] = r.node!;
      expect(cwd).toMatch(/\/migrate$/);
      expect(databaseUrl).toBe(NEON_DIRECT);
      expect(checkpoint).toBe("1");
      expect(args).toBe(
        "node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma",
      );
    });

    it("falls back to a direct DATABASE_URL (local runs without DIRECT_URL)", () => {
      const local = "postgresql://clockoff:clockoff@localhost:5433/clockoff?schema=public";
      const r = run({ DATABASE_URL: local });
      expect(r.status).toBe(0);
      expect(r.node![1]).toBe(local);
    });
  });
});

describe(".railway/railway.ts (infrastructure as code)", () => {
  const iac = read(".railway/railway.ts");
  const listed = (constant: string) =>
    [
      ...(new RegExp(`const ${constant} = \\[([^\\]]*)\\]`).exec(iac)?.[1] ?? "").matchAll(
        /"([A-Z0-9_]+)"/g,
      ),
    ].map((match) => match[1]);

  it("applies the per-service files instead of repeating their settings", () => {
    expect(iac).toContain('from "../railway/web.json" with { type: "json" }');
    expect(iac).toContain('from "../railway/worker.json" with { type: "json" }');
    expect(iac).toContain('github("FrxshCutt/clockoff", { branch: "main" })');
    // The CLI evaluates the file with Node as an ES module.
    expect(JSON.parse(read(".railway/package.json")).type).toBe("module");
    for (const config of [web, worker]) expect(config.build.watchPatterns).toContain(".railway/**");
  });

  it("preserves every variable the services read, so an apply never deletes one", () => {
    const shared = listed("SHARED_VARIABLES");
    for (const name of [
      "DATABASE_URL",
      "DIRECT_URL",
      "APP_URL",
      "NEXT_PUBLIC_APP_URL",
      "MARKETING_URL",
      "HOST_ROUTING",
      "SESSION_SECRET",
      "MOBILE_JWT_SECRET",
      "INTEGRATION_ENCRYPTION_KEY",
      "EMAIL_PROVIDER",
      "EMAIL_FROM",
      "RESEND_API_KEY",
      "CLIENT_IP_HEADER",
      "SHUTDOWN_GRACE_MS",
    ])
      expect(shared).toContain(name);
    expect(iac).toContain(
      'const WEB_VARIABLES = [...SHARED_VARIABLES, "PORT", "REALTIME_STREAM_MAX_LIFETIME_MS"];',
    );
    expect(iac).toContain('const WORKER_VARIABLES = [...SHARED_VARIABLES, "WORKER_JOBS_ENABLED"];');
    // Retired Netlify-era names must not come back (the worker refuses JOBS_ENABLED=false).
    for (const retired of ["JOBS_ENABLED", "CRON_SECRET"]) expect(shared).not.toContain(retired);
  });
});
