import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LATEST_MIGRATION, getMigrationStatus } from "./migrations";

describe("LATEST_MIGRATION", () => {
  it("is the newest folder in prisma/migrations", () => {
    const dir = resolve(import.meta.dirname, "../prisma/migrations");
    const folders = readdirSync(dir)
      .filter((entry) => statSync(join(dir, entry)).isDirectory())
      .sort();
    expect(LATEST_MIGRATION).toBe(folders.at(-1));
  });
});

describe("getMigrationStatus", () => {
  const done = new Date();
  const db = (rows: unknown[] | Error) => ({
    $queryRaw: (async () => {
      if (rows instanceof Error) throw rows;
      return rows;
    }) as never,
  });

  it("reports up_to_date, pending, failed and unknown", async () => {
    expect(
      await getMigrationStatus(
        db([{ migration_name: LATEST_MIGRATION, finished_at: done, rolled_back_at: null }]),
      ),
    ).toBe("up_to_date");
    expect(
      await getMigrationStatus(
        db([{ migration_name: "20261005210000_init", finished_at: done, rolled_back_at: null }]),
      ),
    ).toBe("pending");
    expect(
      await getMigrationStatus(
        db([
          { migration_name: "20261005210000_init", finished_at: done, rolled_back_at: null },
          { migration_name: LATEST_MIGRATION, finished_at: null, rolled_back_at: null },
        ]),
      ),
    ).toBe("failed");
    expect(await getMigrationStatus(db(new Error("relation does not exist")))).toBe("unknown");
  });
});
