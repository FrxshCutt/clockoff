import { prisma } from "@clockoff/db";
import {
  SENTINEL_BIRTH_DATE,
  SENTINEL_PII_PREFIX,
  SENTINEL_USERNAME_DOMAIN,
} from "@clockoff/integrations/planday/mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import {
  completeOnboarding,
  connectViaMethod,
  createPlandayOrg,
  driveRunToCompletion,
  enqueue,
  installPlanday,
  runKind,
  runSync,
  setSliceLoggerForTesting,
  uninstallPlanday,
  type PlandayOrg,
  type PlandayTestContext,
} from "./plandayHarness";

/**
 * Data minimisation (spec §8; docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §4.7, §6.5, §13.2
 * `dataMinimisation.test.ts`): after onboarding (one in-scope employee unticked at step 5), Finish, two syncs, a
 * deactivation and a CLOCK run, no text, varchar, citext, json/jsonb or text[] column of any table holds a strip-set
 * sentinel, a token, or the name, email or Planday id of someone ClockOff must not keep (1010: excluded department;
 * 1011: deactivated, never imported; 1012: unticked), except the unticked id in `excludedEmployeeIds` and map rows.
 * Punches of excluded departments or unmapped people make no ClockEvent, and the captured logs hold none of it either.
 */

let t: PlandayTestContext;
let org: PlandayOrg;
const logLines: string[] = [];

beforeEach(async () => {
  process.env.PLANDAY_CLOCK_MODE_ENABLED = "true";
  resetEnvCache();
  t = installPlanday({ clockMode: true });
  org = await createPlandayOrg();
  await connectViaMethod(org);
  logLines.length = 0;
  setSliceLoggerForTesting(
    createLogger({ level: "debug" }, { write: (line: string) => void logLines.push(line) }),
  );
});

afterEach(() => {
  setSliceLoggerForTesting(undefined);
  delete process.env.PLANDAY_CLOCK_MODE_ENABLED;
  resetEnvCache();
  expect(t.mock.unexpectedRequests).toEqual([]);
  uninstallPlanday();
});

interface TextColumn {
  table: string;
  column: string;
  kind: "text" | "json" | "array";
  scoped: boolean;
}

async function textColumns(): Promise<TextColumn[]> {
  const rows = await prisma.$queryRaw<
    Array<{ table_name: string; column_name: string; data_type: string; udt_name: string }>
  >`
    SELECT c.table_name, c.column_name, c.data_type, c.udt_name
      FROM information_schema.columns c
      JOIN information_schema.tables tb ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
     WHERE c.table_schema = 'public' AND tb.table_type = 'BASE TABLE'
       AND c.table_name <> '_prisma_migrations'
       AND (c.data_type IN ('text', 'character varying', 'json', 'jsonb')
            OR c.udt_name IN ('citext', '_text', '_varchar', '_citext'))`;
  const orgScoped = new Set(
    (
      await prisma.$queryRaw<Array<{ table_name: string }>>`
        SELECT table_name FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name = 'organisation_id'`
    ).map((r) => r.table_name),
  );
  return rows.map((r) => ({
    table: r.table_name,
    column: r.column_name,
    kind:
      r.data_type === "json" || r.data_type === "jsonb"
        ? "json"
        : r.udt_name.startsWith("_")
          ? "array"
          : "text",
    scoped: orgScoped.has(r.table_name),
  }));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `table.column` values matching any needle (case-insensitive substring), optionally only this organisation's rows. */
async function findSubstrings(
  columns: readonly TextColumn[],
  needles: readonly string[],
  options: { onlyOrganisation?: string } = {},
): Promise<string[]> {
  const pattern = needles.map(escapeRegex).join("|");
  const hits: string[] = [];
  for (const column of columns) {
    if (options.onlyOrganisation && !column.scoped) continue;
    const scope = options.onlyOrganisation
      ? `AND organisation_id = '${options.onlyOrganisation}'::uuid`
      : "";
    const rows = await prisma.$queryRawUnsafe<Array<{ value: string }>>(
      `SELECT "${column.column}"::text AS value FROM "${column.table}"
        WHERE "${column.column}"::text ~* $1 ${scope} LIMIT 3`,
      pattern,
    );
    for (const row of rows)
      hits.push(`${column.table}.${column.column}: ${row.value.slice(0, 120)}`);
  }
  return hits;
}

describe("the run's cursor (§6.5: unmapped people are never persisted)", () => {
  it("lists only mapped people from the deactivated list, at every step of the run", async () => {
    await completeOnboarding(org);
    t.mock.controls.deactivateEmployee(1009); // mapped
    t.mock.controls.deactivateEmployee(1010); // excluded department: never imported
    const queued = await enqueue(org, "SYNC", "MANUAL");
    const runId = queued.outcome === "QUEUED" ? queued.run.id : "";
    const listedIds = new Set<string>();
    for (let i = 0; i < 200; i++) {
      // One step per slice, so the cursor is read after every step.
      const { run } = await driveRunToCompletion(runId, { maxSlices: 1, maxMs: 0 });
      const state = (run.cursor as { run?: { listed?: string[]; listedDeactivated?: string[] } })
        .run;
      for (const id of [...(state?.listed ?? []), ...(state?.listedDeactivated ?? [])]) {
        listedIds.add(id);
      }
      if (run.status !== "RUNNING") break;
    }
    // Both are on Planday's deactivated list; only 1009 is mapped.
    expect(listedIds).toContain("1009");
    expect(listedIds).not.toContain("1010");
    expect(t.mock.requestLog.some((e) => e.path === "/hr/v1.0/employees/deactivated")).toBe(true);
  });
});

describe("nothing outside spec §8 is persisted", () => {
  it("scans every text column of every table after a full lifecycle", async () => {
    const unticked = 1012; // Leo Turner (Kitchen): in scope, left unticked at step 5
    await completeOnboarding(org, {
      selection: { mode: "ALL_EXCEPT", externalIds: [String(unticked)] },
      newTeamGroupIds: ["201", "202", "203", "204"],
      activationMode: "CLOCK_EVENT",
    });
    await runSync(org);
    await runSync(org);
    t.mock.controls.deactivateEmployee(1009);
    await runSync(org);
    const clock = await runKind(org, "CLOCK", "SCHEDULED");
    expect(clock.run.status).not.toBe("FAILED");

    // Punches: only mapped people in included departments become ClockEvents.
    const events = await prisma.clockEvent.findMany({
      where: { organisationId: org.organisationId },
    });
    expect(events.length).toBeGreaterThan(0);
    const excludedPunch = String(t.mock.fixture.specials.excludedDepartmentPunchClockShiftId);
    expect(events.some((e) => e.externalId?.includes(`:${excludedPunch}:`))).toBe(false);
    expect(events.every((e) => e.source === "PLANDAY")).toBe(true);

    const columns = await textColumns();
    expect(columns.length).toBeGreaterThan(50);
    // Positive control: the scan finds what is stored (an imported person, a department name).
    expect(
      await findSubstrings(columns, ["aisha.khan@mockbistro.test"], {
        onlyOrganisation: org.organisationId,
      }),
    ).not.toEqual([]);
    const tokens = [
      ...t.mock.state.accessTokens.keys(),
      ...[...t.mock.state.grants.values()].map((g) => g.refreshToken),
    ].filter((v): v is string => typeof v === "string" && v.length > 8);
    const forbidden = [
      SENTINEL_PII_PREFIX,
      SENTINEL_BIRTH_DATE.slice(0, 10),
      SENTINEL_USERNAME_DOMAIN,
      "+4470090",
      // 1010 (excluded department) and 1011 (deactivated, never imported)
      "Omar",
      "omar.said",
      "Hannah",
      "hannah.wright",
      `PLANDAY:${org.portalId}:1010`,
      `PLANDAY:${org.portalId}:1011`,
      ...tokens,
    ];
    expect(await findSubstrings(columns, forbidden)).toEqual([]);

    // The unticked person: no name, email or portal-qualified id in this organisation's rows.
    expect(
      await findSubstrings(
        columns,
        ["Leo", "Turner", "leo.turner", `PLANDAY:${org.portalId}:${unticked}`],
        {
          onlyOrganisation: org.organisationId,
        },
      ),
    ).toEqual([]);
    // Their bare id only in excludedEmployeeIds (and nowhere else of this integration).
    const config = await prisma.integrationMappingConfig.findUniqueOrThrow({
      where: { integrationId: org.integrationId },
    });
    expect(config.excludedEmployeeIds).toEqual([String(unticked)]);
    expect(
      await prisma.pendingExternalEmployee.count({ where: { integrationId: org.integrationId } }),
    ).toBe(0);
    expect(
      await prisma.externalEntityMap.count({
        where: {
          integrationId: org.integrationId,
          externalId: { in: ["1010", "1011", String(unticked)] },
          entityType: "EMPLOYEE",
        },
      }),
    ).toBe(0);
    const runs = await prisma.integrationSyncRun.findMany({
      where: { integrationId: org.integrationId },
    });
    for (const run of runs) {
      const text = JSON.stringify({
        c: run.cursor,
        w: run.warnings,
        p: run.progress,
        n: run.counts,
      });
      expect(text).not.toContain(`"${unticked}"`);
      expect(text).not.toContain("Leo");
    }
    // Shifts never carry Planday's comment (Shift.notes is always null for synced shifts).
    expect(
      await prisma.shift.count({
        where: {
          organisationId: org.organisationId,
          managedByIntegrationId: org.integrationId,
          notes: { not: null },
        },
      }),
    ).toBe(0);

    // Logs: no sentinel, token, name or email.
    const everyone = t.mock.fixture.portals[0]!.employees.flatMap((e) => [
      e.raw.firstName,
      e.raw.lastName,
      ...(e.raw.email ? [e.raw.email] : []),
    ]);
    const log = logLines.join("\n");
    expect(logLines.length).toBeGreaterThan(0);
    for (const needle of [...forbidden, ...everyone]) {
      expect(log.includes(needle), needle).toBe(false);
    }
  });
});
