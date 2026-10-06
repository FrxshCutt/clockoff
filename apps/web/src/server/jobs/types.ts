import type { Logger } from "@/lib/logger";

/**
 * Background job contracts (interface only — the scheduler, `/api/jobs/tick` and the concrete jobs
 * such as the Work Mode server job are owned by another engineer).
 *
 * Jobs must be idempotent: the minute scheduler and the HTTP tick endpoint may both fire.
 */
export interface JobContext {
  /** UTC instant the tick represents (not necessarily "now" when catching up). */
  now: Date;
  requestId: string;
  log: Logger;
  /** Aborts long-running jobs when the tick times out. */
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
