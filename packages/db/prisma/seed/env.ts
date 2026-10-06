import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

/** The single root `.env` (docs/DECISIONS.md D-005). Explicit environment variables still win. */
export const ROOT_ENV_PATH = resolve(import.meta.dirname, "../../../../.env");

export function loadSeedEnv(): void {
  loadEnv({ path: ROOT_ENV_PATH, quiet: true });
}

/**
 * The seed wipes and recreates the demo organisations, so it refuses to point at an integration-test
 * database (`*_test`, which the test harness owns and resets) unless `SEED_ALLOW_TEST_DB=1` is set.
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL;
  if (!url) {
    throw new Error(`seed: DATABASE_URL is not set (expected it in ${ROOT_ENV_PATH} or the environment)`);
  }
  let databaseName: string;
  try {
    databaseName = new URL(url).pathname.replace(/^\//, "");
  } catch {
    throw new Error("seed: DATABASE_URL is not a valid connection URL");
  }
  if (databaseName.endsWith("_test") && env.SEED_ALLOW_TEST_DB !== "1") {
    throw new Error(
      `seed: refusing to seed "${databaseName}" — it looks like the integration-test database. ` +
        "Point DATABASE_URL at the dev database, or set SEED_ALLOW_TEST_DB=1.",
    );
  }
  return url;
}
