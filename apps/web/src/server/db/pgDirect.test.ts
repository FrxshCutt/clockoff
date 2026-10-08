import { describe, expect, it, vi } from "vitest";
import type { Logger } from "@/lib/logger";
import {
  DIRECT_SESSION_IDLE_TIMEOUT,
  PG_DEFAULT_CONNECT_TIMEOUT_MS,
  isStatementError,
  pgClientConfig,
  prepareDirectSession,
  truncateApplicationName,
} from "./pgDirect";

const NEON_POOLED =
  "postgresql://app:secret@ep-cool-name-a1b2c3-pooler.eu-west-2.aws.neon.tech/clockoff?sslmode=require&channel_binding=require&pgbouncer=true&connection_limit=1&connect_timeout=15";
const NEON_DIRECT =
  "postgresql://app:secret@ep-cool-name-a1b2c3.eu-west-2.aws.neon.tech/clockoff?sslmode=require&channel_binding=require";
const LOCAL = "postgresql://clockoff:clockoff@localhost:5433/clockoff?schema=public";

function params(config: { connectionString?: string }): URLSearchParams {
  return new URL(config.connectionString!).searchParams;
}

describe("pgClientConfig", () => {
  it("strips Prisma-only parameters from a Neon pooled URL and keeps the credentials and host", () => {
    const config = pgClientConfig(NEON_POOLED, "clockoff-web-events");
    const url = new URL(config.connectionString!);
    expect(url.hostname).toBe("ep-cool-name-a1b2c3-pooler.eu-west-2.aws.neon.tech");
    expect(url.username).toBe("app");
    expect(url.password).toBe("secret");
    expect(url.pathname).toBe("/clockoff");
    expect([...params(config).keys()]).toEqual(["sslmode"]);
    expect(config.connectionTimeoutMillis).toBe(15_000);
  });

  it("keeps certificate verification for a Neon direct URL and enables channel binding", () => {
    const config = pgClientConfig(NEON_DIRECT, "clockoff-worker-events");
    expect(params(config).get("sslmode")).toBe("verify-full");
    expect(params(config).has("channel_binding")).toBe(false);
    expect(config.enableChannelBinding).toBe(true);
    expect(config.connectionTimeoutMillis).toBe(PG_DEFAULT_CONNECT_TIMEOUT_MS);
  });

  it("accepts the local URL (schema stripped, no TLS, no channel binding)", () => {
    const config = pgClientConfig(LOCAL, "clockoff-app-events");
    expect(config.connectionString).toBe("postgresql://clockoff:clockoff@localhost:5433/clockoff");
    expect(config.enableChannelBinding).toBeUndefined();
  });

  it("sets keepalive, the 10 s keepalive delay, the 10 s query timeout and our application_name", () => {
    const config = pgClientConfig(`${LOCAL}&application_name=theirs`, "clockoff-web-events");
    expect(config).toMatchObject({
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      query_timeout: 10_000,
      application_name: "clockoff-web-events",
    });
    // pg merges the URL over explicit options, so the URL must not carry its own application_name.
    expect(params(config).has("application_name")).toBe(false);
  });

  it("ignores a zero or invalid connect_timeout", () => {
    expect(pgClientConfig(`${LOCAL}&connect_timeout=0`, "a").connectionTimeoutMillis).toBe(
      PG_DEFAULT_CONNECT_TIMEOUT_MS,
    );
    expect(pgClientConfig(`${LOCAL}&connect_timeout=soon`, "a").connectionTimeoutMillis).toBe(
      PG_DEFAULT_CONNECT_TIMEOUT_MS,
    );
  });

  it("cuts the application_name to 63 bytes without splitting a character", () => {
    const long = `clockoff-worker-locks:${"é".repeat(40)}`;
    const cut = pgClientConfig(LOCAL, long).application_name!;
    expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(63);
    expect(long.startsWith(cut)).toBe(true);
    expect(cut).not.toContain("�");
    expect(truncateApplicationName("short")).toBe("short");
  });

  it("rejects a non-URL without echoing it", () => {
    expect(() => pgClientConfig("not a url with secret-password", "a")).toThrow(/not a valid URL/);
    try {
      pgClientConfig("not a url with secret-password", "a");
    } catch (err) {
      expect((err as Error).message).not.toContain("secret-password");
    }
  });
});

describe("prepareDirectSession", () => {
  const fakeLog = () =>
    ({ warn: vi.fn() }) as unknown as Logger & { warn: ReturnType<typeof vi.fn> };

  it("sets the idle-session and statement timeouts", async () => {
    const query = vi.fn(async (_text: string) => ({}));
    const log = fakeLog();
    await prepareDirectSession({ query }, log);
    expect(query.mock.calls.map(([text]) => text)).toEqual([
      `SET idle_session_timeout = '${DIRECT_SESSION_IDLE_TIMEOUT}'`,
      "SET statement_timeout = '10s'",
    ]);
    expect(DIRECT_SESSION_IDLE_TIMEOUT).toBe("120s");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("only warns when a SET is rejected, and still runs the next one", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("idle_session_timeout")) {
        throw Object.assign(
          new Error('unrecognized configuration parameter "idle_session_timeout"'),
          {
            code: "42704",
            severity: "ERROR",
          },
        );
      }
      return {};
    });
    const log = fakeLog();
    await expect(prepareDirectSession({ query }, log)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn.mock.calls[0]![0]).toMatchObject({ setting: "idle_session_timeout" });
  });
});

describe("isStatementError", () => {
  it("is true only for server-reported statement errors", () => {
    const sql = (code: string, severity: string) =>
      Object.assign(new Error("x"), { code, severity });
    expect(isStatementError(sql("55P03", "ERROR"))).toBe(true);
    expect(isStatementError(sql("57P01", "FATAL"))).toBe(false);
    expect(isStatementError(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe(false);
    expect(isStatementError(Object.assign(new Error("pipe"), { code: "EPIPE" }))).toBe(false);
    expect(isStatementError(new Error("Query read timeout"))).toBe(false);
    expect(isStatementError("nope")).toBe(false);
  });
});
