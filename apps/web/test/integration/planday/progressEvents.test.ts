import { prisma } from "@clockoff/db";
import { SENTINEL_PII_PREFIX } from "@clockoff/integrations/planday/mock";
import { INTEGRATION_EVENT_PAYLOAD_SCHEMAS } from "@clockoff/validation/realtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEventBus, type RealtimeEvent } from "@/server/events";
import { announceRunQueued, enqueueRun } from "@/server/integrations/runs/enqueue";
import {
  publishRunProgress,
  resetRunProgressThrottleForTesting,
  type ProgressRun,
} from "@/server/integrations/runs/progress";
import {
  completeOnboarding,
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
 * Progress and health events (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §7.11, §13.2 `progressEvents.test.ts`):
 * `integration.run.queued` only from `announceRunQueued` after the commit, `integration.sync.progress` after committed
 * steps (throttled, forced on phase changes, parks, yields and the finish), `integration.health.changed` for banner
 * transitions; every payload parses against its strict schema and carries no name, email or Planday value.
 */

let t: PlandayTestContext;
let org: PlandayOrg;
let events: RealtimeEvent[];
let unsubscribe: () => void;

beforeEach(async () => {
  t = installPlanday();
  org = await createPlandayOrg();
  await connectViaMethod(org);
  events = [];
  unsubscribe = getEventBus().subscribeAll((event) => events.push(event));
});

afterEach(() => {
  unsubscribe();
  expect(t.mock.unexpectedRequests).toEqual([]);
  uninstallPlanday();
});

const integrationEvents = () => events.filter((e) => e.type.startsWith("integration."));

function expectCleanPayloads() {
  const names = ["Aisha", "Khan", "Carter", "Morgan", "mockbistro", "Mock Bistro"];
  for (const event of integrationEvents()) {
    const schema =
      INTEGRATION_EVENT_PAYLOAD_SCHEMAS[
        event.type as keyof typeof INTEGRATION_EVENT_PAYLOAD_SCHEMAS
      ];
    expect(schema, event.type).toBeDefined();
    expect(() => schema.parse(event.payload)).not.toThrow();
    const text = JSON.stringify(event.payload);
    expect(text).not.toContain(SENTINEL_PII_PREFIX);
    expect(text).not.toContain("@");
    for (const name of names) expect(text).not.toContain(name);
  }
}

describe("integration.run.queued (§7.11)", () => {
  it("is published only by announceRunQueued after commit; a rolled-back enqueue leaves no run and no event", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const result = await enqueueRun(tx, {
          organisationId: org.organisationId,
          integrationId: org.integrationId,
          kind: "STRUCTURE",
          trigger: "INITIAL",
        });
        expect(result.outcome).toBe("QUEUED");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(integrationEvents()).toEqual([]);
    expect(
      await prisma.integrationSyncRun.count({ where: { integrationId: org.integrationId } }),
    ).toBe(0);

    const committed = await prisma.$transaction((tx) =>
      enqueueRun(tx, {
        organisationId: org.organisationId,
        integrationId: org.integrationId,
        kind: "STRUCTURE",
        trigger: "INITIAL",
      }),
    );
    expect(integrationEvents()).toEqual([]);
    if (committed.outcome !== "QUEUED") throw new Error("not queued");
    announceRunQueued(committed.run);
    expect(integrationEvents().map((e) => e.type)).toEqual(["integration.run.queued"]);
    expect(integrationEvents()[0]!.payload).toEqual({
      provider: "PLANDAY",
      integrationId: org.integrationId,
      runId: committed.run.id,
      kind: "STRUCTURE",
      trigger: "INITIAL",
    });
    expectCleanPayloads();
  });
});

describe("integration.sync.progress (§7.11)", () => {
  it("follows committed steps: a forced event per phase change, throttled pages, and the finish", async () => {
    t.mock.controls.capPageSize(3);
    await completeOnboarding(org);
    events.length = 0;
    const queued = await enqueue(org, "SYNC", "MANUAL");
    const runId = queued.outcome === "QUEUED" ? queued.run.id : "";
    const { run } = await driveRunToCompletion(runId);
    expect(run.status).toBe("SUCCEEDED");
    const progress = integrationEvents()
      .filter((e) => e.type === "integration.sync.progress")
      .map(
        (e) => e.payload as { phase: string; finished: boolean; status: string; queued: boolean },
      );
    expect(progress.length).toBeGreaterThan(3);
    const last = progress[progress.length - 1]!;
    expect(last).toMatchObject({ finished: true, status: "SUCCEEDED" });
    // Every phase change was published; the five pages of EMPLOYEES (cap 3, 12 people) were throttled.
    const phases = new Set(progress.map((p) => p.phase));
    for (const phase of ["PORTAL_CHECK", "DEPARTMENTS", "EMPLOYEES", "SHIFTS"]) {
      expect(phases.has(phase), phase).toBe(true);
    }
    expect(progress.filter((p) => p.phase === "EMPLOYEES").length).toBeLessThanOrEqual(2);
    expect(progress.some((p) => p.queued)).toBe(false);
    expectCleanPayloads();
  });

  it("is forced on a park", async () => {
    t.mock.controls.queueRateLimit({
      path: "/hr/v1.0/employeegroups",
      count: 1,
      resetSeconds: 120,
    });
    const queued = await enqueue(org, "STRUCTURE", "INITIAL");
    const runId = queued.outcome === "QUEUED" ? queued.run.id : "";
    events.length = 0;
    await driveRunToCompletion(runId, { ignoreResumeAfter: false });
    const progress = integrationEvents().filter((e) => e.type === "integration.sync.progress");
    const last = progress[progress.length - 1]!.payload as {
      resumeAfter: string | null;
      label: string;
    };
    expect(last.resumeAfter).not.toBeNull();
    expect(last.label).toContain("rate limit");
    expectCleanPayloads();
  });

  it("throttles to one event per run every 2 s unless forced or the phase changes", () => {
    resetRunProgressThrottleForTesting();
    const run: ProgressRun = {
      id: "00000000-0000-4000-8000-000000000001",
      organisationId: org.organisationId,
      integrationId: org.integrationId,
      kind: "SYNC",
      trigger: "MANUAL",
      status: "RUNNING",
      phase: "EMPLOYEES",
      progress: { completedPhases: 3, totalPhases: 10, label: "Reading employees", pagesRead: 4 },
      firstClaimedAt: new Date(),
      resumeAfter: null,
    };
    expect(publishRunProgress(run, { nowMs: 1_000 })).toBe(true);
    expect(publishRunProgress(run, { nowMs: 2_500 })).toBe(false);
    expect(publishRunProgress(run, { nowMs: 3_000 })).toBe(true);
    expect(publishRunProgress({ ...run, phase: "SHIFTS" }, { nowMs: 3_100 })).toBe(true);
    expect(publishRunProgress({ ...run, phase: "SHIFTS" }, { nowMs: 3_200 })).toBe(false);
    expect(publishRunProgress({ ...run, phase: "SHIFTS" }, { nowMs: 3_300, force: true })).toBe(
      true,
    );
    expect(
      publishRunProgress({ ...run, phase: "SHIFTS", status: "SUCCEEDED" }, { nowMs: 3_400 }),
    ).toBe(true);
    expectCleanPayloads();
  });
});

describe("integration.health.changed (§7.11, §8.1)", () => {
  it("is published when a revoked refresh token moves the connection to AUTH_ERROR", async () => {
    await completeOnboarding(org);
    t.mock.controls.revokeRefreshToken("all");
    events.length = 0;
    const { run } = await runSync(org);
    expect(run.status).toBe("FAILED");
    const health = integrationEvents().filter((e) => e.type === "integration.health.changed");
    expect(health.map((e) => e.payload)).toEqual([
      { provider: "PLANDAY", integrationId: org.integrationId, status: "AUTH_ERROR" },
    ]);
    // CONNECTED ↔ SYNCING never produces one.
    events.length = 0;
    expectCleanPayloads();
  });

  it("is not published for CONNECTED ↔ SYNCING", async () => {
    await completeOnboarding(org);
    events.length = 0;
    await runSync(org);
    expect(integrationEvents().filter((e) => e.type === "integration.health.changed")).toEqual([]);
  });
});
