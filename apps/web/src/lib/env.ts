import { z } from "zod";

/**
 * Typed, validated process environment.
 *
 * `env()` parses `process.env` lazily on first call and caches the result, so importing this module
 * never requires secrets to be present (Next.js evaluates route modules at build time). Call
 * `resetEnvCache()` in tests after mutating `process.env`.
 *
 * Every variable is documented in `.env.example`. Empty strings are treated as "unset" so that the
 * commented template (`SMTP_HOST=""`) parses cleanly.
 */

const booleanString = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `"id1, id2"` → `["id1", "id2"]` (trimmed, lowercased, blanks dropped); every entry must be a UUID. */
const uuidListString = z
  .string()
  .transform((v) =>
    v
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter((id) => id !== ""),
  )
  .pipe(
    z.array(
      z.string().regex(UUID, { message: "must be a comma-separated list of organisation UUIDs" }),
    ),
  );

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const base64Key32 = z.string().refine(
  (v) => {
    try {
      return Buffer.from(v, "base64").length === 32;
    } catch {
      return false;
    }
  },
  { message: "must be 32 random bytes encoded as base64 (e.g. `openssl rand -base64 32`)" },
);

/**
 * SHUTDOWN_GRACE_MS's maximum: the longest grace that still fits both Railway draining periods (web
 * 30 s; worker 60 s minus its ~21 s of fixed shutdown steps). Raise it only together with those.
 */
export const SHUTDOWN_GRACE_MAX_MS = 25_000;

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Database
  /** Prisma's connection. Production: Neon's POOLED (PgBouncer, transaction mode) URL. */
  DATABASE_URL: z.url({ message: "must be a postgresql:// connection string" }),
  /**
   * The DIRECT (non-pooled) connection, read at runtime by every process: the realtime LISTEN session
   * (server/events) and the worker's advisory-lock session need a real Postgres session, which
   * PgBouncer's transaction mode cannot give (LISTEN receives nothing, session locks leak across pooled
   * backends). Also used by `prisma migrate` (migrate.sh). Unset: realtime stays in-process (tests, dev
   * without Postgres) and the production worker refuses to start. A pooled URL here is rejected in
   * production by parseEnv ({@link isPooledPostgresUrl}).
   */
  DIRECT_URL: z.url({ message: "must be a postgresql:// connection string" }).optional(),
  TEST_DATABASE_URL: z.url().optional(),

  // App URLs
  APP_URL: z.url({
    message: "must be the public origin of the web app, e.g. http://localhost:3000",
  }),
  NEXT_PUBLIC_APP_URL: z.url().optional(),

  // Manager auth
  SESSION_SECRET: z.string().min(32, "must be at least 32 characters (64 hex chars recommended)"),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  REQUIRE_EMAIL_VERIFICATION: booleanString.optional(),

  // Mobile auth
  MOBILE_JWT_SECRET: z
    .string()
    .min(32, "must be at least 32 characters (64 hex chars recommended)"),
  MOBILE_JWT_KEY_ID: z.string().min(1).max(32).default("v1"),
  MOBILE_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  MOBILE_REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(60),

  // Encryption at rest
  INTEGRATION_ENCRYPTION_KEY: base64Key32,

  // Email
  /**
   * `console` (development: logs links), `resend` (production: Resend HTTP API, needs RESEND_API_KEY;
   * required in production by parseEnv) or `smtp` (not implemented yet).
   */
  EMAIL_PROVIDER: z.enum(["console", "smtp", "resend"]).default("console"),
  EMAIL_FROM: z.string().min(3).default("ClockOff <noreply@clockoff.local>"),
  /** Resend API key (`re_…`), sending access is enough. Read only when EMAIL_PROVIDER=resend. */
  RESEND_API_KEY: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),

  // Push (APNs)
  APNS_KEY_ID: z.string().optional(),
  APNS_TEAM_ID: z.string().optional(),
  APNS_P8_BASE64: z.string().optional(),
  APNS_BUNDLE_ID: z.string().default("online.clockoff.app"),
  APNS_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),

  // Rate limiting
  RATE_LIMIT_BACKEND: z.enum(["memory", "redis"]).default("memory"),
  REDIS_URL: z.string().optional(),
  /**
   * Number of reverse proxies in front of the app that APPEND to `X-Forwarded-For`. The client IP is
   * the entry this many hops from the right (default 1: the address our own proxy saw). Entries further
   * left are client-supplied and never trusted. See docs/SECURITY.md.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(1).max(10).default(1),
  /**
   * A header the hosting platform's edge always sets (overwriting anything the client sent) to the true
   * client IP. When set and present it wins over X-Forwarded-For; its first comma-separated entry is
   * the client. Railway: `x-real-ip` (documented as the client's remote IP; client-supplied values are
   * replaced at the edge). `x-forwarded-for` is the alternative there (its leftmost entry, because
   * Railway's edge rewrites that header too) if `x-real-ip` turns out to carry a CDN address. Never a
   * header the edge does not overwrite: the value would be client-chosen and so would every per-IP rate
   * limit. parseEnv rejects Netlify's `x-nf-*` headers in production, and on Railway any header other
   * than those two. Empty: the X-Forwarded-For entry TRUSTED_PROXY_HOPS from the right.
   */
  CLIENT_IP_HEADER: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]*$/i)
    .default("")
    .transform((v) => v.toLowerCase()),

  // Jobs
  /**
   * Kill switch read only by the worker process (`src/worker`; the web process never runs jobs):
   * `false` → no jobs run, while the heartbeat and push-bridge leadership continue (`/api/health`
   * reports `worker.jobs: "disabled"`).
   */
  WORKER_JOBS_ENABLED: booleanString.default(true),
  /**
   * RETIRED (Netlify era: "false" meant "the scheduled function runs the tick, not node-cron"). Never a
   * switch any more: parseEnv warns while it is set, and the worker refuses to start while it is
   * "false" (a value copied from the Netlify site must not silently turn every job off). Remove it.
   */
  JOBS_ENABLED: booleanString.optional(),

  // Long-running server
  /**
   * How long one realtime SSE stream stays open before the server ends it with a planned `reconnect`
   * frame (the client reconnects at once). A stream authenticates once, so this also bounds how long a
   * revoked session keeps streaming. 10 s–14 min, under the hosting platform's request cap.
   */
  REALTIME_STREAM_MAX_LIFETIME_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(840_000)
    .default(300_000),
  /**
   * Upper bound for a graceful shutdown after SIGTERM: the web process exits 0 by then even if
   * requests are still open; the worker abandons jobs still running after it (their locks die with
   * the lock session), then needs up to ~21 s more for its fixed shutdown steps. So: web grace <
   * web drainingSeconds, worker grace + 21 s ≤ worker drainingSeconds (railway/*.json; checked by
   * src/deploy/railwayConfig.test.ts up to the maximum, {@link SHUTDOWN_GRACE_MAX_MS}).
   */
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(1_000).max(SHUTDOWN_GRACE_MAX_MS).default(20_000),

  // Logging
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),

  // Dev
  DEV_TOOLS_ENABLED: booleanString.default(false),
  /**
   * Organisations (comma-separated ids) that get the phone test tools — "Create test shift…" on the
   * dashboard and `POST /api/test-tools/test-shift` — in any environment, production included. Every
   * organisation gets them while DEV_TOOLS_ENABLED=true. Production lists only the internal test
   * organisation ("ClockOff Test", created by apps/web/scripts/setup-test-organisation.ts).
   */
  TEST_TOOLS_ORGANISATION_IDS: uuidListString.optional(),
});

type RawEnv = z.infer<typeof envSchema>;

export interface Env extends Omit<
  RawEnv,
  "REQUIRE_EMAIL_VERIFICATION" | "NEXT_PUBLIC_APP_URL" | "TEST_TOOLS_ORGANISATION_IDS"
> {
  /** Resolved: explicit value, otherwise `true` in production and `false` elsewhere. */
  REQUIRE_EMAIL_VERIFICATION: boolean;
  NEXT_PUBLIC_APP_URL: string;
  /** Lowercased organisation ids with the test tools (empty when unset). See {@link testToolsEnabledFor}. */
  TEST_TOOLS_ORGANISATION_IDS: readonly string[];
  /** `new URL(APP_URL).origin` — used for CSRF origin checks and absolute links. */
  APP_ORIGIN: string;
  isProduction: boolean;
  isTest: boolean;
  isDevelopment: boolean;
}

let cached: Env | undefined;
let cachedWarnings: string[] = [];

function stripEmpty(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && value.trim() !== "") out[key] = value;
  }
  return out;
}

/**
 * Sender domains Resend can never verify: the `.local` development default and the reserved
 * `localhost` / `.test` / `.example` / `.invalid` names (RFC 2606, RFC 6761).
 */
const UNVERIFIABLE_SENDER_DOMAIN = /(?:^|\.)(?:local|localhost|test|example|invalid)$/i;

/**
 * The address in an `EMAIL_FROM` value (`noreply@example.com` or `Name <noreply@example.com>`), or
 * undefined when it holds no usable address (Resend rejects such a sender on every send).
 */
function senderAddress(from: string): string | undefined {
  const trimmed = from.trim();
  const bracketed = /<([^<>]*)>$/.exec(trimmed);
  const address = (bracketed ? bracketed[1]! : trimmed).trim();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address) ? address : undefined;
}

/**
 * Resend settings that make every send fail. Each problem is a hard error in production (a deploy
 * that cannot send verification / reset / invite emails must fail loudly) and a warning elsewhere.
 * Each message reads as a sentence with " in production" appended, and never contains the key or the
 * sender address.
 */
function resendProblems(raw: RawEnv): string[] {
  if (raw.EMAIL_PROVIDER !== "resend") return [];
  const problems: string[] = [];
  const key = raw.RESEND_API_KEY?.trim();
  if (!key) {
    problems.push("RESEND_API_KEY is required when EMAIL_PROVIDER=resend");
  } else if (/[\s\p{Cc}]/u.test(key)) {
    problems.push(
      "RESEND_API_KEY must not contain whitespace or control characters when EMAIL_PROVIDER=resend",
    );
  }
  const address = senderAddress(raw.EMAIL_FROM);
  if (!address) {
    problems.push(
      "EMAIL_FROM must be `address@domain` or `Name <address@domain>` when EMAIL_PROVIDER=resend",
    );
  } else if (UNVERIFIABLE_SENDER_DOMAIN.test(address.slice(address.lastIndexOf("@") + 1))) {
    problems.push(
      "EMAIL_FROM must use a domain verified in Resend, not .local / .localhost / .test / .example / .invalid, when EMAIL_PROVIDER=resend",
    );
  }
  return problems;
}

/** Whether the process runs on Railway (variables Railway injects into every deployment). */
function isRailway(source: Readonly<Record<string, string | undefined>>): boolean {
  return ["RAILWAY_ENVIRONMENT_ID", "RAILWAY_PROJECT_ID", "RAILWAY_ENVIRONMENT_NAME"].some((key) =>
    Boolean(source[key]?.trim()),
  );
}

/** Client-IP headers Railway's edge sets on every request, replacing client-supplied values. */
export const RAILWAY_CLIENT_IP_HEADERS: readonly string[] = ["x-real-ip", "x-forwarded-for"];

/**
 * CLIENT_IP_HEADER values that would let a client choose its own rate-limit identity: a Netlify edge
 * header (`x-nf-…`, set by nothing once the app left Netlify), and on Railway any header its edge does
 * not overwrite. Messages never contain anything but the variable and header names.
 */
function clientIpHeaderProblems(header: string, onRailway: boolean): string[] {
  if (!header) return [];
  if (header.startsWith("x-nf-")) {
    return [
      `CLIENT_IP_HEADER="${header}" is a Netlify edge header: no proxy sets it any more, so clients could pick their own rate-limit identity (use "x-real-ip" on Railway, or leave it empty)`,
    ];
  }
  if (onRailway && !RAILWAY_CLIENT_IP_HEADERS.includes(header)) {
    return [
      `CLIENT_IP_HEADER="${header}" is not set by Railway's edge, so clients could pick their own rate-limit identity (use "x-real-ip", or leave it empty)`,
    ];
  }
  return [];
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return ` - ${path}: ${issue.message}`;
    })
    .join("\n");
}

/** Parse an arbitrary env object (exported for tests). Throws a descriptive Error on failure. */
export function parseEnv(source: Readonly<Record<string, string | undefined>>): {
  env: Env;
  warnings: string[];
} {
  const result = envSchema.safeParse(stripEmpty(source));
  if (!result.success) {
    throw new Error(
      `Invalid environment configuration:\n${formatIssues(result.error)}\n` +
        "Copy .env.example to .env (or run `pnpm setup:env`) and fill in the missing values.",
    );
  }
  const raw = result.data;
  const isProduction = raw.NODE_ENV === "production";
  const warnings: string[] = [];

  if (isProduction && raw.DEV_TOOLS_ENABLED) {
    throw new Error(
      "Invalid environment configuration:\n - DEV_TOOLS_ENABLED must not be true in production",
    );
  }
  if (isProduction && raw.EMAIL_PROVIDER === "console") {
    warnings.push(
      "EMAIL_PROVIDER=console in production: verification/reset emails will only be logged.",
    );
  }
  if (raw.EMAIL_PROVIDER === "smtp" && (!raw.SMTP_HOST || !raw.SMTP_USER || !raw.SMTP_PASSWORD)) {
    warnings.push("EMAIL_PROVIDER=smtp but SMTP_HOST / SMTP_USER / SMTP_PASSWORD are incomplete.");
  }
  const emailProblems = resendProblems(raw);
  if (emailProblems.length > 0) {
    // Hard error in production: fail loudly at first use instead of silently dropping every message.
    if (isProduction) {
      throw new Error(
        `Invalid environment configuration:\n${emailProblems.map((p) => ` - ${p} in production`).join("\n")}`,
      );
    }
    for (const problem of emailProblems) warnings.push(`${problem}: every email send will fail.`);
  }
  if (isProduction && raw.SESSION_SECRET === raw.MOBILE_JWT_SECRET) {
    throw new Error(
      "Invalid environment configuration:\n - SESSION_SECRET and MOBILE_JWT_SECRET must be different secrets in production",
    );
  }
  if (raw.DIRECT_URL && isPooledPostgresUrl(raw.DIRECT_URL)) {
    // Never echo the URL: it carries the database password.
    if (isProduction) {
      throw new Error(
        "Invalid environment configuration:\n - DIRECT_URL must be the direct (non-pooled) connection string in production",
      );
    }
    warnings.push(
      "DIRECT_URL looks like a pooled (PgBouncer) connection string: realtime LISTEN receives nothing and worker advisory locks leak across pooled backends. Use the direct (non-pooled) URL.",
    );
  }
  if (isProduction && !raw.DIRECT_URL) {
    warnings.push(
      "DIRECT_URL is not set in production: realtime events stay inside this process (no Postgres LISTEN/NOTIFY) and the worker refuses to start.",
    );
  }
  for (const problem of clientIpHeaderProblems(raw.CLIENT_IP_HEADER, isRailway(source))) {
    // A client-chosen rate-limit identity bypasses every per-IP limit: fatal in production.
    if (isProduction) throw new Error(`Invalid environment configuration:\n - ${problem}`);
    warnings.push(problem);
  }
  if (raw.JOBS_ENABLED !== undefined) {
    warnings.push(
      raw.JOBS_ENABLED
        ? "JOBS_ENABLED is retired and ignored (the worker's switch is WORKER_JOBS_ENABLED): remove it."
        : "JOBS_ENABLED=false is a retired Netlify-era setting: the worker refuses to start while it is set. Remove it (WORKER_JOBS_ENABLED=false is the kill switch).",
    );
  }
  if (source.CRON_SECRET?.trim()) {
    warnings.push("CRON_SECRET is no longer used (the worker runs the jobs): remove it.");
  }
  if (raw.RATE_LIMIT_BACKEND === "redis" && !raw.REDIS_URL) {
    throw new Error(
      "Invalid environment configuration:\n - REDIS_URL is required when RATE_LIMIT_BACKEND=redis",
    );
  }
  if (isProduction && !raw.APP_URL.startsWith("https://")) {
    warnings.push("APP_URL should use https:// in production (session cookies are marked Secure).");
  }

  const env: Env = {
    ...raw,
    REQUIRE_EMAIL_VERIFICATION: raw.REQUIRE_EMAIL_VERIFICATION ?? isProduction,
    NEXT_PUBLIC_APP_URL: raw.NEXT_PUBLIC_APP_URL ?? raw.APP_URL,
    TEST_TOOLS_ORGANISATION_IDS: [...new Set(raw.TEST_TOOLS_ORGANISATION_IDS ?? [])],
    APP_ORIGIN: new URL(raw.APP_URL).origin,
    isProduction,
    isTest: raw.NODE_ENV === "test",
    isDevelopment: raw.NODE_ENV === "development",
  };
  return { env, warnings };
}

/**
 * Whether a Postgres connection string goes through a connection pooler (PgBouncer), judged by the
 * conventions Neon and Prisma use: a `-pooler.` host (`ep-…-pooler.<region>.aws.neon.tech`) or the
 * `pgbouncer=true` query flag. LISTEN and session-level advisory locks do not work through such a URL.
 * An unparsable string is judged on its raw text.
 */
export function isPooledPostgresUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      /-pooler\./i.test(parsed.hostname) ||
      parsed.searchParams.get("pgbouncer")?.trim().toLowerCase() === "true"
    );
  } catch {
    return /-pooler\./i.test(url) || /[?&]pgbouncer=true(?:&|$)/i.test(url);
  }
}

/** Validated environment. Parsed once; throws a readable error listing every problem. */
export function env(): Env {
  if (!cached) {
    const parsed = parseEnv(process.env);
    cached = parsed.env;
    cachedWarnings = parsed.warnings;
  }
  return cached;
}

/** Non-fatal configuration warnings collected during the last parse (empty until `env()` ran). */
export function envWarnings(): readonly string[] {
  return cachedWarnings;
}

/** Forget the cached environment (tests only; call after mutating `process.env`). */
export function resetEnvCache(): void {
  cached = undefined;
  cachedWarnings = [];
}

/**
 * Whether the phone test tools are available to `organisationId`: DEV_TOOLS_ENABLED=true (never in
 * production — parseEnv refuses it), or the organisation is listed in TEST_TOOLS_ORGANISATION_IDS.
 */
export function testToolsEnabledFor(organisationId: string, e: Env = env()): boolean {
  if (e.DEV_TOOLS_ENABLED && !e.isProduction) return true;
  return e.TEST_TOOLS_ORGANISATION_IDS.includes(organisationId.toLowerCase());
}

/** Whether ANY organisation can have the test tools (the routes answer 404 up front otherwise). */
export function testToolsConfigured(e: Env = env()): boolean {
  return (e.DEV_TOOLS_ENABLED && !e.isProduction) || e.TEST_TOOLS_ORGANISATION_IDS.length > 0;
}

/** Whether all APNs variables are configured (selects ApnsPushProvider). */
export function apnsConfigured(e: Env = env()): boolean {
  return Boolean(e.APNS_KEY_ID && e.APNS_TEAM_ID && e.APNS_P8_BASE64 && e.APNS_BUNDLE_ID);
}
