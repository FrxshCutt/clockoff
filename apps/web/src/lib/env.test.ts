import { describe, expect, it } from "vitest";
import { apnsConfigured, parseEnv, testToolsConfigured, testToolsEnabledFor } from "./env";

const VALID = {
  DATABASE_URL: "postgresql://u:p@localhost:5433/clockoff",
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

  it("accepts EMAIL_PROVIDER=resend with RESEND_API_KEY (production included)", () => {
    const { env, warnings } = parseEnv({
      ...VALID,
      NODE_ENV: "production",
      APP_URL: "https://app.clockoff.online",
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
