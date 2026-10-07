import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { assertTestDatabaseName, assertTestDatabaseUrl } from "../helpers/testDatabase";

/**
 * Vitest globalSetup for the `integration` project (runs once per `vitest run`, in the main process).
 *
 * Resets the dedicated, ephemeral test database named by TEST_DATABASE_URL:
 *   DROP SCHEMA public CASCADE → CREATE SCHEMA public → CREATE EXTENSION citext, pgcrypto →
 *   `prisma migrate deploy` (cwd packages/db, DATABASE_URL=TEST_DATABASE_URL).
 *
 * Safety:
 * - Refuses to run unless TEST_DATABASE_URL names a database ending in `_test` that differs from
 *   DATABASE_URL, and re-checks `current_database()` on the open connection before dropping the schema;
 *   DATABASE_URL is overwritten with the test URL before the Prisma client module loads.
 * - Concurrent runs (several engineers / terminals on one machine share `clockoff_test`) are serialised
 *   with a Postgres session advisory lock held from reset until the run's teardown, so one run never
 *   drops the schema under another. Waits up to INTEGRATION_LOCK_WAIT_SECONDS (default 600) for it.
 * - `lock_timeout` makes the reset fail with a clear error instead of hanging if some other client holds
 *   locks on the test tables.
 */
const ADVISORY_LOCK_KEY = 74_201_031; // arbitrary constant: "clockoff integration suite"

function singleConnectionUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.set("connection_limit", "1");
  return u.toString();
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const testUrl = assertTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  process.env.DATABASE_URL = testUrl;

  const { createPrismaClient } = await import("@clockoff/db");
  // One connection, so the session-level advisory lock and the reset share a backend.
  const client = createPrismaClient(singleConnectionUrl(testUrl));

  const waitSeconds = Number(process.env.INTEGRATION_LOCK_WAIT_SECONDS ?? 600);
  const deadline = Date.now() + waitSeconds * 1000;
  let announced = false;
  for (;;) {
    const rows = await client.$queryRaw<
      Array<{ locked: boolean }>
    >`SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) AS locked`;
    if (rows[0]?.locked) break;
    if (Date.now() > deadline) {
      await client.$disconnect();
      throw new Error(
        `Another integration run holds the clockoff_test lock (waited ${waitSeconds}s). ` +
          "Wait for it to finish, or stop the stale vitest process.",
      );
    }
    if (!announced) {
      console.info("[integration] waiting for another integration run to finish…");
      announced = true;
    }
    await sleep(1000);
  }

  try {
    // Belt and braces: check the database the server actually connected us to (an alias, a pooler or a
    // proxy could map the URL's name onto another database) before dropping anything.
    const [current] = await client.$queryRaw<
      Array<{ name: string }>
    >`SELECT current_database() AS name`;
    assertTestDatabaseName(current?.name ?? "");

    await client.$executeRawUnsafe("SET lock_timeout = '30s'");
    await client.$executeRawUnsafe("DROP SCHEMA IF EXISTS public CASCADE");
    await client.$executeRawUnsafe("CREATE SCHEMA public");
    await client.$executeRawUnsafe("CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public");
    await client.$executeRawUnsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
    await client.$executeRawUnsafe("RESET lock_timeout");

    const dbDir = path.resolve(import.meta.dirname, "../../../../packages/db");
    const prismaBin = path.join(
      dbDir,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "prisma.cmd" : "prisma",
    );
    if (!existsSync(prismaBin))
      throw new Error(`Prisma CLI not found at ${prismaBin}; run pnpm install`);
    execFileSync(prismaBin, ["migrate", "deploy"], {
      cwd: dbDir,
      env: { ...process.env, DATABASE_URL: testUrl },
      stdio: process.env.TEST_VERBOSE ? "inherit" : "pipe",
    });
  } catch (err) {
    await client.$queryRaw`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`.catch(() => undefined);
    await client.$disconnect();
    throw err;
  }

  // Teardown: release the lock once every test file has finished.
  return async () => {
    await client.$queryRaw`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`.catch(() => undefined);
    await client.$disconnect();
  };
}
