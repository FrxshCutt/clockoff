import { prisma } from "@clockoff/db";
import { assertTestDatabaseUrl } from "./testDatabase";

/**
 * Empty every application table in the TEST database (keeps the migration history). Not called by
 * default — tests use unique emails/orgs so they can share one database — but available for suites
 * that need a blank slate. Refuses to run unless the connected URL is the `_test` database.
 */
export async function truncateAllTables(): Promise<void> {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length === 0) return;
  const list = rows.map((r) => `"public"."${r.tablename.replace(/"/g, '""')}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
