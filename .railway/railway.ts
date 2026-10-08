/**
 * Railway infrastructure as code for ClockOff (docs/DEPLOYMENT.md): project `clockoff`, environment
 * `production`, services `web` (Next.js) and `worker` (background jobs), both built from this repository's
 * `main` branch with the Dockerfiles in docker/. Railway retired per-service config files (railway.json) for
 * new services, so this file is what the platform applies; the per-service build and deploy settings stay in
 * railway/web.json and railway/worker.json (pinned by apps/web/src/deploy/railwayConfig.test.ts) and are
 * read from there.
 *
 *   railway config plan     # preview — never changes Railway
 *   railway config apply    # apply after reviewing the plan
 *
 * Variables: values live in Railway (dashboard or `railway variables --set`), never in this repository.
 * Every name below is `preserve()`d — a variable missing from these lists is DELETED by the next apply, so add
 * a new variable's name here in the same change that starts reading it.
 */
import { defineRailway, github, preserve, project, service } from "railway/iac";
import webConfig from "../railway/web.json" with { type: "json" };
import workerConfig from "../railway/worker.json" with { type: "json" };

/** EU West (Amsterdam); the Neon database is in London (aws-eu-west-2). */
const REGION = "europe-west4-drams3a";

/** Read by both processes: apps/web/src/lib/env.ts validates the same schema in web and worker. */
const SHARED_VARIABLES = [
  "APP_URL",
  "CLIENT_IP_HEADER",
  "DATABASE_URL",
  "DEV_TOOLS_ENABLED",
  "DIRECT_URL",
  "EMAIL_FROM",
  "EMAIL_PROVIDER",
  "HOST_ROUTING",
  "INTEGRATION_ENCRYPTION_KEY",
  "LOG_LEVEL",
  "MARKETING_URL",
  "MOBILE_JWT_KEY_ID",
  "MOBILE_JWT_SECRET",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_TELEMETRY_DISABLED",
  "RATE_LIMIT_BACKEND",
  "RESEND_API_KEY",
  "SESSION_SECRET",
  "SESSION_TTL_DAYS",
  "SHUTDOWN_GRACE_MS",
  "TEST_TOOLS_ORGANISATION_IDS",
  "TRUSTED_PROXY_HOPS",
];
const WEB_VARIABLES = [...SHARED_VARIABLES, "PORT", "REALTIME_STREAM_MAX_LIFETIME_MS"];
const WORKER_VARIABLES = [...SHARED_VARIABLES, "WORKER_JOBS_ENABLED"];

const preserved = (names: string[]) => Object.fromEntries(names.map((name) => [name, preserve()]));

type ServiceFile = typeof webConfig | typeof workerConfig;

/** railway.json's deploy block in IaC form: replicas are set per region, preDeployCommand is a list. */
function deployOf(file: ServiceFile) {
  const { numReplicas: _replicas, ...deploy } = file.deploy as ServiceFile["deploy"] & {
    preDeployCommand?: string;
  };
  return {
    ...deploy,
    ...("preDeployCommand" in deploy && deploy.preDeployCommand
      ? { preDeployCommand: [deploy.preDeployCommand] }
      : {}),
  };
}

export default defineRailway(() => {
  const source = github("FrxshCutt/clockoff", { branch: "main" });
  const web = service("web", {
    source,
    build: webConfig.build,
    deploy: deployOf(webConfig),
    replicas: { [REGION]: webConfig.deploy.numReplicas },
    env: preserved(WEB_VARIABLES),
  });
  const worker = service("worker", {
    source,
    build: workerConfig.build,
    deploy: deployOf(workerConfig),
    replicas: { [REGION]: workerConfig.deploy.numReplicas },
    env: preserved(WORKER_VARIABLES),
  });
  return project("clockoff", { resources: [web, worker] });
});
