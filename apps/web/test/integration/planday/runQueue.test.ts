import { randomUUID } from "node:crypto";
import { prisma } from "@clockoff/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enqueueRun, mergePendingSlot } from "@/server/integrations/runs/enqueue";
import { getEventBus, type RealtimeEvent } from "@/server/events";
import { runSyncSlice } from "@/server/integrations/runs/executor";
import { isRunProgressTrackedForTesting } from "@/server/integrations/runs/progress";
import {
  acquireLease,
  claimDueRuns,
  releaseLease,
  renewLease,
} from "@/server/integrations/runs/runs.repository";
import {
  completeOnboarding,
  connectionOf,
  connectViaMethod,
  createPlandayOrg,
  driveRunToCompletion,
  enqueue,
  installPlanday,
  runKind,
  uninstallPlanday,
  type PlandayOrg,
  type PlandayTestContext,
} from "./plandayHarness";

/**
 * The run queue and the per-portal lease (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §7.3, §7.4, §7.6, §13.2
 * `runQueue.test.ts`): `enqueueRun`'s outcomes and its pending slot, the follow-ups at FINALISE and at `failRun`,
 * `claimDueRuns`' order, lease exclusivity and expiry, and the fence that keeps a slice from writing anything once its
 * lease is gone or its run has ended (a disconnect during a slice).
 */

let t: PlandayTestContext;
let org: PlandayOrg;

beforeEach(async () => {
  t = installPlanday();
  org = await createPlandayOrg();
  await connectViaMethod(org);
});

afterEach(() => {
  expect(t.mock.unexpectedRequests).toEqual([]);
  uninstallPlanday();
});

async function activeRun(integrationId = org.integrationId) {
  return prisma.integrationSyncRun.findFirst({ where: { integrationId, status: "RUNNING" } });
}

/** One slice that stops after its first step (marks the run started, as a claimed run is). */
async function oneSlice(runId: string, integrationId = org.integrationId) {
  const holder = randomUUID();
  expect(await acquireLease(integrationId, holder)).toBe(true);
  return runSyncSlice(runId, {
    holder,
    instanceId: "test",
    signal: new AbortController().signal,
    now: t.now,
    maxMs: 0,
  });
}

describe("enqueueRun (§7.3)", () => {
  it("never aborts the caller's transaction, and reports each outcome", async () => {
    const outcomes = await prisma.$transaction(async (tx) => {
      const first = await enqueue(org, "STRUCTURE", "INITIAL", {}, tx);
      const again = await enqueue(org, "STRUCTURE", "INITIAL", {}, tx);
      const refused = await enqueue(org, "SYNC", "MANUAL", {}, tx);
      // The transaction is still usable after the conflicting insert.
      await tx.integration.update({
        where: { id: org.integrationId },
        data: { notifyRequested: true },
      });
      return { first, again, refused };
    });
    expect(outcomes.first.outcome).toBe("QUEUED");
    expect(outcomes.again.outcome).toBe("ALREADY_RUNNING");
    expect(outcomes.again.outcome === "ALREADY_RUNNING" && outcomes.again.run.id).toBe(
      outcomes.first.outcome === "QUEUED" && outcomes.first.run.id,
    );
    expect(outcomes.refused).toEqual({ outcome: "REFUSED", reason: "ONBOARDING_INCOMPLETE" });
    expect(
      (await prisma.integration.findUniqueOrThrow({ where: { id: org.integrationId } }))
        .notifyRequested,
    ).toBe(true);
    const run = (await activeRun())!;
    expect(run.priority).toBe(0);
    expect(run.progress).toMatchObject({
      label: "Waiting to start",
      completedPhases: 0,
      totalPhases: 5,
    });
  });

  it("a request of another kind goes into the pending slot and runs when the active run ends (FINALISE)", async () => {
    const structure = await enqueue(org, "STRUCTURE", "INITIAL");
    expect(structure.outcome).toBe("QUEUED");
    const directory = await enqueue(org, "DIRECTORY", "INITIAL");
    expect(directory.outcome).toBe("FOLLOW_UP_QUEUED");
    const slot = await connectionOf(org);
    expect(slot.pendingRunKind).toBe("DIRECTORY");
    expect(slot.pendingRunTrigger).toBe("INITIAL");
    await driveRunToCompletion(structure.outcome === "QUEUED" ? structure.run.id : "");
    const next = (await activeRun())!;
    expect(next.kind).toBe("DIRECTORY");
    expect((await connectionOf(org)).pendingRunKind).toBeNull();
  });

  it("the pending slot also drains when the active run fails (failRun)", async () => {
    t.mock.controls.queueMalformed({ path: "/portal/v1.0/info", count: 1 });
    const structure = await enqueue(org, "STRUCTURE", "INITIAL");
    await enqueue(org, "DIRECTORY", "INITIAL");
    const { run } = await driveRunToCompletion(
      structure.outcome === "QUEUED" ? structure.run.id : "",
    );
    expect(run.status).toBe("FAILED");
    expect(run.errorCode).toBe("PLANDAY_INVALID_RESPONSE");
    expect((await activeRun())?.kind).toBe("DIRECTORY");
  });

  it("a manual SYNC during a started SYNC is already running; Sync now during a CLOCK run runs after it", async () => {
    await completeOnboarding(org);
    const sync = await enqueue(org, "SYNC", "MANUAL");
    expect(sync.outcome).toBe("QUEUED");
    const syncId = sync.outcome === "QUEUED" ? sync.run.id : "";
    expect((await oneSlice(syncId)).state).toBe("YIELDED");
    expect((await enqueue(org, "SYNC", "MANUAL")).outcome).toBe("ALREADY_RUNNING");
    // A SCHEDULED request is a fresh SYNC for after this one.
    expect((await enqueue(org, "SYNC", "SCHEDULED")).outcome).toBe("FOLLOW_UP_QUEUED");
    await driveRunToCompletion(syncId);
    const followUp = (await activeRun())!;
    expect(followUp.kind).toBe("SYNC");
    expect(followUp.trigger).toBe("SCHEDULED");
    await driveRunToCompletion(followUp.id);

    const clock = await enqueue(org, "CLOCK", "SCHEDULED");
    expect(clock.outcome).toBe("QUEUED");
    const clockId = clock.outcome === "QUEUED" ? clock.run.id : "";
    expect(clock.outcome === "QUEUED" && clock.run.priority).toBe(1);
    const now = await enqueue(org, "SYNC", "MANUAL", { retryAuth: false });
    expect(now.outcome).toBe("FOLLOW_UP_QUEUED");
    await driveRunToCompletion(clockId);
    const after = (await activeRun())!;
    expect(after.kind).toBe("SYNC");
    expect(after.trigger).toBe("MANUAL");
  });

  it("Sync now merged into a queued scheduled SYNC takes its priority and starts at once (§7.10)", async () => {
    await completeOnboarding(org);
    const base = {
      organisationId: org.organisationId,
      integrationId: org.integrationId,
      kind: "SYNC" as const,
      trigger: "SCHEDULED" as const,
    };
    const scheduled = await enqueueRun(prisma, {
      ...base,
      resumeAfter: new Date(t.now().getTime() + 90_000), // the slot's jitter
    });
    expect(scheduled.outcome).toBe("QUEUED");
    expect(scheduled.outcome === "QUEUED" && scheduled.run.priority).toBe(3);
    const manual = await enqueue(org, "SYNC", "MANUAL");
    expect(manual.outcome).toBe("ALREADY_RUNNING");
    const merged = manual.outcome === "ALREADY_RUNNING" ? manual.run : null;
    expect(merged?.id).toBe(scheduled.outcome === "QUEUED" ? scheduled.run.id : "");
    expect(merged).toMatchObject({ priority: 0, resumeAfter: null, trigger: "SCHEDULED" });
    // A later scheduled request never slows it down again.
    const again = await enqueueRun(prisma, {
      ...base,
      resumeAfter: new Date(t.now().getTime() + 60_000),
    });
    expect(again.outcome === "ALREADY_RUNNING" && again.run).toMatchObject({
      priority: 0,
      resumeAfter: null,
    });
    // An earlier resume_after wins over a later one.
    await prisma.integrationSyncRun.update({
      where: { id: merged!.id },
      data: { resumeAfter: new Date(t.now().getTime() + 120_000) },
    });
    const sooner = new Date(t.now().getTime() + 30_000);
    const earlier = await enqueueRun(prisma, { ...base, resumeAfter: sooner });
    expect(earlier.outcome === "ALREADY_RUNNING" && earlier.run.resumeAfter).toEqual(sooner);
  });

  it("merges pending requests: SYNC beats CLOCK and wizard kinds, retryAuth is never dropped", () => {
    const sync = {
      kind: "SYNC",
      trigger: "MANUAL",
      retryAuth: false,
      requestedByUserId: null,
    } as const;
    const clock = {
      kind: "CLOCK",
      trigger: "SCHEDULED",
      retryAuth: false,
      requestedByUserId: null,
    } as const;
    const directory = {
      kind: "DIRECTORY",
      trigger: "INITIAL",
      retryAuth: false,
      requestedByUserId: null,
    } as const;
    expect(mergePendingSlot(clock, sync).kind).toBe("SYNC");
    expect(mergePendingSlot(sync, clock).kind).toBe("SYNC");
    expect(mergePendingSlot(directory, sync).kind).toBe("SYNC");
    expect(mergePendingSlot(sync, directory).kind).toBe("SYNC");
    expect(mergePendingSlot({ ...sync, retryAuth: true }, clock)).toMatchObject({
      kind: "SYNC",
      retryAuth: true,
    });
    expect(
      mergePendingSlot({ ...sync, trigger: "SCHEDULED" }, { ...sync, trigger: "MANUAL" }).trigger,
    ).toBe("MANUAL");
  });
});

describe("claims and leases (§7.3, §7.4)", () => {
  /** Other suites' leftover queued runs must not take part in these claims. */
  async function isolateQueue(keep: string[]) {
    await prisma.integrationSyncRun.updateMany({
      where: { status: "RUNNING", integrationId: { notIn: keep } },
      data: { status: "FAILED", errorCode: "TEST_ISOLATION", finishedAt: new Date() },
    });
  }

  it("orders first slices by priority, then round-robins started runs at the scheduled level", async () => {
    await completeOnboarding(org);
    const other = await createPlandayOrg();
    await connectViaMethod(other);
    await completeOnboarding(other);
    await isolateQueue([org.integrationId, other.integrationId]);

    const scheduled = await enqueue(other, "SYNC", "SCHEDULED");
    const manual = await enqueue(org, "SYNC", "MANUAL");
    expect(scheduled.outcome).toBe("QUEUED");
    expect(manual.outcome).toBe("QUEUED");
    const manualId = manual.outcome === "QUEUED" ? manual.run.id : "";
    const scheduledId = scheduled.outcome === "QUEUED" ? scheduled.run.id : "";

    const first = await claimDueRuns({ limit: 1, providers: ["PLANDAY"], instanceId: "w1" });
    expect(first.claimed.map((c) => c.runId)).toEqual([manualId]);
    // The long interactive run gets one slice, then competes at the scheduled level.
    const slice = await runSyncSlice(manualId, {
      holder: first.claimed[0]!.holder,
      instanceId: "w1",
      signal: new AbortController().signal,
      now: t.now,
      maxMs: 0,
    });
    expect(slice.state).toBe("YIELDED");
    const second = await claimDueRuns({ limit: 1, providers: ["PLANDAY"], instanceId: "w1" });
    expect(second.claimed.map((c) => c.runId)).toEqual([scheduledId]);
    await releaseLease(other.integrationId, second.claimed[0]!.holder);

    // resume_after keeps a run out of the queue and is reported as the next wake-up.
    const resumeAt = new Date(Date.now() + 3_600_000);
    await prisma.integrationSyncRun.update({
      where: { id: scheduledId },
      data: { resumeAfter: resumeAt },
    });
    const third = await claimDueRuns({ limit: 2, providers: ["PLANDAY"], instanceId: "w1" });
    expect(third.claimed.map((c) => c.runId)).toEqual([manualId]);
    expect(third.nextResumeAt?.getTime()).toBe(resumeAt.getTime());
    await releaseLease(org.integrationId, third.claimed[0]!.holder);

    // Only AVAILABLE providers' runs are claimed.
    expect((await claimDueRuns({ limit: 2, providers: [], instanceId: "w1" })).claimed).toEqual([]);
    expect(
      (await claimDueRuns({ limit: 2, providers: ["DEPUTY"], instanceId: "w1" })).claimed,
    ).toEqual([]);
    const claimedRun = await prisma.integrationSyncRun.findUniqueOrThrow({
      where: { id: manualId },
    });
    expect(claimedRun.firstClaimedAt).not.toBeNull();
  });

  it("two holders never lease one portal; an expired lease is taken over", async () => {
    const a = randomUUID();
    const b = randomUUID();
    expect(await acquireLease(org.integrationId, a)).toBe(true);
    expect(await acquireLease(org.integrationId, b)).toBe(false);
    expect(await renewLease(prisma, org.integrationId, b)).toBe(false);
    expect(await renewLease(prisma, org.integrationId, a)).toBe(true);
    await prisma.integrationConnection.update({
      where: { integrationId: org.integrationId },
      data: { syncLeaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    expect(await acquireLease(org.integrationId, b)).toBe(true);
    expect(await renewLease(prisma, org.integrationId, a)).toBe(false);
    await releaseLease(org.integrationId, a); // not a's any more: no effect
    expect((await connectionOf(org)).syncLeaseId).toBe(b);
    await releaseLease(org.integrationId, b);
    expect((await connectionOf(org)).syncLeaseId).toBeNull();
  });
});

describe("the fence (§7.6)", () => {
  it("a slice whose lease was taken over writes nothing", async () => {
    const queued = await enqueue(org, "STRUCTURE", "INITIAL");
    const runId = queued.outcome === "QUEUED" ? queued.run.id : "";
    const holder = randomUUID();
    await acquireLease(org.integrationId, holder);
    await prisma.integrationConnection.update({
      where: { integrationId: org.integrationId },
      data: { syncLeaseId: randomUUID() },
    });
    const outcome = await runSyncSlice(runId, {
      holder,
      instanceId: "test",
      signal: new AbortController().signal,
      now: t.now,
    });
    expect(outcome).toMatchObject({ state: "YIELDED", reason: "LEASE_LOST" });
    const run = await prisma.integrationSyncRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.phase).toBe("START");
    expect(run.firstClaimedAt).toBeNull();
    expect(run.status).toBe("RUNNING");
  });

  it("a run that left RUNNING is skipped without a write", async () => {
    const queued = await enqueue(org, "STRUCTURE", "INITIAL");
    const runId = queued.outcome === "QUEUED" ? queued.run.id : "";
    await prisma.integrationSyncRun.update({
      where: { id: runId },
      data: { status: "FAILED", errorCode: "SUPERSEDED", finishedAt: new Date() },
    });
    const holder = randomUUID();
    await acquireLease(org.integrationId, holder);
    const outcome = await runSyncSlice(runId, {
      holder,
      instanceId: "test",
      signal: new AbortController().signal,
      now: t.now,
    });
    expect(outcome).toEqual({ state: "SKIPPED", reason: "NOT_RUNNING" });
    const run = await prisma.integrationSyncRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.errorCode).toBe("SUPERSEDED");
    expect((await connectionOf(org)).syncLeaseId).toBeNull();
  });

  it("a disconnect during a slice: the slice stops, the connection stays DISCONNECTED, nothing is counted", async () => {
    await completeOnboarding(org);
    const queued = await enqueue(org, "SYNC", "MANUAL");
    const runId = queued.outcome === "QUEUED" ? queued.run.id : "";
    t.mock.controls.setLatency(300, { path: "/hr/v1.0/employees" });
    const holder = randomUUID();
    await acquireLease(org.integrationId, holder);
    const events: RealtimeEvent[] = [];
    const unsubscribe = getEventBus().subscribeAll((event) => events.push(event));
    const slice = runSyncSlice(runId, {
      holder,
      instanceId: "test",
      signal: new AbortController().signal,
      now: t.now,
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    // The disconnect transaction (§5.8 steps 1 and 2), as stage 5's service will write it.
    const before = await connectionOf(org);
    await prisma.$transaction(async (tx) => {
      await tx.integrationSyncRun.updateMany({
        where: { integrationId: org.integrationId, status: "RUNNING" },
        data: { status: "FAILED", errorCode: "DISCONNECTED", finishedAt: new Date() },
      });
      await tx.integrationConnection.update({
        where: { integrationId: org.integrationId },
        data: {
          status: "DISCONNECTED",
          encryptedClientId: null,
          encryptedRefreshToken: null,
          encryptedAccessToken: null,
          accessTokenExpiresAt: null,
          credentialHint: null,
          credentialVersion: { increment: 1 },
          syncLeaseId: null,
          syncLeaseExpiresAt: null,
        },
      });
      await tx.integration.update({
        where: { id: org.integrationId },
        data: { status: "DISCONNECTED" },
      });
    });
    const disconnectedAt = events.length;
    const outcome = await slice;
    unsubscribe();
    t.mock.controls.setLatency(0);
    expect(outcome.state).toBe("SKIPPED");
    // No stale "RUNNING" progress for the ended run, and the throttle forgets it.
    expect(
      events
        .slice(disconnectedAt)
        .filter(
          (e) =>
            e.type === "integration.sync.progress" &&
            (e.payload as { runId?: string }).runId === runId,
        ),
    ).toEqual([]);
    expect(isRunProgressTrackedForTesting(runId)).toBe(false);
    const after = await connectionOf(org);
    expect(after.status).toBe("DISCONNECTED");
    expect(after.consecutiveFailureCount).toBe(before.consecutiveFailureCount);
    expect(after.nextSyncAt?.getTime()).toBe(before.nextSyncAt?.getTime());
    expect(after.lastErrorCode).toBeNull();
    const run = await prisma.integrationSyncRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.errorCode).toBe("DISCONNECTED");
    expect(
      await prisma.notification.count({
        where: { organisationId: org.organisationId, type: "INTEGRATION_ERROR" },
      }),
    ).toBe(0);
    // An immediate reconnect can take the portal at once.
    expect(await acquireLease(org.integrationId, randomUUID())).toBe(true);
  });

  it("runs before onboarding never import: a SYNC queued anyway fails ONBOARDING_INCOMPLETE", async () => {
    const run = await prisma.integrationSyncRun.create({
      data: {
        organisationId: org.organisationId,
        integrationId: org.integrationId,
        kind: "SYNC",
        trigger: "MANUAL",
      },
    });
    const { run: done } = await driveRunToCompletion(run.id);
    expect(done.status).toBe("FAILED");
    expect(done.errorCode).toBe("ONBOARDING_INCOMPLETE");
    expect(
      await prisma.employee.count({
        where: { organisationId: org.organisationId, managedByIntegrationId: org.integrationId },
      }),
    ).toBe(0);
    expect((await connectionOf(org)).consecutiveFailureCount).toBe(0);
  });

  it("a STRUCTURE run fills the catalogue without touching ClockOff records", async () => {
    const { run } = await runKind(org, "STRUCTURE", "INITIAL");
    expect(run.status).toBe("SUCCEEDED");
    const config = await prisma.integrationMappingConfig.findUniqueOrThrow({
      where: { integrationId: org.integrationId },
    });
    const catalog = config.catalog as {
      departments: Array<{ externalId: string; employeeCount: number }>;
      groups: unknown[];
      readAt: string;
    };
    expect(catalog.departments.map((d) => d.externalId)).toEqual(["101", "102", "103"]);
    expect(catalog.departments.find((d) => d.externalId === "101")?.employeeCount).toBeGreaterThan(
      0,
    );
    expect(catalog.groups).toHaveLength(4);
    expect(catalog.readAt).not.toBeNull();
    expect(
      await prisma.location.count({
        where: { organisationId: org.organisationId, managedByIntegrationId: org.integrationId },
      }),
    ).toBe(0);
    expect((await connectionOf(org)).status).toBe("CONNECTED");
  });
});

describe("enqueueRun's tenancy", () => {
  it("refuses an integration of another organisation", async () => {
    const other = await createPlandayOrg();
    await expect(
      enqueueRun(prisma, {
        organisationId: other.organisationId,
        integrationId: org.integrationId,
        kind: "STRUCTURE",
        trigger: "INITIAL",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
