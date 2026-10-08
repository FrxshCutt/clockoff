/**
 * Railway infrastructure as code for ClockOff (docs/DEPLOYMENT.md): project `clockoff`, environment
 * `production`, services `web` (Next.js), `worker` (background jobs) and `www` (www → apex redirect: the Hobby
 * plan allows two custom domains per service), all built from this repository's `main` branch with the
 * Dockerfiles in docker/. Railway retired per-service config files (railway.json) for
 * new services, so this file is what the platform applies; the per-service build and deploy settings stay in
 * railway/{web,worker,www}.json (pinned by apps/web/src/deploy/railwayConfig.test.ts) and are
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
import wwwConfig from "../railway/www.json" with { type: "json" };

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
  // Planday (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md appendix A): the release and kill switch, mock or
  // live mode (mock is refused in production) and the Beta clock-in mode. Unset = off / live / off.
  "PLANDAY_CLOCK_MODE_ENABLED",
  "PLANDAY_ENABLED",
  "PLANDAY_MODE",
  "RATE_LIMIT_BACKEND",
  "RESEND_API_KEY",
  "SESSION_SECRET",
  "SESSION_TTL_DAYS",
  "SHUTDOWN_GRACE_MS",
  "TEST_TOOLS_ORGANISATION_IDS",
  "TRUSTED_PROXY_HOPS",
];
/**
 * Web only. PLANDAY_CLIENT_ID (method A, OAuth) and PLANDAY_APP_ID (method B) are ClockOff's Planday App IDs
 * and PLANDAY_OAUTH_PKCE turns on PKCE for method A; the worker never reads them (every connection stores its own
 * encrypted client id).
 */
const WEB_VARIABLES = [
  ...SHARED_VARIABLES,
  "PLANDAY_APP_ID",
  "PLANDAY_CLIENT_ID",
  "PLANDAY_OAUTH_PKCE",
  "PORT",
  "REALTIME_STREAM_MAX_LIFETIME_MS",
];
const WORKER_VARIABLES = [...SHARED_VARIABLES, "WORKER_JOBS_ENABLED"];

const preserved = (names: string[]) => Object.fromEntries(names.map((name) => [name, preserve()]));

type ServiceFile = typeof webConfig | typeof workerConfig | typeof wwwConfig;

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
  const www = service("www", {
    source,
    build: wwwConfig.build,
    deploy: deployOf(wwwConfig),
    replicas: { [REGION]: wwwConfig.deploy.numReplicas },
    // Not secrets: the redirect target and the port the www.clockoff.online custom domain targets.
    env: { REDIRECT_TO: "https://clockoff.online", PORT: "8080" },
  });
  return project("clockoff", { resources: [web, worker, www] });
});
