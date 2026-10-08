import { randomUUID } from "node:crypto";
import { prisma } from "@clockoff/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "@/lib/logger";
import { getEventBus, type RealtimeEvent } from "@/server/events";
import {
  createAdvisoryLockSession,
  lockSessionApplicationName,
  type AdvisoryLockSession,
} from "@/worker/advisoryLock";
import { slotOf } from "@/worker/jobRuns";
import { WORKER_JOBS, type WorkerJobName } from "@/worker/jobs";
import { createScheduler, type JobOutcome } from "@/worker/scheduler";
import { createTestDevice, createTestOrg } from "../helpers";

/**
 * The worker's jobs end to end against Postgres (D1, D2): manual runs, the override-expiry split, and two
 * workers firing the same minute — each job runs once per slot across instances.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const log = createLogger({ level: "silent" });
const JOB_NAMES = WORKER_JOBS.map((job) => job.name);

const sessions: AdvisoryLockSession[] = [];
function lockSession(name: string): AdvisoryLockSession {
  const session = createAdvisoryLockSession({
    connectionString: process.env.DATABASE_URL!,
    applicationName: lockSessionApplicationName(`jobs-${name}-${process.pid}`),
    log,
  });
  sessions.push(session);
  return session;
}

/** A quarter-hour instant (so the 15-minute integrations job is due too), at most 15 min ago. */
function quarterHour(): Date {
  return new Date(Math.floor(Date.now() / (15 * MINUTE)) * 15 * MINUTE + 1_000);
}

beforeEach(async () => {
  await prisma.workerJobRun.deleteMany();
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
});

describe("worker jobs", () => {
  it("runOnce runs every job under its lock and records the outcome without claiming a slot", async () => {
    const scheduler = createScheduler({ jobs: WORKER_JOBS, locks: lockSession("manual"), log });
    for (const name of JOB_NAMES) {
      const run = await scheduler.runOnce(name);
      expect(run.outcome, `${name}: ${JSON.stringify(run.result)}`).toBe("ok");
    }
    const rows = await prisma.workerJobRun.findMany({ orderBy: { job: "asc" } });
    expect(rows.map((r) => [r.job, r.lastOutcome, r.lastSlot])).toEqual(
      [...JOB_NAMES].sort().map((job) => [job, "ok", 0n]),
    );
    expect(rows.every((r) => r.lastOkAt !== null)).toBe(true);

    const sync = await scheduler.runOnce("integrations-sync");
    expect(sync.result?.details).toMatchObject({ reason: "NO_AVAILABLE_PROVIDER" });
  });

  it("work-mode-tick leaves expired overrides to override-expiry, which emits OVERRIDE_EXPIRED once", async () => {
    const now = new Date();
    const org = await createTestOrg();
    const { employee } = await createTestDevice(org.organisation.id);
    const override = await prisma.managerOverride.create({
      data: {
        organisationId: org.organisation.id,
        employeeId: employee.id,
        type: "EXEMPT_TEMPORARILY",
        reason: "cover",
        startsAt: new Date(now.getTime() - 2 * HOUR),
        expiresAt: new Date(now.getTime() - MINUTE),
      },
    });
    const seen: RealtimeEvent[] = [];
    const unsubscribe = getEventBus().subscribe(org.organisation.id, (e) => seen.push(e));
    const expiredEvents = () =>
      prisma.activityEvent.count({
        where: { organisationId: org.organisation.id, type: "OVERRIDE_EXPIRED" },
      });

    const scheduler = createScheduler({ jobs: WORKER_JOBS, locks: lockSession("split"), log });
    expect((await scheduler.runOnce("work-mode-tick", now)).outcome).toBe("ok");
    expect(
      (await prisma.managerOverride.findUniqueOrThrow({ where: { id: override.id } }))
        .expiredEventEmittedAt,
    ).toBeNull();
    expect(await expiredEvents()).toBe(0);

    expect((await scheduler.runOnce("override-expiry", now)).outcome).toBe("ok");
    expect(
      (await scheduler.runOnce("override-expiry", new Date(now.getTime() + MINUTE))).outcome,
    ).toBe("ok");
    expect(await expiredEvents()).toBe(1);
    expect(seen.filter((e) => e.type === "OVERRIDE_EXPIRED")).toHaveLength(1);
    unsubscribe();
  });

  it("two workers firing the same minute back to back run each job exactly once", async () => {
    const now = quarterHour();
    const first = createScheduler({ jobs: WORKER_JOBS, locks: lockSession("w1"), log });
    const second = createScheduler({ jobs: WORKER_JOBS, locks: lockSession("w2"), log });

    await first.onMinute(now);
    await second.onMinute(now);

    const outcomes = (scheduler: typeof first) =>
      Object.fromEntries(
        JOB_NAMES.map((name) => [name, scheduler.lastRuns()[name]?.outcome]),
      ) as Record<WorkerJobName, JobOutcome | undefined>;
    for (const name of JOB_NAMES) {
      expect([outcomes(first)[name], outcomes(second)[name]].sort(), name).toEqual([
        "ok",
        "skipped_already_ran",
      ]);
    }

    const rows = await prisma.workerJobRun.findMany();
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.lastSlot).toBe(slotOf(now));
      expect(row.lastOutcome).toBe("ok");
      expect(row.lastOkAt).not.toBeNull();
      expect(row.lastFinishedAt!.getTime()).toBeGreaterThanOrEqual(row.lastStartedAt.getTime());
    }

    // The next minute runs again (minute lane only: the integrations job is due every 15 minutes).
    await second.onMinute(new Date(now.getTime() + MINUTE));
    expect(second.lastRuns()["work-mode-tick"]?.outcome).toBe("ok");
    const tick = await prisma.workerJobRun.findUniqueOrThrow({ where: { job: "work-mode-tick" } });
    expect(tick.lastSlot).toBe(slotOf(now) + 1n);
    const sync = await prisma.workerJobRun.findUniqueOrThrow({
      where: { job: "integrations-sync" },
    });
    expect(sync.lastSlot).toBe(slotOf(now));
  });

  it("across two workers, schedule-upkeep never completes a shift before work-mode-tick swept its breaks", async () => {
    // Two workers in the same minute: one was skipped on work-mode-tick's lock and moved straight on to
    // schedule-upkeep while the other still ran work-mode-tick. A shift completed first would turn the
    // break's EXPIRED closure into SHIFT_ENDED (the old single tick always swept breaks first).
    const minute = Math.floor(Date.now() / MINUTE) * MINUTE;
    const org = await createTestOrg();
    const { employee } = await createTestDevice(org.organisation.id);
    const organisationId = org.organisation.id;
    async function shiftWithBreak(shiftEndsAt: number, breakEndsAt: number) {
      const shift = await prisma.shift.create({
        data: {
          organisationId,
          employeeId: employee.id,
          startsAt: new Date(shiftEndsAt - 2 * HOUR),
          endsAt: new Date(shiftEndsAt),
          timezone: "Europe/London",
        },
      });
      const session = await prisma.breakSession.create({
        data: {
          organisationId,
          employeeId: employee.id,
          shiftId: shift.id,
          startedAt: new Date(breakEndsAt - 15 * MINUTE),
          plannedEndsAt: new Date(breakEndsAt),
          clientBreakId: randomUUID(),
        },
      });
      return { shift, session };
    }
    // A: break and shift both ended during the previous minute (break 10 s before the shift).
    const a = await shiftWithBreak(minute - 20_000, minute - 30_000);
    // B: both end within this minute, after the tick's trigger time but before the upkeep's.
    const b = await shiftWithBreak(minute + 500, minute + 200);

    const only = (name: WorkerJobName) => WORKER_JOBS.filter((job) => job.name === name);
    const upkeepWorker = createScheduler({
      jobs: only("schedule-upkeep"),
      locks: lockSession("upkeep"),
      log,
    });
    const tickWorker = createScheduler({
      jobs: only("work-mode-tick"),
      locks: lockSession("tick"),
      log,
    });
    const shiftStatus = async (id: string) =>
      (await prisma.shift.findUniqueOrThrow({ where: { id } })).status;
    const closure = async (id: string) => {
      const row = await prisma.breakSession.findUniqueOrThrow({ where: { id } });
      return [row.status, row.endReason];
    };

    // The upkeep worker gets there first: it waits for this minute's work-mode-tick.
    await upkeepWorker.onMinute(new Date(minute + 1_000));
    expect(upkeepWorker.lastRuns()["schedule-upkeep"]?.outcome).toBe("skipped_waiting");
    expect(await shiftStatus(a.shift.id)).toBe("SCHEDULED");

    await tickWorker.onMinute(new Date(minute + 100));
    expect(tickWorker.lastRuns()["work-mode-tick"]?.outcome).toBe("ok");
    expect(await closure(a.session.id)).toEqual(["ENDED", "EXPIRED"]);
    expect(await closure(b.session.id)).toEqual(["ACTIVE", null]);

    // Now it runs, completing only shifts that ended by the start of its minute (B ended after the
    // tick's trigger time, so B's break has not been swept yet).
    await upkeepWorker.onMinute(new Date(minute + 1_000));
    expect(upkeepWorker.lastRuns()["schedule-upkeep"]?.outcome).toBe("ok");
    expect(await shiftStatus(a.shift.id)).toBe("COMPLETED");
    expect(await shiftStatus(b.shift.id)).toBe("SCHEDULED");

    await tickWorker.onMinute(new Date(minute + MINUTE + 100));
    expect(await closure(b.session.id)).toEqual(["ENDED", "EXPIRED"]);
    await upkeepWorker.onMinute(new Date(minute + MINUTE + 1_000));
    expect(await shiftStatus(b.shift.id)).toBe("COMPLETED");

    const events = await prisma.activityEvent.findMany({
      where: {
        organisationId,
        employeeId: employee.id,
        type: { in: ["BREAK_EXPIRED", "BREAK_ENDED"] },
      },
      select: { type: true },
    });
    expect(events.map((e) => e.type)).toEqual(["BREAK_EXPIRED", "BREAK_EXPIRED"]);
  });

  it("a job whose lock another worker holds is skipped_locked and leaves the slot unclaimed", async () => {
    const now = quarterHour();
    const holder = lockSession("holder");
    const tickJob = WORKER_JOBS.find((j) => j.name === "work-mode-tick")!;
    expect(await holder.tryAcquire(tickJob.lockKey)).toBe(true);

    const scheduler = createScheduler({ jobs: WORKER_JOBS, locks: lockSession("other"), log });
    await scheduler.onMinute(now);
    expect(scheduler.lastRuns()["work-mode-tick"]?.outcome).toBe("skipped_locked");
    expect(scheduler.lastRuns()["override-expiry"]?.outcome).toBe("ok");
    expect(await prisma.workerJobRun.findUnique({ where: { job: "work-mode-tick" } })).toBeNull();
  });
});
