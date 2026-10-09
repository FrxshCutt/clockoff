import { randomUUID } from "node:crypto";
import { prisma } from "@clockoff/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptCredentialColumns } from "@/server/integrations/credentials";
import { runSyncSlice, type SliceOutcome } from "@/server/integrations/runs/executor";
import { acquireLease } from "@/server/integrations/runs/runs.repository";
import {
  completeOnboarding,
  connectionOf,
  connectViaMethod,
  createPlandayOrg,
  driveRunToCompletion,
  enqueue,
  installPlanday,
  runSync,
  uninstallPlanday,
  type PlandayOrg,
  type PlandayTestContext,
} from "./plandayHarness";

/**
 * Worker shutdown (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §7.7, §13.2 `runnerShutdown.test.ts`): when the
 * runner's signal fires during a page request the request is aborted and nothing of that step is written; a token
 * request in flight is never aborted, so a rotated refresh token is persisted; and a run resumed after the shutdown
 * ends with exactly what an uninterrupted run writes.
 */

let t: PlandayTestContext;
let org: PlandayOrg;

beforeEach(async () => {
  t = installPlanday();
  org = await createPlandayOrg();
  await connectViaMethod(org);
});

afterEach(() => {
  t.mock.controls.setLatency(0);
  expect(t.mock.unexpectedRequests).toEqual([]);
  uninstallPlanday();
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Starts a slice and fires its shutdown signal as soon as a request to `path` has been sent. */
async function sliceShutDownDuring(runId: string, path: string): Promise<SliceOutcome> {
  const shutdown = new AbortController();
  const holder = randomUUID();
  expect(await acquireLease(org.integrationId, holder)).toBe(true);
  const sent = () => t.mock.requestLog.filter((e) => e.path === path).length;
  const before = sent();
  const slice = runSyncSlice(runId, {
    holder,
    instanceId: "test-worker",
    signal: shutdown.signal,
    now: t.now,
  });
  await waitFor(() => sent() > before);
  shutdown.abort();
  return slice;
}

describe("SIGTERM during a slice (§7.7)", () => {
  it("aborts the page request in flight: nothing of the step is written, the cursor stays, the lease is released", async () => {
    await completeOnboarding(org);
    const queued = await enqueue(org, "SYNC", "MANUAL");
    const runId = queued.outcome === "QUEUED" ? queued.run.id : "";
    t.mock.controls.setLatency(2_000, { path: "/hr/v1.0/employees" });
    const outcome = await sliceShutDownDuring(runId, "/hr/v1.0/employees");
    expect(outcome).toMatchObject({ state: "YIELDED", reason: "SHUTDOWN" });
    const run = await prisma.integrationSyncRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("RUNNING");
    expect(run.phase).toBe("EMPLOYEES");
    expect((run.cursor as { phase: Record<string, unknown> }).phase).toEqual({});
    expect(run.claimedBy).toBeNull();
    expect(run.lastSliceAt).not.toBeNull();
    const connection = await connectionOf(org);
    expect(connection.syncLeaseId).toBeNull();
    expect(t.mock.requestLog.some((e) => e.path === "/hr/v1.0/employees" && e.aborted)).toBe(true);
  });

  it("lets a token exchange in flight complete and persists the rotated refresh token", async () => {
    await completeOnboarding(org);
    t.mock.controls.setRotateRefreshTokens(true);
    const before = await connectionOf(org);
    const queued = await enqueue(org, "SYNC", "MANUAL");
    const runId = queued.outcome === "QUEUED" ? queued.run.id : "";
    t.mock.controls.setLatency(300, { path: "/connect/token" });
    const outcome = await sliceShutDownDuring(runId, "/connect/token");
    expect(outcome.state).toBe("YIELDED");
    const after = await connectionOf(org);
    expect(after.credentialVersion).toBe(before.credentialVersion + 1);
    const stored = decryptCredentialColumns(org.integrationId, {
      encryptedClientId: after.encryptedClientId!,
      encryptedRefreshToken: after.encryptedRefreshToken!,
      encryptedAccessToken: after.encryptedAccessToken,
      accessTokenExpiresAt: after.accessTokenExpiresAt,
    });
    const token = t.mock.requestLog.find(
      (e) => e.path === "/connect/token" && e.seq > 0 && !e.aborted,
    );
    expect(token).toBeDefined();
    expect(stored.refreshToken.slice(-4)).toBe(after.credentialHint);
    t.mock.controls.setLatency(0);
    // The persisted (rotated) token is the live one: the resumed run finishes.
    const { run } = await driveRunToCompletion(runId);
    expect(run.status).toBe("SUCCEEDED");
  });

  it("a run resumed after a shutdown ends with exactly the rows, maps and counts of an uninterrupted run", async () => {
    const interrupted = org;
    await completeOnboarding(interrupted, { stopBeforeFinish: true });
    await prisma.integrationMappingConfig.update({
      where: { integrationId: interrupted.integrationId },
      data: { onboardingCompletedAt: t.now() },
    });
    const queued = await enqueue(interrupted, "SYNC", "INITIAL");
    const runId = queued.outcome === "QUEUED" ? queued.run.id : "";
    t.mock.controls.setLatency(2_000, { path: "/scheduling/v1.0/shifts" });
    const outcome = await sliceShutDownDuring(runId, "/scheduling/v1.0/shifts");
    expect(outcome.state).toBe("YIELDED");
    t.mock.controls.setLatency(0);
    const resumed = await driveRunToCompletion(runId);
    expect(resumed.run.status).toBe("SUCCEEDED");

    const plain = await createPlandayOrg();
    await connectViaMethod(plain);
    await completeOnboarding(plain);
    const reference = (await prisma.integrationSyncRun.findFirstOrThrow({
      where: { integrationId: plain.integrationId, kind: "SYNC" },
    }))!;

    expect(resumed.run.counts).toEqual(reference.counts);
    const facts = async (o: PlandayOrg) => {
      const maps = await prisma.externalEntityMap.findMany({
        where: { integrationId: o.integrationId },
        select: { entityType: true, externalId: true },
        orderBy: [{ entityType: "asc" }, { externalId: "asc" }],
      });
      const shifts = await prisma.shift.findMany({
        where: { organisationId: o.organisationId },
        select: {
          externalShiftId: true,
          startsAt: true,
          endsAt: true,
          status: true,
          version: true,
        },
        orderBy: { externalShiftId: "asc" },
      });
      return { maps, shifts };
    };
    expect(await facts(interrupted)).toEqual(await facts(plain));
    // And a further SYNC changes nothing.
    const again = await runSync(interrupted);
    expect(
      (again.run.counts as { shifts: { created: number; updated: number } }).shifts,
    ).toMatchObject({
      created: 0,
      updated: 0,
    });
  });
});
