import { PrismaClient } from "@prisma/client";
import { SeedClock, resolveSeedNow } from "./seed/clock";
import { insertRows } from "./seed/collector";
import {
  DEMO_MANAGERS,
  DEMO_ORGANISATIONS,
  DEMO_PASSWORD,
  HARPENDEN,
  OTHER_CO,
  organisationIdFor,
  userIdFor,
} from "./seed/constants";
import { loadSeedEnv, resolveDatabaseUrl } from "./seed/env";
import { buildHarpenden } from "./seed/harpenden";
import { buildOtherCo } from "./seed/otherCo";
import { hashSeedPassword } from "./seed/password";
import { resetDemoData } from "./seed/reset";
import { collectCounts, formatCountTable, formatEmployeeTable } from "./seed/summary";

/**
 * Demo seed (§15). Idempotent: deletes the two demo organisations, their mobile identities and their
 * manager accounts, then recreates everything inside one transaction relative to `now` (or `SEED_NOW`).
 *
 *   cd packages/db && pnpm seed          # or: pnpm exec tsx prisma/seed.ts
 *
 * Accounts, scenarios and assumptions: prisma/seed/README.md.
 */
async function main(): Promise<void> {
  loadSeedEnv();
  const databaseUrl = resolveDatabaseUrl();
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl, log: ["warn", "error"] });
  const startedAt = Date.now();
  try {
    const clock = new SeedClock(resolveSeedNow(), HARPENDEN.timezone);
    console.info(`Seeding demo data relative to ${clock.now.toISOString()} (${clock.today} in ${clock.timezone})`);

    // argon2id is deliberately slow; hash outside the transaction, one hash per account.
    const hashes = new Map<string, string>();
    for (const manager of DEMO_MANAGERS) {
      hashes.set(manager.email.toLowerCase(), await hashSeedPassword(DEMO_PASSWORD));
    }
    const hashFor = (email: string): string => {
      const hash = hashes.get(email.toLowerCase());
      if (!hash) throw new Error(`seed: no password hash prepared for ${email}`);
      return hash;
    };

    const harpenden = buildHarpenden(clock, hashFor);
    const otherCo = buildOtherCo(clock, hashFor);

    const reset = await prisma.$transaction(
      async (tx) => {
        const result = await resetDemoData(tx, {
          organisationIds: DEMO_ORGANISATIONS.map((o) => organisationIdFor(o.key)),
          slugs: DEMO_ORGANISATIONS.map((o) => o.slug),
          userIds: DEMO_MANAGERS.map((m) => userIdFor(m.email)),
          userEmails: DEMO_MANAGERS.map((m) => m.email),
        });
        await insertRows(tx, harpenden.rows);
        await insertRows(tx, otherCo.rows);
        return result;
      },
      { timeout: 180_000, maxWait: 20_000 },
    );

    const organisations = [
      { label: HARPENDEN.name, id: harpenden.organisationId },
      { label: OTHER_CO.name, id: otherCo.organisationId },
    ];
    const counts = await collectCounts(prisma, organisations);

    console.info(
      `\nRemoved previous demo data: ${reset.organisations} organisation(s), ${reset.users} user(s), ${reset.mobileUsers} mobile user(s).`,
    );
    console.info("\nRow counts\n" + formatCountTable(organisations, counts));
    console.info(`\n${HARPENDEN.name} employees (lifecycle, status badge and stored vs expected Work Mode state)\n` + formatEmployeeTable(harpenden.employees));
    console.info("\nManager accounts (password for all: " + DEMO_PASSWORD + ")");
    for (const org of DEMO_ORGANISATIONS) {
      for (const manager of Object.values(org.managers)) {
        console.info(`  ${org.name.padEnd(22)} ${manager.role.padEnd(8)} ${manager.email}`);
      }
      console.info(`  ${"".padEnd(22)} join code ${org.joinCode}`);
    }
    console.info(`\nDone in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
