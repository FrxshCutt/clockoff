import { describe, expect, it } from "vitest";
import { apnsConfigured, parseEnv } from "./env";

const VALID = {
  DATABASE_URL: "postgresql://u:p@localhost:5433/workmode",
  APP_URL: "http://localhost:3000/",
  SESSION_SECRET: "s".repeat(64),
  MOBILE_JWT_SECRET: "m".repeat(64),
  INTEGRATION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  CRON_SECRET: "c".repeat(32),
} satisfies Record<string, string>;

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
      JOBS_ENABLED: true,
      DEV_TOOLS_ENABLED: false,
      LOG_LEVEL: "info",
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
    expect(() => parseEnv({ ...VALID, NODE_ENV: "production", CRON_SECRET: "short" })).toThrow(
      /CRON_SECRET/,
    );
    expect(
      parseEnv({ ...VALID, NODE_ENV: "test", CRON_SECRET: "ci-cron-secret" }).env.CRON_SECRET,
    ).toBe("ci-cron-secret");
    const { warnings } = parseEnv({ ...VALID, NODE_ENV: "production" });
    expect(warnings.join("\n")).toMatch(/EMAIL_PROVIDER=console/);
    expect(warnings.join("\n")).toMatch(/https/);
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
});
