import { Prisma, prisma } from "@clockoff/db";
import { beforeEach, describe, expect, it } from "vitest";
import { GET as healthRoute } from "@/app/api/health/route";
import { callRoute, type RouteResult } from "../helpers";

/**
 * GET /api/health: database + migrations decide the status code; the worker's heartbeat and job
 * progress (worker_heartbeats, worker_job_runs) and the realtime bus are reported in the body only, so a
 * stopped or stale worker never fails the web service's deploy health check.
 */

interface WorkerReport {
  status: string;
  lastHeartbeatAt: string | null;
  ageSeconds: number | null;
  instances: number;
  jobs: string;
  lastSuccessfulTickAt: string | null;
}

interface HealthBody {
  status: string;
  database: string;
  migrations: string;
  worker: WorkerReport;
  realtime: { mode: string; listening: boolean };
  time: string;
}

const MINUTE = 60_000;

async function health() {
  const res = await callRoute<HealthBody>(healthRoute, { path: "/api/health" });
  // The worker never changes the status code or the top-level status.
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ status: "ok", database: "ok", migrations: "up_to_date" });
  return res.body;
}

let seq = 0;

async function beat(input: {
  ageMs?: number;
  stoppedAgoMs?: number;
  details?: Record<string, unknown>;
}): Promise<string> {
  const now = Date.now();
  const instanceId = `health-test-${++seq}`;
  await prisma.workerHeartbeat.create({
    data: {
      instanceId,
      service: "worker",
      version: null,
      startedAt: new Date(now - 30 * MINUTE),
      lastBeatAt: new Date(now - (input.ageMs ?? 0)),
      stoppedAt: input.stoppedAgoMs === undefined ? null : new Date(now - input.stoppedAgoMs),
      details: (input.details ?? {}) as Prisma.InputJsonObject,
    },
  });
  return instanceId;
}

/** Details of a worker whose scheduler started `startedAgoMs` ago. */
function running(startedAgoMs: number): Record<string, unknown> {
  return {
    jobsEnabled: true,
    waitingForMigrations: false,
    jobsStartedAt: new Date(Date.now() - startedAgoMs).toISOString(),
  };
}

async function tickOk(agoMs: number): Promise<void> {
  const at = new Date(Date.now() - agoMs);
  await prisma.workerJobRun.create({
    data: {
      job: "work-mode-tick",
      lastSlot: BigInt(Math.floor(at.getTime() / MINUTE)),
      lastStartedAt: at,
      lastFinishedAt: at,
      lastOutcome: "ok",
      lastOkAt: at,
    },
  });
}

beforeEach(async () => {
  await prisma.workerJobRun.deleteMany();
  await prisma.workerHeartbeat.deleteMany();
});

describe("GET /api/health", () => {
  it("reports database, migrations, worker and realtime with exactly these keys", async () => {
    const body = await health();
    expect(Object.keys(body).sort()).toEqual([
      "database",
      "migrations",
      "realtime",
      "status",
      "time",
      "worker",
    ]);
    expect(Object.keys(body.worker).sort()).toEqual([
      "ageSeconds",
      "instances",
      "jobs",
      "lastHeartbeatAt",
      "lastSuccessfulTickAt",
      "status",
    ]);
    expect(Object.keys(body.realtime).sort()).toEqual(["listening", "mode"]);
    // Tests run without DIRECT_URL's LISTEN session: the bus is in-process.
    expect(body.realtime.mode).toBe("in_process");
    expect(typeof body.realtime.listening).toBe("boolean");
    expect(Number.isNaN(Date.parse(body.time))).toBe(false);
  });

  it("never: no heartbeat rows at all", async () => {
    const { worker } = await health();
    expect(worker).toEqual({
      status: "never",
      lastHeartbeatAt: null,
      ageSeconds: null,
      instances: 0,
      jobs: "unknown",
      lastSuccessfulTickAt: null,
    });
  });

  it("fresh + starting: a beat now from a worker whose scheduler just started", async () => {
    await beat({ details: running(10_000) });
    const { worker } = await health();
    expect(worker).toMatchObject({ status: "fresh", instances: 1, jobs: "starting" });
    expect(worker.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(worker.ageSeconds).toBeLessThan(10);
    expect(Date.now() - Date.parse(worker.lastHeartbeatAt!)).toBeLessThan(10_000);
    expect(worker.lastSuccessfulTickAt).toBeNull();
  });

  it("jobs ok: a successful work-mode-tick within 3 min", async () => {
    await beat({ details: running(30 * MINUTE) });
    await tickOk(20_000);
    const { worker } = await health();
    expect(worker).toMatchObject({ status: "fresh", instances: 1, jobs: "ok" });
    expect(Date.now() - Date.parse(worker.lastSuccessfulTickAt!)).toBeLessThan(30_000);
  });

  it("jobs stale: a fresh heartbeat but no successful tick for 10 min (a wedged job)", async () => {
    await beat({ details: running(10 * MINUTE) });
    await tickOk(10 * MINUTE);
    const { worker } = await health();
    expect(worker).toMatchObject({ status: "fresh", instances: 1, jobs: "stale" });
    expect(worker.lastSuccessfulTickAt).not.toBeNull();
  });

  it("jobs waiting_for_migrations: the worker is held by its migration gate", async () => {
    await beat({ details: { jobsEnabled: true, waitingForMigrations: true, jobsStartedAt: null } });
    const { worker } = await health();
    expect(worker).toMatchObject({ status: "fresh", jobs: "waiting_for_migrations" });
  });

  it("jobs disabled: every live worker runs with WORKER_JOBS_ENABLED=false", async () => {
    await beat({
      details: { jobsEnabled: false, waitingForMigrations: false, jobsStartedAt: null },
    });
    const { worker } = await health();
    expect(worker).toMatchObject({ status: "fresh", jobs: "disabled" });
  });

  it("stale: only a 10-minute-old live beat (the worker died without stopping)", async () => {
    await beat({ ageMs: 10 * MINUTE, details: running(40 * MINUTE) });
    const { worker } = await health();
    expect(worker).toMatchObject({ status: "stale", instances: 0 });
    expect(worker.ageSeconds).toBeGreaterThanOrEqual(600);
  });

  it("stopped: only a gracefully stopped worker, even with a fresh last beat", async () => {
    await beat({ ageMs: 5_000, stoppedAgoMs: 1_000, details: running(30 * MINUTE) });
    const { worker } = await health();
    expect(worker).toMatchObject({ status: "stopped", instances: 0 });
  });

  it("counts live instances only: two fresh workers and one stopped", async () => {
    await beat({ details: running(30 * MINUTE) });
    await beat({ ageMs: 30_000, details: running(30 * MINUTE) });
    await beat({ ageMs: 2_000, stoppedAgoMs: 1_000, details: running(30 * MINUTE) });
    await tickOk(5_000);
    const { worker } = await health();
    expect(worker).toMatchObject({ status: "fresh", instances: 2, jobs: "ok" });
  });

  it("answers 503 with an unknown worker when the database is unreachable", async () => {
    // Stubbed and put back by hand, not with vi.spyOn: Prisma's client is a proxy, and restoring a spy
    // on it leaves `$queryRaw` undefined on the shared singleton for every later test file in this fork.
    const original = prisma.$queryRaw;
    prisma.$queryRaw = (() =>
      Promise.reject(new Error("connect ECONNREFUSED"))) as unknown as typeof prisma.$queryRaw;
    let res: RouteResult<HealthBody>;
    try {
      res = await callRoute<HealthBody>(healthRoute, { path: "/api/health" });
    } finally {
      prisma.$queryRaw = original;
    }
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      status: "degraded",
      database: "unreachable",
      migrations: "unknown",
      worker: {
        status: "unknown",
        lastHeartbeatAt: null,
        ageSeconds: null,
        instances: 0,
        jobs: "unknown",
        lastSuccessfulTickAt: null,
      },
    });
    expect(Object.keys(res.body).sort()).toEqual([
      "database",
      "migrations",
      "realtime",
      "status",
      "time",
      "worker",
    ]);
  });

  it("reveals no instance id, version or hostname", async () => {
    const id = await beat({ details: running(10_000) });
    const res = await callRoute<HealthBody>(healthRoute, { path: "/api/health" });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(id);
    expect(text).not.toMatch(/version|hostname|instanceId/i);
  });
});
