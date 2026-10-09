import { prisma } from "@clockoff/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
 * Rate limits and paging (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §4.4, §4.5, §7.10, §13.2
 * `rateLimits.test.ts`): a short 429 is waited out inside the slice; a long one (or one without headers) parks the run
 * with its lease released, and the next slice finishes it; lists are read to exhaustion under a server-lowered page
 * size, with and without `paging`.
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

describe("429 (§4.5, §7.10)", () => {
  it("waits out a short reset inside the slice and succeeds", async () => {
    t.mock.controls.queueRateLimit({ path: "/hr/v1.0/departments", count: 1, resetSeconds: 2 });
    const clockBefore = t.now().getTime();
    const { run, outcomes } = await runKind(org, "STRUCTURE", "INITIAL");
    expect(run.status).toBe("SUCCEEDED");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ state: "DONE" });
    expect(t.now().getTime() - clockBefore).toBeGreaterThanOrEqual(2_000);
    expect(
      t.mock.requestLog.filter((e) => e.path === "/hr/v1.0/departments" && e.status === 429),
    ).toHaveLength(1);
  });

  it("parks the run for a long reset, releasing the lease; the next slice completes it", async () => {
    t.mock.controls.queueRateLimit({
      path: "/hr/v1.0/employeegroups",
      count: 1,
      resetSeconds: 100,
    });
    const queued = await enqueue(org, "STRUCTURE", "INITIAL");
    const runId = queued.outcome === "QUEUED" ? queued.run.id : "";
    const parked = await driveRunToCompletion(runId, { ignoreResumeAfter: false });
    expect(parked.outcomes).toHaveLength(1);
    const outcome = parked.outcomes[0]!;
    expect(outcome).toMatchObject({ state: "PARKED", reason: "RATE_LIMITED" });
    const resumeAfter = outcome.state === "PARKED" ? outcome.resumeAfter : new Date(0);
    expect(resumeAfter.getTime() - t.now().getTime()).toBeGreaterThan(90_000);
    expect(parked.run.status).toBe("RUNNING");
    expect(parked.run.resumeAfter?.getTime()).toBe(resumeAfter.getTime());
    expect((parked.run.progress as { label: string }).label).toMatch(
      /^Waiting for Planday's rate limit — resumes at \d\d:\d\d$/,
    );
    expect((await connectionOf(org)).syncLeaseId).toBeNull();
    // The departments page committed before the park is not read again.
    const departmentReads = t.mock.requestLog.filter(
      (e) => e.path === "/hr/v1.0/departments",
    ).length;
    const { run } = await driveRunToCompletion(runId);
    expect(run.status).toBe("SUCCEEDED");
    expect(t.mock.requestLog.filter((e) => e.path === "/hr/v1.0/departments")).toHaveLength(
      departmentReads,
    );
  });

  it("parks for the default 60 seconds when Planday sends no rate-limit header", async () => {
    t.mock.controls.queueRateLimit({ path: "/hr/v1.0/departments", count: 4 });
    const queued = await enqueue(org, "STRUCTURE", "INITIAL");
    const runId = queued.outcome === "QUEUED" ? queued.run.id : "";
    const { outcomes } = await driveRunToCompletion(runId, { ignoreResumeAfter: false });
    const outcome = outcomes[0]!;
    expect(outcome).toMatchObject({ state: "PARKED", reason: "RATE_LIMITED" });
    if (outcome.state === "PARKED") {
      const wait = outcome.resumeAfter.getTime() - t.now().getTime();
      expect(wait).toBeGreaterThan(50_000);
      expect(wait).toBeLessThanOrEqual(62_000);
    }
  });
});

describe("paging (§4.4)", () => {
  it("reads every list to exhaustion under a server-lowered page size, with and without paging", async () => {
    t.mock.controls.capPageSize(3);
    t.mock.controls.setPagingNull(true);
    const onboarding = await completeOnboarding(org);
    const capped = await prisma.shift.count({
      where: { organisationId: org.organisationId, managedByIntegrationId: org.integrationId },
    });
    expect(
      await prisma.employee.count({
        where: { organisationId: org.organisationId, managedByIntegrationId: org.integrationId },
      }),
    ).toBe(10);
    expect(onboarding.initialSync!.run.status).toBe("SUCCEEDED");

    // The same portal without the cap gives the same records.
    uninstallPlanday();
    t = installPlanday();
    const plain = await createPlandayOrg();
    await connectViaMethod(plain);
    await completeOnboarding(plain);
    const uncapped = await prisma.shift.count({
      where: { organisationId: plain.organisationId, managedByIntegrationId: plain.integrationId },
    });
    expect(capped).toBe(uncapped);
  });
});
