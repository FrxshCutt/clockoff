import type { Logger } from "@/lib/logger";

/**
 * Background job contracts. The worker process implements them (`src/worker/jobs.ts` defines the jobs,
 * `src/worker/scheduler.ts` runs them); the web process runs no jobs.
 *
 * Jobs must be idempotent: each run holds a Postgres advisory lock and claims its minute slot, but a lock
 * session lost mid-run, or a manual `node main.mjs run <job>`, can still overlap another run.
 */
export interface JobContext {
  /** UTC instant the tick represents (not necessarily "now" when catching up). */
  now: Date;
  requestId: string;
  log: Logger;
  /** Aborts long-running jobs (optional; the worker scheduler does not set it yet). */
  signal?: AbortSignal;
}

export interface JobResult {
  ok: boolean;
  /** Entities touched — for logs/metrics. */
  processed?: number;
  details?: Record<string, unknown>;
  error?: string;
}

export interface JobDefinition {
  /** Stable identifier, e.g. `work-mode-tick`. */
  name: string;
  /** Human description for status pages. */
  description?: string;
  run(ctx: JobContext): Promise<JobResult>;
}

export interface JobRunReport {
  startedAt: Date;
  finishedAt: Date;
  results: Array<{ name: string; durationMs: number; result: JobResult }>;
}

export interface JobRunner {
  register(job: JobDefinition): void;
  list(): readonly JobDefinition[];
  /** Run every registered job sequentially; a failing job never prevents the others. */
  runAll(ctx: Omit<JobContext, "log"> & { log?: Logger }): Promise<JobRunReport>;
  runOne(name: string, ctx: Omit<JobContext, "log"> & { log?: Logger }): Promise<JobRunReport>;
}
