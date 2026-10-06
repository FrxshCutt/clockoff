import type { PrismaClient } from "@prisma/client";

/**
 * Name of the newest migration in `prisma/migrations`. The deployed app compares it with what the
 * database has applied (GET /api/health), so a deploy whose migrations were not run shows up as
 * `pending`. `migrations.test.ts` fails if a migration is added without updating this constant.
 */
export const LATEST_MIGRATION = "20261006091500_policy_resolution_warning";

export type MigrationStatus = "up_to_date" | "pending" | "failed" | "unknown";

interface MigrationRow {
  migration_name: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

/**
 * Reads `_prisma_migrations`: `failed` when a migration started but neither finished nor was rolled back,
 * `up_to_date` when the latest expected migration has finished, otherwise `pending`. `unknown` when the
 * table cannot be read (fresh database, no permissions).
 */
export async function getMigrationStatus(
  db: Pick<PrismaClient, "$queryRaw">,
): Promise<MigrationStatus> {
  let rows: MigrationRow[];
  try {
    rows = await db.$queryRaw<MigrationRow[]>`
      SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations`;
  } catch {
    return "unknown";
  }
  if (rows.some((row) => row.finished_at === null && row.rolled_back_at === null)) return "failed";
  const applied = rows.some(
    (row) =>
      row.migration_name === LATEST_MIGRATION &&
      row.finished_at !== null &&
      row.rolled_back_at === null,
  );
  return applied ? "up_to_date" : "pending";
}
