import { prisma } from "@clockoff/db";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getWorkerHeartbeatStatus,
  markWorkerStopped,
  pruneWorkerHeartbeats,
  recordWorkerHeartbeat,
} from "@/server/health/workerHeartbeat";

/** `worker_heartbeats` writes and the `/api/health` worker block (D4, D11) against Postgres. */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function beat(instanceId: string, now: Date, details: Record<string, unknown> = {}) {
  return recordWorkerHeartbeat({
    instanceId,
    service: "worker",
    version: "0123456789ab",
    startedAt: new Date(now.getTime() - 5 * MINUTE),
    now,
    details: { jobsEnabled: true, waitingForMigrations: false, ...details },
  });
}

beforeEach(async () => {
  await prisma.workerHeartbeat.deleteMany();
  await prisma.workerJobRun.deleteMany();
});

describe("worker heartbeat", () => {
  it("reports never / unknown jobs with no rows", async () => {
    expect(await getWorkerHeartbeatStatus(new Date())).toEqual({
      status: "never",
      lastHeartbeatAt: null,
      ageSeconds: null,
      instances: 0,
      jobs: "unknown",
      lastSuccessfulTickAt: null,
    });
  });

  it("upserts one row per instance and clears stoppedAt on the next beat", async () => {
    const now = new Date();
    await beat("i-1", new Date(now.getTime() - MINUTE));
    await beat("i-1", now, { jobsStartedAt: now.toISOString() });
    await beat("i-2", now);
    expect(await prisma.workerHeartbeat.count()).toBe(2);

    await markWorkerStopped("i-1", now);
    let row = await prisma.workerHeartbeat.findUniqueOrThrow({ where: { instanceId: "i-1" } });
    expect(row.stoppedAt?.getTime()).toBe(now.getTime());
    expect(row.lastBeatAt.getTime()).toBe(now.getTime());
    expect((row.details as Record<string, unknown>).stoppedAt).toBe(now.toISOString());
    expect((row.details as Record<string, unknown>).jobsStartedAt).toBe(now.toISOString());

    await beat("i-1", new Date(now.getTime() + MINUTE));
    row = await prisma.workerHeartbeat.findUniqueOrThrow({ where: { instanceId: "i-1" } });
    expect(row.stoppedAt).toBeNull();
    expect(row.version).toBe("0123456789ab");
  });

  it("a late beat of the process that stopped the row never revives it; a later process start does", async () => {
    const now = new Date();
    const startedAt = new Date(now.getTime() - 5 * MINUTE);
    const record = (at: Date, processStartedAt: Date) =>
      recordWorkerHeartbeat({
        instanceId: "replica-1",
        service: "worker",
        version: null,
        startedAt: processStartedAt,
        now: at,
        details: { jobsEnabled: true },
      });
    expect(await record(now, startedAt)).toBe(true);
    await markWorkerStopped("replica-1", new Date(now.getTime() + 1_000));

    // A beat that was still in flight when the shutdown marked the row stopped commits afterwards.
    expect(await record(new Date(now.getTime() + 2_000), startedAt)).toBe(false);
    let row = await prisma.workerHeartbeat.findUniqueOrThrow({
      where: { instanceId: "replica-1" },
    });
    expect(row.stoppedAt?.getTime()).toBe(now.getTime() + 1_000);
    expect(row.lastBeatAt.getTime()).toBe(now.getTime());
    expect((await getWorkerHeartbeatStatus(new Date(now.getTime() + 3_000))).status).toBe(
      "stopped",
    );

    // Railway restarts the replica (same RAILWAY_REPLICA_ID, a new process start): live again.
    const restartedAt = new Date(now.getTime() + 10_000);
    expect(await record(new Date(now.getTime() + 11_000), restartedAt)).toBe(true);
    row = await prisma.workerHeartbeat.findUniqueOrThrow({ where: { instanceId: "replica-1" } });
    expect(row.stoppedAt).toBeNull();
    expect(row.startedAt.getTime()).toBe(restartedAt.getTime());
  });

  it("a gracefully stopped instance drops out of `instances` at once and never reads as fresh", async () => {
    const now = new Date();
    await beat("i-1", now, { jobsStartedAt: now.toISOString() });
    await beat("i-2", now, { jobsStartedAt: now.toISOString() });
    expect(await getWorkerHeartbeatStatus(now)).toMatchObject({
      status: "fresh",
      instances: 2,
      ageSeconds: 0,
      jobs: "starting",
    });

    await markWorkerStopped("i-1", now);
    expect(await getWorkerHeartbeatStatus(now)).toMatchObject({ status: "fresh", instances: 1 });

    await markWorkerStopped("i-2", now);
    expect(await getWorkerHeartbeatStatus(now)).toEqual({
      status: "stopped",
      lastHeartbeatAt: null,
      ageSeconds: null,
      instances: 0,
      jobs: "unknown",
      lastSuccessfulTickAt: null,
    });
  });

  it("goes stale after 180 s without a beat, and reports jobs from worker_job_runs", async () => {
    const now = new Date();
    await beat("i-1", new Date(now.getTime() - 10 * MINUTE), {
      jobsStartedAt: new Date(now.getTime() - 20 * MINUTE).toISOString(),
    });
    await prisma.workerJobRun.create({
      data: {
        job: "work-mode-tick",
        lastSlot: BigInt(Math.floor(now.getTime() / MINUTE) - 10),
        lastStartedAt: new Date(now.getTime() - 10 * MINUTE),
        lastFinishedAt: new Date(now.getTime() - 10 * MINUTE),
        lastOutcome: "ok",
        lastOkAt: new Date(now.getTime() - 10 * MINUTE),
      },
    });
    const stale = await getWorkerHeartbeatStatus(now);
    expect(stale).toMatchObject({ status: "stale", ageSeconds: 600, instances: 0, jobs: "stale" });
    expect(stale.lastSuccessfulTickAt).toBe(new Date(now.getTime() - 10 * MINUTE).toISOString());

    await beat("i-2", now, { jobsStartedAt: new Date(now.getTime() - 20 * MINUTE).toISOString() });
    await prisma.workerJobRun.update({ where: { job: "work-mode-tick" }, data: { lastOkAt: now } });
    expect(await getWorkerHeartbeatStatus(now)).toMatchObject({
      status: "fresh",
      instances: 1,
      jobs: "ok",
      lastSuccessfulTickAt: now.toISOString(),
    });
  });

  it("classifies jobs over the fresh rows, so a long-dead crashed row does not mask them", async () => {
    const now = new Date();
    await beat("crashed", new Date(now.getTime() - 2 * DAY), { jobsEnabled: true });
    await beat("current", now, { jobsEnabled: false });
    expect(await getWorkerHeartbeatStatus(now)).toMatchObject({
      status: "fresh",
      instances: 1,
      jobs: "disabled",
    });
    await beat("current", now, { waitingForMigrations: true });
    expect(await getWorkerHeartbeatStatus(now)).toMatchObject({ jobs: "waiting_for_migrations" });
  });

  it("prunes rows whose last beat is older than 7 days", async () => {
    const now = new Date();
    await beat("old", new Date(now.getTime() - 8 * DAY));
    await beat("recent", new Date(now.getTime() - 6 * DAY));
    expect(await pruneWorkerHeartbeats(now)).toBe(1);
    expect((await prisma.workerHeartbeat.findMany()).map((r) => r.instanceId)).toEqual(["recent"]);
  });
});
