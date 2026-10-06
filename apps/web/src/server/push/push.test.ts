import { generateKeyPairSync } from "node:crypto";
import { createServer, type Http2Server, type IncomingHttpHeaders } from "node:http2";
import type { AddressInfo } from "node:net";
import { decodeProtectedHeader, importSPKI, jwtVerify } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { ApnsPushProvider } from "./ApnsPushProvider";
import { NoopPushProvider } from "./NoopPushProvider";
import { createPushProvider } from "./index";

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const OK_TOKEN = "a".repeat(64);
const GONE_TOKEN = "b".repeat(64);
const BAD_TOKEN = "c".repeat(64);

describe("ApnsPushProvider token auth", () => {
  it("signs an ES256 provider token with kid = key id and iss = team id, cached for 50 minutes", async () => {
    const provider = new ApnsPushProvider({
      keyId: "KEY123",
      teamId: "TEAM456",
      privateKeyPem: privateKey,
      bundleId: "com.workmode.app",
      environment: "sandbox",
    });
    const now = Date.UTC(2026, 9, 6, 9, 0, 0);
    const token = await provider.getAuthToken(now);
    expect(decodeProtectedHeader(token)).toEqual({ alg: "ES256", kid: "KEY123" });
    const { payload } = await jwtVerify(token, await importSPKI(publicKey, "ES256"), {
      issuer: "TEAM456",
      currentDate: new Date(now),
    });
    expect(payload.iat).toBe(now / 1000);
    expect(await provider.getAuthToken(now + 49 * 60_000)).toBe(token);
    expect(await provider.getAuthToken(now + 51 * 60_000)).not.toBe(token);
  });

  it("builds APNs headers for background pushes", async () => {
    const provider = ApnsPushProvider.fromBase64Key({
      keyId: "K",
      teamId: "T",
      p8Base64: Buffer.from(privateKey).toString("base64"),
      bundleId: "com.workmode.app",
      environment: "production",
    });
    const headers = await provider.buildHeaders(OK_TOKEN, {
      pushType: "background",
      priority: 5,
      collapseId: "sync",
      body: {},
    });
    expect(headers).toMatchObject({
      ":method": "POST",
      ":path": `/3/device/${OK_TOKEN}`,
      ":authority": "api.push.apple.com",
      "apns-topic": "com.workmode.app",
      "apns-push-type": "background",
      "apns-priority": "5",
      "apns-collapse-id": "sync",
    });
    expect(headers.authorization).toMatch(/^bearer ey/);
  });

  it("requires a complete configuration", () => {
    expect(
      () =>
        new ApnsPushProvider({
          keyId: "",
          teamId: "T",
          privateKeyPem: privateKey,
          bundleId: "b",
          environment: "sandbox",
        }),
    ).toThrow(/requires/);
  });
});

describe("ApnsPushProvider delivery (local HTTP/2 server, no network)", () => {
  let server: Http2Server;
  let host: string;
  const received: Array<{ headers: IncomingHttpHeaders; body: Record<string, unknown> }> = [];

  beforeAll(async () => {
    server = createServer();
    server.on("stream", (stream, headers) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        received.push({
          headers,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
        });
        const path = String(headers[":path"]);
        if (path.endsWith(OK_TOKEN)) {
          stream.respond({ ":status": 200 });
          stream.end();
        } else if (path.endsWith(GONE_TOKEN)) {
          stream.respond({ ":status": 410, "content-type": "application/json" });
          stream.end(JSON.stringify({ reason: "Unregistered" }));
        } else {
          stream.respond({ ":status": 400, "content-type": "application/json" });
          stream.end(JSON.stringify({ reason: "BadDeviceToken" }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("sends silent pushes and reports sent / failed / invalid tokens", async () => {
    const provider = new ApnsPushProvider({
      keyId: "K",
      teamId: "T",
      privateKeyPem: privateKey,
      bundleId: "com.workmode.app",
      environment: "sandbox",
      host,
    });
    const report = await provider.sendSilent([OK_TOKEN, GONE_TOKEN, BAD_TOKEN, "not-hex"], {
      reason: "schedule_changed",
      data: { scheduleVersion: 7, aps: "ignored" },
    });
    provider.close();

    expect(report).toMatchObject({ provider: "apns", requested: 4, sent: 1, failed: 3 });
    expect(report.invalidTokens.sort()).toEqual([GONE_TOKEN, BAD_TOKEN, "not-hex"].sort());
    expect(report.failures.find((f) => f.token === GONE_TOKEN)).toMatchObject({
      status: 410,
      reason: "Unregistered",
    });

    expect(received).toHaveLength(3);
    const first = received.find((r) => String(r.headers[":path"]).endsWith(OK_TOKEN))!;
    expect(first.headers["apns-push-type"]).toBe("background");
    expect(first.headers["apns-topic"]).toBe("com.workmode.app");
    expect(String(first.headers.authorization)).toMatch(/^bearer /);
    expect(first.body).toEqual({
      scheduleVersion: 7,
      aps: { "content-available": 1 },
      reason: "schedule_changed",
    });
  });

  it("sends alert pushes", async () => {
    received.length = 0;
    const provider = new ApnsPushProvider({
      keyId: "K",
      teamId: "T",
      privateKeyPem: privateKey,
      bundleId: "com.workmode.app",
      environment: "sandbox",
      host,
    });
    const report = await provider.sendAlert([OK_TOKEN], {
      title: "Shift starts soon",
      body: "In 10 minutes",
      threadId: "shift",
    });
    provider.close();
    expect(report.sent).toBe(1);
    expect(received[0]?.headers["apns-push-type"]).toBe("alert");
    expect(received[0]?.body).toEqual({
      aps: {
        alert: { title: "Shift starts soon", body: "In 10 minutes" },
        sound: "default",
        "thread-id": "shift",
      },
    });
  });
});

describe("provider selection", () => {
  const keys = ["APNS_KEY_ID", "APNS_TEAM_ID", "APNS_P8_BASE64"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetEnvCache();
  });

  it("uses Noop unless every APNS_* variable is set", async () => {
    for (const k of keys) delete process.env[k];
    resetEnvCache();
    const noop = createPushProvider();
    expect(noop).toBeInstanceOf(NoopPushProvider);
    expect(await noop.sendSilent(["x", "y"], { reason: "test" })).toMatchObject({
      provider: "noop",
      requested: 2,
      sent: 2,
    });

    process.env.APNS_KEY_ID = "K";
    process.env.APNS_TEAM_ID = "T";
    process.env.APNS_P8_BASE64 = Buffer.from(privateKey).toString("base64");
    resetEnvCache();
    expect(createPushProvider()).toBeInstanceOf(ApnsPushProvider);
  });
});
