import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { prisma } from "@clockoff/db";
import { afterEach, describe, expect, it } from "vitest";
import { lockSessionApplicationName } from "@/worker/advisoryLock";
import { LOCK_KEYS } from "@/worker/lockKeys";

/**
 * The real `serve` process (tsx, src/worker/main.ts) with its jobs switched off — the state where nothing
 * but unref'd timers and the database sockets kept the event loop alive. When the database drops the
 * worker's direct sessions (a Neon compute restart, a network blip), the worker must stay up and
 * reconnect: exiting 0 would never be restarted by Railway's ON_FAILURE policy, and push bridging would
 * stop for every organisation. Then SIGTERM still shuts it down cleanly (exit 0).
 */

const WEB_DIR = path.resolve(import.meta.dirname, "../..");
const TEST_TIMEOUT_MS = 120_000;

interface LogLine {
  msg?: string;
  [key: string]: unknown;
}

let child: ChildProcess | null = null;
let instanceId: string | null = null;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  child = null;
  if (instanceId) await prisma.workerHeartbeat.deleteMany({ where: { instanceId } });
  instanceId = null;
});

async function waitFor<T>(
  what: string,
  check: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  timeoutMs: number,
  describeState: () => string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${describeState()}`);
    await sleep(200);
  }
}

describe("worker liveness", () => {
  it(
    "with WORKER_JOBS_ENABLED=false, survives the database dropping its sessions, reconnects, and still exits 0 on SIGTERM",
    async () => {
      const tag = randomUUID().slice(0, 8);
      instanceId = `itest-liveness-${tag}`;
      const service = `itest-${tag}`;
      const lockApp = lockSessionApplicationName(instanceId);
      const eventsApp = `clockoff-${service}-events`;
      const url = process.env.DATABASE_URL!; // the test database (setup.ts)

      const lines: LogLine[] = [];
      const stderr: string[] = [];
      let buffered = "";
      child = spawn(process.execPath, ["--import", "tsx", "src/worker/main.ts", "serve"], {
        cwd: WEB_DIR,
        env: {
          ...process.env,
          NODE_ENV: "development", // the Postgres event bus (tests otherwise get the in-process one)
          DATABASE_URL: url,
          DIRECT_URL: url,
          WORKER_JOBS_ENABLED: "false",
          JOBS_ENABLED: "",
          LOG_LEVEL: "info",
          LOG_SERVICE_NAME: "clockoff-worker",
          RAILWAY_REPLICA_ID: instanceId,
          RAILWAY_SERVICE_NAME: service,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        buffered += chunk;
        const parts = buffered.split("\n");
        buffered = parts.pop() ?? "";
        for (const part of parts) {
          try {
            lines.push(JSON.parse(part) as LogLine);
          } catch {
            lines.push({ msg: part });
          }
        }
      });
      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (chunk: string) => stderr.push(chunk));
      const exited = new Promise<number | null>((resolve) => child!.once("exit", resolve));
      const messages = () => lines.map((line) => String(line.msg));
      const count = (msg: string) => messages().filter((m) => m === msg).length;
      const state = () =>
        `exit=${String(child?.exitCode)} log:\n${messages().join("\n")}\nstderr:\n${stderr.join("")}`;

      const admin = new pg.Client({ connectionString: url });
      await admin.connect();
      try {
        const backends = async () =>
          (
            await admin.query<{ pid: number; application_name: string }>(
              "SELECT pid, application_name FROM pg_stat_activity WHERE application_name = ANY($1::text[])",
              [[lockApp, eventsApp]],
            )
          ).rows;
        const leaseHolder = async () =>
          (
            await admin.query<{ pid: number }>(
              "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND ((classid::bigint << 32) | objid::bigint) = $1::bigint",
              [LOCK_KEYS.pushLeader.toString()],
            )
          ).rows[0]?.pid;

        // Up: listening, leading the push bridge (jobs off).
        await waitFor(
          "the worker to listen and lead the push bridge",
          () =>
            count("realtime listener started") === 1 && count("push bridge leader acquired") === 1,
          60_000,
          state,
        );
        expect(messages()).toContain(
          "WORKER_JOBS_ENABLED=false: no jobs will run (heartbeat and push leadership continue)",
        );
        const before = await backends();
        expect(before.map((b) => b.application_name).sort()).toEqual([eventsApp, lockApp].sort());
        const lockPid = before.find((b) => b.application_name === lockApp)!.pid;
        expect(await leaseHolder()).toBe(lockPid);

        // The database drops both direct sessions.
        const terminated = await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = ANY($1::text[])",
          [[lockApp, eventsApp]],
        );
        expect(terminated.rowCount).toBe(2);

        // Still running, listening again and leading again on NEW backends.
        await waitFor(
          "the worker to reconnect and lead again",
          async () => {
            if (child?.exitCode !== null) throw new Error(`the worker exited\n${state()}`);
            const now = await backends();
            const newLock = now.find((b) => b.application_name === lockApp);
            const newEvents = now.find((b) => b.application_name === eventsApp);
            if (!newLock || !newEvents || newLock.pid === lockPid) return false;
            return (
              (await leaseHolder()) === newLock.pid &&
              count("realtime listener reconnected") >= 1 &&
              count("push bridge leader acquired") >= 2
            );
          },
          30_000,
          state,
        );
        expect(child.exitCode).toBeNull();
        expect(messages()).toContain("advisory lock session lost");
        expect(messages()).toContain("push bridge leadership lost");
        expect(messages()).not.toContain(
          "worker event loop drained unexpectedly; exiting so the platform restarts it",
        );

        // A graceful stop still exits 0 and marks the row stopped.
        child.kill("SIGTERM");
        const code = await Promise.race([exited, sleep(30_000).then(() => "timeout" as const)]);
        expect(code, state()).toBe(0);
        expect(messages()).toContain("worker stopped");
        const row = await prisma.workerHeartbeat.findUniqueOrThrow({ where: { instanceId } });
        expect(row.stoppedAt).not.toBeNull();
      } finally {
        await admin.end();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
