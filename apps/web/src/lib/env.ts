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

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Database
  DATABASE_URL: z.url({ message: "must be a postgresql:// connection string" }),
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
  EMAIL_PROVIDER: z.enum(["console", "smtp"]).default("console"),
  EMAIL_FROM: z.string().min(3).default("Work Mode <no-reply@workmode.local>"),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),

  // Push (APNs)
  APNS_KEY_ID: z.string().optional(),
  APNS_TEAM_ID: z.string().optional(),
  APNS_P8_BASE64: z.string().optional(),
  APNS_BUNDLE_ID: z.string().default("com.workmode.app"),
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

  // Jobs
  JOBS_ENABLED: booleanString.default(true),
  // Length is enforced for production in parseEnv (CI uses a short fixed value).
  CRON_SECRET: z.string().min(1),

  // Logging
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),

  // Dev
  DEV_TOOLS_ENABLED: booleanString.default(false),
});

type RawEnv = z.infer<typeof envSchema>;

export interface Env extends Omit<RawEnv, "REQUIRE_EMAIL_VERIFICATION" | "NEXT_PUBLIC_APP_URL"> {
  /** Resolved: explicit value, otherwise `true` in production and `false` elsewhere. */
  REQUIRE_EMAIL_VERIFICATION: boolean;
  NEXT_PUBLIC_APP_URL: string;
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
  if (isProduction && raw.SESSION_SECRET === raw.MOBILE_JWT_SECRET) {
    throw new Error(
      "Invalid environment configuration:\n - SESSION_SECRET and MOBILE_JWT_SECRET must be different secrets in production",
    );
  }
  if (isProduction && raw.CRON_SECRET.length < 32) {
    throw new Error(
      "Invalid environment configuration:\n - CRON_SECRET must be at least 32 characters in production",
    );
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
    APP_ORIGIN: new URL(raw.APP_URL).origin,
    isProduction,
    isTest: raw.NODE_ENV === "test",
    isDevelopment: raw.NODE_ENV === "development",
  };
  return { env, warnings };
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

/** Whether all APNs variables are configured (selects ApnsPushProvider). */
export function apnsConfigured(e: Env = env()): boolean {
  return Boolean(e.APNS_KEY_ID && e.APNS_TEAM_ID && e.APNS_P8_BASE64 && e.APNS_BUNDLE_ID);
}
