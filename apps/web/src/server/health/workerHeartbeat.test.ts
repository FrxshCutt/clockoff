import { describe, expect, it } from "vitest";
import {
  classifyWorkerHeartbeat,
  classifyWorkerJobs,
  WORKER_HEARTBEAT_STALE_AFTER_MS,
  type LiveWorkerDetails,
} from "./workerHeartbeat";

const now = new Date("2026-10-08T09:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const isoAgo = (ms: number) => ago(ms).toISOString();

describe("classifyWorkerHeartbeat", () => {
  it("is fresh up to 180 s and stale after", () => {
    expect(WORKER_HEARTBEAT_STALE_AFTER_MS).toBe(180_000);
    expect(classifyWorkerHeartbeat({ newestLiveBeatAt: now, hasStoppedRows: false }, now)).toBe(
      "fresh",
    );
    expect(
      classifyWorkerHeartbeat({ newestLiveBeatAt: ago(180_000), hasStoppedRows: false }, now),
    ).toBe("fresh");
    expect(
      classifyWorkerHeartbeat({ newestLiveBeatAt: ago(180_001), hasStoppedRows: true }, now),
    ).toBe("stale");
  });

  it("without live rows: stopped when a worker shut down gracefully, never otherwise", () => {
    expect(classifyWorkerHeartbeat({ newestLiveBeatAt: null, hasStoppedRows: false }, now)).toBe(
      "never",
    );
    expect(classifyWorkerHeartbeat({ newestLiveBeatAt: null, hasStoppedRows: true }, now)).toBe(
      "stopped",
    );
  });
});

describe("classifyWorkerJobs", () => {
  const running: LiveWorkerDetails = {
    jobsEnabled: true,
    waitingForMigrations: false,
    jobsStartedAt: isoAgo(30 * 60_000),
  };

  it.each<[string, { live: LiveWorkerDetails[]; lastTickOkAt: Date | null }, string]>([
    ["no live rows", { live: [], lastTickOkAt: now }, "unknown"],
    [
      "every live row has jobs disabled (even with a recent tick)",
      { live: [{ ...running, jobsEnabled: false }], lastTickOkAt: now },
      "disabled",
    ],
    [
      "one of two rows has jobs enabled",
      { live: [{ ...running, jobsEnabled: false }, running], lastTickOkAt: now },
      "ok",
    ],
    [
      "every live row waits for migrations",
      {
        live: [
          { jobsEnabled: true, waitingForMigrations: true, jobsStartedAt: null },
          { jobsEnabled: true, waitingForMigrations: true },
        ],
        lastTickOkAt: ago(60 * 60_000),
      },
      "waiting_for_migrations",
    ],
    [
      "disabled wins over waiting",
      {
        live: [{ jobsEnabled: false, waitingForMigrations: true }],
        lastTickOkAt: null,
      },
      "disabled",
    ],
    ["a tick succeeded within 180 s", { live: [running], lastTickOkAt: ago(180_000) }, "ok"],
    [
      "jobs started within 180 s, no successful tick yet",
      { live: [{ ...running, jobsStartedAt: isoAgo(60_000) }], lastTickOkAt: null },
      "starting",
    ],
    [
      "the newest jobsStartedAt counts",
      {
        live: [running, { ...running, jobsStartedAt: isoAgo(10_000) }],
        lastTickOkAt: ago(20 * 60_000),
      },
      "starting",
    ],
    [
      "the last success is 10 min old and jobs started 10 min ago",
      {
        live: [{ ...running, jobsStartedAt: isoAgo(10 * 60_000) }],
        lastTickOkAt: ago(10 * 60_000),
      },
      "stale",
    ],
    ["never succeeded, long running", { live: [running], lastTickOkAt: null }, "stale"],
    [
      "a malformed jobsStartedAt is ignored",
      { live: [{ ...running, jobsStartedAt: "not a date" }], lastTickOkAt: null },
      "stale",
    ],
  ])("%s", (_label, input, expected) => {
    expect(classifyWorkerJobs(input, now)).toBe(expected);
  });
});
