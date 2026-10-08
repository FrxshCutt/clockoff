-- Background worker runtime (Railway worker service). Additive only: safe for the previous web and
-- worker deployments, which never read these tables.
--   worker_heartbeats: one row per worker process, upserted every minute; GET /api/health reports the
--     newest live (stopped_at IS NULL) beat. A graceful shutdown sets stopped_at and leaves last_beat_at.
--   worker_job_runs: the last scheduled minute slot claimed per job, so a slot runs at most once across
--     worker instances (claimed inside the job's advisory lock), plus the outcome of the last run.

-- CreateTable
CREATE TABLE "worker_heartbeats" (
    "instance_id" VARCHAR(128) NOT NULL,
    "service" VARCHAR(64) NOT NULL,
    "version" VARCHAR(64),
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "last_beat_at" TIMESTAMPTZ(6) NOT NULL,
    "stopped_at" TIMESTAMPTZ(6),
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("instance_id")
);

-- CreateTable
CREATE TABLE "worker_job_runs" (
    "job" VARCHAR(64) NOT NULL,
    "last_slot" BIGINT NOT NULL,
    "last_started_at" TIMESTAMPTZ(6) NOT NULL,
    "last_finished_at" TIMESTAMPTZ(6),
    "last_outcome" VARCHAR(32),
    "last_ok_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "worker_job_runs_pkey" PRIMARY KEY ("job")
);

-- CreateIndex
CREATE INDEX "worker_heartbeats_last_beat_at_idx" ON "worker_heartbeats"("last_beat_at" DESC);
