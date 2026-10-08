import { describe, expect, it } from "vitest";
import {
  apnsConfigured,
  isPooledPostgresUrl,
  parseEnv,
  PLANDAY_MOCK_DEFAULT_URL,
  SHUTDOWN_GRACE_MAX_MS,
  testToolsConfigured,
  testToolsEnabledFor,
} from "./env";

const VALID = {
  DATABASE_URL: "postgresql://u:p@localhost:5433/clockoff",
  APP_URL: "http://localhost:3000/",
  SESSION_SECRET: "s".repeat(64),
  MOBILE_JWT_SECRET: "m".repeat(64),
  INTEGRATION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
} satisfies Record<string, string>;

/** Neon's documented URL shapes (production: DATABASE_URL pooled, DIRECT_URL direct). */
const NEON_POOLED =
  "postgresql://app:pw@ep-cool-name-123456-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require&pgbouncer=true&connection_limit=5";
const NEON_DIRECT =
  "postgresql://app:pw@ep-cool-name-123456.eu-west-2.aws.neon.tech/neondb?sslmode=require";

describe("parseEnv", () => {
  it("applies defaults and derives helpers", () => {
    const { env, warnings } = parseEnv({ ...VALID, NODE_ENV: "development" });
    expect(env).toMatchObject({
      SESSION_TTL_DAYS: 14,
      MOBILE_JWT_KEY_ID: "v1",
      MOBILE_ACCESS_TOKEN_TTL_SECONDS: 900,
      MOBILE_REFRESH_TOKEN_TTL_DAYS: 60,
      EMAIL_PROVIDER: "console",
      RATE_LIMIT_BACKEND: "memory",
      TRUSTED_PROXY_HOPS: 1,
      WORKER_JOBS_ENABLED: true,
      DEV_TOOLS_ENABLED: false,
      LOG_LEVEL: "info",
      REALTIME_STREAM_MAX_LIFETIME_MS: 300_000,
      SHUTDOWN_GRACE_MS: 20_000,
      APP_ORIGIN: "http://localhost:3000",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000/",
      REQUIRE_EMAIL_VERIFICATION: false,
      isDevelopment: true,
      isProduction: false,
    });
    expect(warnings).toEqual([]);
  });

  it("treats empty strings as unset (the .env.example template parses)", () => {
    const { env } = parseEnv({ ...VALID, SMTP_HOST: "", REDIS_URL: "  ", APNS_KEY_ID: "" });
    expect(env.SMTP_HOST).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
    expect(apnsConfigured(env)).toBe(false);
  });

  it("lists every problem in one readable error", () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: "nope",
        SESSION_SECRET: "short",
        INTEGRATION_ENCRYPTION_KEY: "abc",
      }),
    ).toThrowError(
      /DATABASE_URL[\s\S]*APP_URL[\s\S]*SESSION_SECRET: must be at least 32[\s\S]*INTEGRATION_ENCRYPTION_KEY: must be 32 random bytes[\s\S]*pnpm setup:env/,
    );
  });

  it("requires email verification by default in production only, unless set explicitly", () => {
    const prod = parseEnv({
      ...VALID,
      NODE_ENV: "production",
      APP_URL: "https://app.example.com",
    }).env;
    expect(prod.REQUIRE_EMAIL_VERIFICATION).toBe(true);
    const prodOff = parseEnv({
      ...VALID,
      NODE_ENV: "production",
      APP_URL: "https://app.example.com",
      REQUIRE_EMAIL_VERIFICATION: "false",
    }).env;
    expect(prodOff.REQUIRE_EMAIL_VERIFICATION).toBe(false);
    expect(
      parseEnv({ ...VALID, REQUIRE_EMAIL_VERIFICATION: "true" }).env.REQUIRE_EMAIL_VERIFICATION,
    ).toBe(true);
  });

  it("refuses dangerous production settings and warns about weak ones", () => {
    expect(() => parseEnv({ ...VALID, NODE_ENV: "production", DEV_TOOLS_ENABLED: "true" })).toThrow(
      /DEV_TOOLS_ENABLED/,
    );
    const { warnings } = parseEnv({ ...VALID, NODE_ENV: "production" });
    expect(warnings.join("\n")).toMatch(/EMAIL_PROVIDER=console/);
    expect(warnings.join("\n")).toMatch(/https/);
  });

  it("accepts EMAIL_PROVIDER=resend with RESEND_API_KEY (production included)", () => {
    const { env, warnings } = parseEnv({
      ...VALID,
      NODE_ENV: "production",
      APP_URL: "https://app.clockoff.online",
      DIRECT_URL: NEON_DIRECT,
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "re_test_key_123",
      EMAIL_FROM: "ClockOff <noreply@clockoff.online>",
    });
    expect(env).toMatchObject({
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "re_test_key_123",
      EMAIL_FROM: "ClockOff <noreply@clockoff.online>",
    });
    expect(warnings).toEqual([]);
    expect(parseEnv(VALID).env.RESEND_API_KEY).toBeUndefined();
    expect(() => parseEnv({ ...VALID, EMAIL_PROVIDER: "sendgrid" })).toThrow(/EMAIL_PROVIDER/);
  });

  it("refuses EMAIL_PROVIDER=resend without RESEND_API_KEY in production, warns elsewhere", () => {
    const prod = {
      ...VALID,
      NODE_ENV: "production",
      APP_URL: "https://app.clockoff.online",
      EMAIL_PROVIDER: "resend",
      EMAIL_FROM: "ClockOff <noreply@clockoff.online>",
    };
    expect(() => parseEnv(prod)).toThrow(
      /RESEND_API_KEY is required when EMAIL_PROVIDER=resend in production/,
    );
    // Empty / blank values count as unset (the .env.production.example template ships RESEND_API_KEY="").
    expect(() => parseEnv({ ...prod, RESEND_API_KEY: "" })).toThrow(/RESEND_API_KEY/);
    expect(() => parseEnv({ ...prod, RESEND_API_KEY: "   " })).toThrow(/RESEND_API_KEY/);

    const dev = parseEnv({
      ...VALID,
      NODE_ENV: "development",
      EMAIL_PROVIDER: "resend",
      EMAIL_FROM: "ClockOff <noreply@clockoff.online>",
    });
    expect(dev.env.EMAIL_PROVIDER).toBe("resend");
    expect(dev.warnings).toEqual([
      "RESEND_API_KEY is required when EMAIL_PROVIDER=resend: every email send will fail.",
    ]);
  });

  it("refuses a RESEND_API_KEY with inner whitespace in production without echoing it", () => {
    const key = "re_abc def_Secret123";
    const prod = {
      ...VALID,
      NODE_ENV: "production",
      APP_URL: "https://app.clockoff.online",
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: key,
      EMAIL_FROM: "ClockOff <noreply@clockoff.online>",
    };
    let message = "";
    try {
      parseEnv(prod);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/RESEND_API_KEY must not contain whitespace .* in production/);
    expect(message).not.toContain("def_Secret123");
    // Surrounding whitespace (a pasted trailing newline) is fine: the provider trims it.
    expect(() => parseEnv({ ...prod, RESEND_API_KEY: ` re_test_key_123\n` })).not.toThrow();

    const dev = parseEnv({ ...prod, NODE_ENV: "development" });
    expect(dev.warnings.join("\n")).toMatch(/RESEND_API_KEY must not contain whitespace/);
    expect(dev.warnings.join("\n")).not.toContain("def_Secret123");
  });

  it("refuses an EMAIL_FROM Resend can never send from in production, warns elsewhere", () => {
    const prod = {
      ...VALID,
      NODE_ENV: "production",
      APP_URL: "https://app.clockoff.online",
      DIRECT_URL: NEON_DIRECT,
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "re_test_key_123",
    };
    // EMAIL_FROM unset: the `.local` development default.
    expect(() => parseEnv(prod)).toThrow(
      /EMAIL_FROM must use a domain verified in Resend.* in production/,
    );
    for (const from of [
      "ClockOff <noreply@clockoff.LOCAL>",
      "noreply@mail.example",
      "ClockOff <noreply@app.test>",
      "x@localhost.invalid",
    ]) {
      expect(() => parseEnv({ ...prod, EMAIL_FROM: from }), from).toThrow(/verified in Resend/);
    }
    for (const from of [
      "noreply",
      "ClockOff",
      "ClockOff <noreply>",
      "ClockOff <noreply@clockoff.online",
      "noreply@localhost",
    ]) {
      expect(() => parseEnv({ ...prod, EMAIL_FROM: from }), from).toThrow(
        /EMAIL_FROM must be `address@domain` or `Name <address@domain>`/,
      );
    }
    for (const from of [
      "noreply@clockoff.online",
      "ClockOff <noreply@clockoff.online>",
      '"ClockOff" <noreply@clockoff.online>',
      "  ClockOff <noreply@mail.clockoff.online>  ",
      "Testing <onboarding@resend.dev>",
    ]) {
      expect(parseEnv({ ...prod, EMAIL_FROM: from }).warnings, from).toEqual([]);
    }

    const dev = parseEnv({ ...prod, NODE_ENV: "development" });
    expect(dev.warnings).toEqual([
      "EMAIL_FROM must use a domain verified in Resend, not .local / .localhost / .test / .example / .invalid, when EMAIL_PROVIDER=resend: every email send will fail.",
    ]);
    // The checks only apply to Resend: the console default keeps working everywhere.
    expect(parseEnv({ ...VALID, NODE_ENV: "development" }).warnings).toEqual([]);
  });

  it("no longer knows CRON_SECRET: neither required nor exposed, and a leftover value is flagged", () => {
    expect(() => parseEnv(VALID)).not.toThrow();
    const prod = parseEnv({
      ...VALID,
      NODE_ENV: "production",
      APP_URL: "https://app.example.com",
      CRON_SECRET: "short",
    });
    expect("CRON_SECRET" in prod.env).toBe(false);
    expect(prod.warnings).toContain(
      "CRON_SECRET is no longer used (the worker runs the jobs): remove it.",
    );
    expect(prod.warnings.join("\n")).not.toContain("short");
  });

  it("WORKER_JOBS_ENABLED is the jobs switch; the retired JOBS_ENABLED is kept apart and flagged", () => {
    expect(parseEnv(VALID).env.WORKER_JOBS_ENABLED).toBe(true);
    expect(parseEnv(VALID).env.JOBS_ENABLED).toBeUndefined();
    expect(parseEnv({ ...VALID, WORKER_JOBS_ENABLED: "false" }).env.WORKER_JOBS_ENABLED).toBe(
      false,
    );
    // The Netlify site's value: never turns the worker's jobs off, and is called out.
    const legacy = parseEnv({ ...VALID, JOBS_ENABLED: "false" });
    expect(legacy.env.WORKER_JOBS_ENABLED).toBe(true);
    expect(legacy.env.JOBS_ENABLED).toBe(false);
    expect(legacy.warnings.join("\n")).toMatch(
      /JOBS_ENABLED=false is a retired Netlify-era setting: the worker refuses to start/,
    );
    expect(parseEnv({ ...VALID, JOBS_ENABLED: "true" }).warnings.join("\n")).toMatch(
      /JOBS_ENABLED is retired and ignored/,
    );
  });

  it("refuses client-IP headers a client could supply (Netlify's, or any header Railway's edge does not set)", () => {
    const prod = {
      ...VALID,
      NODE_ENV: "production",
      APP_URL: "https://app.example.com",
      DIRECT_URL: NEON_DIRECT,
    };
    const railway = { RAILWAY_ENVIRONMENT_ID: "4c3c1a2b-0000-4000-8000-000000000000" };
    const ipWarnings = (source: Record<string, string>) =>
      parseEnv(source).warnings.filter((w) => w.includes("CLIENT_IP_HEADER"));
    // Netlify's edge header: fatal in production anywhere, a warning elsewhere.
    expect(() => parseEnv({ ...prod, CLIENT_IP_HEADER: "x-nf-client-connection-ip" })).toThrow(
      /CLIENT_IP_HEADER="x-nf-client-connection-ip" is a Netlify edge header/,
    );
    expect(
      parseEnv({ ...VALID, CLIENT_IP_HEADER: "X-NF-Client-Connection-IP" }).warnings.join("\n"),
    ).toMatch(/Netlify edge header/);
    // On Railway only the headers its edge sets.
    for (const header of ["x-real-ip", "X-Forwarded-For", ""]) {
      expect(ipWarnings({ ...prod, ...railway, CLIENT_IP_HEADER: header }), header).toEqual([]);
    }
    expect(() => parseEnv({ ...prod, ...railway, CLIENT_IP_HEADER: "cf-connecting-ip" })).toThrow(
      /not set by Railway's edge/,
    );
    // Elsewhere (another platform's own edge header) it is the operator's call.
    expect(ipWarnings({ ...prod, CLIENT_IP_HEADER: "cf-connecting-ip" })).toEqual([]);
  });

  it("validates the optional DIRECT_URL", () => {
    expect(parseEnv(VALID).env.DIRECT_URL).toBeUndefined();
    expect(parseEnv({ ...VALID, DIRECT_URL: "" }).env.DIRECT_URL).toBeUndefined();
    expect(parseEnv({ ...VALID, DIRECT_URL: NEON_DIRECT }).env.DIRECT_URL).toBe(NEON_DIRECT);
    expect(() => parseEnv({ ...VALID, DIRECT_URL: "not a url" })).toThrowError(
      /DIRECT_URL: must be a postgresql:\/\/ connection string/,
    );
  });

  it("bounds the SSE stream lifetime (default 5 min) and the shutdown grace (default 20 s)", () => {
    expect(
      parseEnv({ ...VALID, REALTIME_STREAM_MAX_LIFETIME_MS: "60000" }).env
        .REALTIME_STREAM_MAX_LIFETIME_MS,
    ).toBe(60_000);
    expect(
      parseEnv({ ...VALID, REALTIME_STREAM_MAX_LIFETIME_MS: "10000" }).env
        .REALTIME_STREAM_MAX_LIFETIME_MS,
    ).toBe(10_000);
    expect(
      parseEnv({ ...VALID, REALTIME_STREAM_MAX_LIFETIME_MS: "840000" }).env
        .REALTIME_STREAM_MAX_LIFETIME_MS,
    ).toBe(840_000);
    for (const bad of ["9999", "840001", "abc", "15000.5"]) {
      expect(() => parseEnv({ ...VALID, REALTIME_STREAM_MAX_LIFETIME_MS: bad }), bad).toThrow(
        /REALTIME_STREAM_MAX_LIFETIME_MS/,
      );
    }
    expect(SHUTDOWN_GRACE_MAX_MS).toBe(25_000);
    expect(parseEnv({ ...VALID, SHUTDOWN_GRACE_MS: "25000" }).env.SHUTDOWN_GRACE_MS).toBe(25_000);
    for (const bad of ["999", "25001", "45000", "-1"]) {
      expect(() => parseEnv({ ...VALID, SHUTDOWN_GRACE_MS: bad }), bad).toThrow(
        /SHUTDOWN_GRACE_MS/,
      );
    }
  });

  it("warns in production when DIRECT_URL is unset (realtime stays in-process)", () => {
    const prod = { ...VALID, NODE_ENV: "production", APP_URL: "https://app.example.com" };
    expect(parseEnv(prod).warnings.join("\n")).toMatch(/DIRECT_URL is not set in production/);
    expect(parseEnv({ ...prod, DIRECT_URL: NEON_DIRECT }).warnings.join("\n")).not.toMatch(
      /DIRECT_URL/,
    );
    expect(parseEnv({ ...VALID, NODE_ENV: "development" }).warnings).toEqual([]);
  });

  it("recognises pooled Postgres URLs (Neon -pooler host or pgbouncer=true)", () => {
    expect(isPooledPostgresUrl(NEON_POOLED)).toBe(true);
    expect(
      isPooledPostgresUrl(
        "postgresql://u:p@ep-x-pooler.eu-west-2.aws.neon.tech/db?sslmode=require",
      ),
    ).toBe(true);
    expect(isPooledPostgresUrl("postgresql://u:p@db.example.com:6432/db?pgbouncer=true")).toBe(
      true,
    );
    expect(isPooledPostgresUrl("postgresql://u:p@db.example.com/db?PGBOUNCER=TRUE")).toBe(false);
    expect(isPooledPostgresUrl("postgresql://u:p@db.example.com/db?pgbouncer=TRUE")).toBe(true);
    expect(isPooledPostgresUrl(NEON_DIRECT)).toBe(false);
    expect(isPooledPostgresUrl("postgresql://u:p@db.example.com/db?pgbouncer=false")).toBe(false);
    expect(isPooledPostgresUrl("postgresql://clockoff:clockoff@localhost:5433/clockoff")).toBe(
      false,
    );
    expect(
      isPooledPostgresUrl("postgresql://clockoff:clockoff@localhost:5433/clockoff?schema=public"),
    ).toBe(false);
    // A database or user merely containing "pooler" is not a pooler host.
    expect(isPooledPostgresUrl("postgresql://pooler:p@db.example.com/my-pooler.db")).toBe(false);
  });

  it("refuses a pooled DIRECT_URL in production without echoing it, warns elsewhere", () => {
    const prod = {
      ...VALID,
      NODE_ENV: "production",
      APP_URL: "https://app.example.com",
      DIRECT_URL: NEON_POOLED,
    };
    let message = "";
    try {
      parseEnv(prod);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(
      /DIRECT_URL must be the direct \(non-pooled\) connection string in production/,
    );
    expect(message).not.toContain("ep-cool-name");
    expect(message).not.toContain("pw@");

    const dev = parseEnv({ ...prod, NODE_ENV: "development" });
    expect(dev.env.DIRECT_URL).toBe(NEON_POOLED);
    expect(dev.warnings).toHaveLength(1);
    expect(dev.warnings[0]).toMatch(/DIRECT_URL looks like a pooled \(PgBouncer\) connection/);
    expect(dev.warnings[0]).not.toContain("ep-cool-name");
  });

  it("requires REDIS_URL for the redis backend", () => {
    expect(() => parseEnv({ ...VALID, RATE_LIMIT_BACKEND: "redis" })).toThrow(/REDIS_URL/);
    expect(
      parseEnv({ ...VALID, RATE_LIMIT_BACKEND: "redis", REDIS_URL: "redis://localhost" }).env
        .RATE_LIMIT_BACKEND,
    ).toBe("redis");
  });

  it("detects a complete APNs configuration", () => {
    const { env } = parseEnv({
      ...VALID,
      APNS_KEY_ID: "K",
      APNS_TEAM_ID: "T",
      APNS_P8_BASE64: "cA==",
    });
    expect(apnsConfigured(env)).toBe(true);
  });

  it("parses TEST_TOOLS_ORGANISATION_IDS as a validated, lowercased id list (empty when unset)", () => {
    const a = "77340865-337D-4AB5-8A18-8F75BF5AB306";
    const b = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    expect(parseEnv(VALID).env.TEST_TOOLS_ORGANISATION_IDS).toEqual([]);
    expect(
      parseEnv({ ...VALID, TEST_TOOLS_ORGANISATION_IDS: "" }).env.TEST_TOOLS_ORGANISATION_IDS,
    ).toEqual([]);
    expect(
      parseEnv({ ...VALID, TEST_TOOLS_ORGANISATION_IDS: ` ${a} ,${b},, ${b}` }).env
        .TEST_TOOLS_ORGANISATION_IDS,
    ).toEqual([a.toLowerCase(), b]);
    expect(() =>
      parseEnv({ ...VALID, TEST_TOOLS_ORGANISATION_IDS: `${a},SCALE-0090` }),
    ).toThrowError(/TEST_TOOLS_ORGANISATION_IDS[\s\S]*comma-separated list of organisation UUIDs/);
  });

  it("enables the test tools for listed organisations, or for every organisation with dev tools on", () => {
    const listed = "77340865-337d-4ab5-8a18-8f75bf5ab306";
    const other = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    const off = parseEnv({ ...VALID, NODE_ENV: "development" }).env;
    expect(testToolsConfigured(off)).toBe(false);
    expect(testToolsEnabledFor(listed, off)).toBe(false);

    const dev = parseEnv({ ...VALID, NODE_ENV: "development", DEV_TOOLS_ENABLED: "true" }).env;
    expect(testToolsConfigured(dev)).toBe(true);
    expect(testToolsEnabledFor(other, dev)).toBe(true);

    const prod = parseEnv({
      ...VALID,
      NODE_ENV: "production",
      APP_URL: "https://app.example.com",
      TEST_TOOLS_ORGANISATION_IDS: listed,
    }).env;
    expect(testToolsConfigured(prod)).toBe(true);
    expect(testToolsEnabledFor(listed, prod)).toBe(true);
    expect(testToolsEnabledFor(listed.toUpperCase(), prod)).toBe(true);
    expect(testToolsEnabledFor(other, prod)).toBe(false);

    // Defence in depth behind parseEnv's refusal: dev tools never open the gate in production.
    const prodWithDevTools = { ...prod, DEV_TOOLS_ENABLED: true, TEST_TOOLS_ORGANISATION_IDS: [] };
    expect(testToolsConfigured(prodWithDevTools)).toBe(false);
    expect(testToolsEnabledFor(other, prodWithDevTools)).toBe(false);
  });
});

describe("Planday (appendix A)", () => {
  const PROD = { ...VALID, NODE_ENV: "production", APP_URL: "https://app.example.com" } as const;
  const APP_ID = "f2370889-3ffe-46b6-83e7-1a20f5a20d2f";

  it("is dark in production and on elsewhere unless set explicitly", () => {
    expect(parseEnv(PROD).env.PLANDAY_ENABLED).toBe(false);
    expect(parseEnv({ ...VALID, NODE_ENV: "development" }).env.PLANDAY_ENABLED).toBe(true);
    expect(parseEnv({ ...VALID, NODE_ENV: "test" }).env.PLANDAY_ENABLED).toBe(true);
    expect(parseEnv({ ...PROD, PLANDAY_ENABLED: "true" }).env.PLANDAY_ENABLED).toBe(true);
    expect(parseEnv({ ...VALID, PLANDAY_ENABLED: "false" }).env.PLANDAY_ENABLED).toBe(false);
    // The commented .env template ("") means unset, not false.
    expect(parseEnv({ ...VALID, PLANDAY_ENABLED: "" }).env.PLANDAY_ENABLED).toBe(true);
    expect(() => parseEnv({ ...VALID, PLANDAY_ENABLED: "yes" })).toThrowError(/PLANDAY_ENABLED/);
  });

  it("resolves the mode: live in production, mock elsewhere", () => {
    expect(parseEnv(PROD).env.PLANDAY_MODE).toBe("live");
    expect(parseEnv({ ...VALID, NODE_ENV: "development" }).env.PLANDAY_MODE).toBe("mock");
    expect(parseEnv({ ...VALID, NODE_ENV: "test" }).env.PLANDAY_MODE).toBe("mock");
    expect(parseEnv({ ...VALID, PLANDAY_MODE: "live" }).env.PLANDAY_MODE).toBe("live");
    expect(parseEnv({ ...PROD, PLANDAY_MODE: "live" }).env.PLANDAY_MODE).toBe("live");
    expect(() => parseEnv({ ...VALID, PLANDAY_MODE: "staging" })).toThrowError(/PLANDAY_MODE/);
  });

  it("refuses Mock Planday in production (the deployment never starts)", () => {
    expect(() => parseEnv({ ...PROD, PLANDAY_MODE: "mock" })).toThrowError(
      /PLANDAY_MODE=mock is not allowed in production/,
    );
    // Even with Planday switched off: a mock mode must never reach a production process.
    expect(() =>
      parseEnv({ ...PROD, PLANDAY_MODE: "mock", PLANDAY_ENABLED: "false" }),
    ).toThrowError(/PLANDAY_MODE=mock/);
    expect(() => parseEnv({ ...PROD, PLANDAY_MOCK_URL: "http://127.0.0.1:4010" })).toThrowError(
      /PLANDAY_MOCK_URL must not be set in production/,
    );
  });

  it("points mock mode at the shared mock server outside tests", () => {
    const dev = parseEnv({ ...VALID, NODE_ENV: "development" }).env;
    expect(dev.PLANDAY_MOCK_URL).toBe(PLANDAY_MOCK_DEFAULT_URL);
    expect(PLANDAY_MOCK_DEFAULT_URL).toBe("http://127.0.0.1:4010");
    // Tests inject the in-process mock; live mode has no mock server; production never has one.
    expect(parseEnv({ ...VALID, NODE_ENV: "test" }).env.PLANDAY_MOCK_URL).toBeUndefined();
    expect(
      parseEnv({ ...VALID, NODE_ENV: "development", PLANDAY_MODE: "live" }).env.PLANDAY_MOCK_URL,
    ).toBeUndefined();
    expect(parseEnv(PROD).env.PLANDAY_MOCK_URL).toBeUndefined();
    const custom = parseEnv({ ...VALID, PLANDAY_MOCK_URL: "http://localhost:4999" }).env;
    expect(custom.PLANDAY_MOCK_URL).toBe("http://localhost:4999");
    expect(() => parseEnv({ ...VALID, PLANDAY_MOCK_URL: "not a url" })).toThrowError(
      /PLANDAY_MOCK_URL/,
    );
  });

  it("validates ClockOff's App IDs (methods A and B), unset by default", () => {
    const unset = parseEnv(PROD).env;
    expect(unset.PLANDAY_CLIENT_ID).toBeUndefined();
    expect(unset.PLANDAY_APP_ID).toBeUndefined();
    const set = parseEnv({ ...PROD, PLANDAY_CLIENT_ID: ` ${APP_ID} `, PLANDAY_APP_ID: APP_ID }).env;
    expect(set.PLANDAY_CLIENT_ID).toBe(APP_ID);
    expect(set.PLANDAY_APP_ID).toBe(APP_ID);
    expect(() => parseEnv({ ...VALID, PLANDAY_CLIENT_ID: "clockoff" })).toThrowError(
      /PLANDAY_CLIENT_ID: must be a Planday App ID/,
    );
    expect(() => parseEnv({ ...VALID, PLANDAY_APP_ID: "123" })).toThrowError(/PLANDAY_APP_ID/);
  });

  it("keeps clock-in mode and PKCE off unless turned on", () => {
    const { env, warnings } = parseEnv(PROD);
    expect(env.PLANDAY_CLOCK_MODE_ENABLED).toBe(false);
    expect(env.PLANDAY_OAUTH_PKCE).toBe(false);
    expect(warnings.filter((w) => w.includes("PLANDAY"))).toEqual([]);
    const on = parseEnv({
      ...VALID,
      PLANDAY_CLOCK_MODE_ENABLED: "true",
      PLANDAY_OAUTH_PKCE: "1",
    }).env;
    expect(on.PLANDAY_CLOCK_MODE_ENABLED).toBe(true);
    expect(on.PLANDAY_OAUTH_PKCE).toBe(true);
  });

  it("never needs a client secret", () => {
    // Planday's token endpoint takes no client_secret (notes §3.4): a stray one is ignored, never exposed.
    const { env } = parseEnv({ ...PROD, PLANDAY_CLIENT_SECRET: "s3cret" });
    expect(env).not.toHaveProperty("PLANDAY_CLIENT_SECRET");
    expect(JSON.stringify(env)).not.toContain("s3cret");
  });
});
