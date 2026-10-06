import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

/** The single root `.env` (docs/DECISIONS.md D-005). Explicit environment variables still win. */
export const ROOT_ENV_PATH = resolve(import.meta.dirname, "../../../../.env");

export function loadSeedEnv(): void {
  loadEnv({ path: ROOT_ENV_PATH, quiet: true });
}

/** Hosts that can only be a developer's own machine or a CI service container. */
const LOCAL_DATABASE_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "host.docker.internal",
  "postgres",
]);

/**
 * The seed wipes and recreates demo organisations and demo manager accounts, so it must never touch
 * production. It refuses unless `ALLOW_SEED=true` is set explicitly when:
 * - `NODE_ENV` is `production`, or
 * - `DATABASE_URL` points at anything other than a local database (localhost, Docker, CI service).
 * It also refuses an integration-test database (`*_test`, owned and reset by the test harness) unless
 * `SEED_ALLOW_TEST_DB=1` is set.
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL;
  if (!url) {
    throw new Error(
      `seed: DATABASE_URL is not set (expected it in ${ROOT_ENV_PATH} or the environment)`,
    );
  }
  let databaseName: string;
  let host: string;
  try {
    const parsed = new URL(url);
    databaseName = parsed.pathname.replace(/^\//, "");
    host = parsed.hostname.toLowerCase();
  } catch {
    throw new Error("seed: DATABASE_URL is not a valid connection URL");
  }
  const allowSeed = env.ALLOW_SEED === "true";
  if (env.NODE_ENV === "production" && !allowSeed) {
    throw new Error(
      "seed: refusing to run with NODE_ENV=production — the seed deletes and recreates demo data. " +
        "Set ALLOW_SEED=true only if you really mean to seed this database.",
    );
  }
  if (!LOCAL_DATABASE_HOSTS.has(host) && !allowSeed) {
    throw new Error(
      `seed: refusing to seed a non-local database (host "${host}"). The seed deletes and recreates demo ` +
        "data; it is meant for local development. Set ALLOW_SEED=true only if you really mean it.",
    );
  }
  if (databaseName.endsWith("_test") && env.SEED_ALLOW_TEST_DB !== "1") {
    throw new Error(
      `seed: refusing to seed "${databaseName}" — it looks like the integration-test database. ` +
        "Point DATABASE_URL at the dev database, or set SEED_ALLOW_TEST_DB=1.",
    );
  }
  return url;
}
