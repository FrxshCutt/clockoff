import { connect, constants, type ClientHttp2Session } from "node:http2";
import { SignJWT, importPKCS8, type CryptoKey } from "jose";
import { errorSummary, logger } from "@/lib/logger";
import type {
  AlertPushPayload,
  PushFailure,
  PushProvider,
  PushReport,
  SilentPushPayload,
} from "./PushProvider";

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  /** PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----`) of the .p8 signing key. */
  privateKeyPem: string;
  bundleId: string;
  environment: "sandbox" | "production";
  /** Override the APNs host (tests). */
  host?: string;
  /** Per-request timeout in ms. */
  requestTimeoutMs?: number;
}

export const APNS_HOSTS = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
} as const;

/** Apple requires provider tokens to be refreshed at least hourly and no more than every 20 minutes. */
const TOKEN_LIFETIME_MS = 50 * 60 * 1_000;
const SESSION_IDLE_MS = 5 * 60 * 1_000;

/** APNs reasons that mean the token should be dropped. */
const INVALID_TOKEN_REASONS = new Set([
  "BadDeviceToken",
  "Unregistered",
  "DeviceTokenNotForTopic",
  "ExpiredToken",
]);

export interface ApnsRequest {
  pushType: "background" | "alert";
  priority: 5 | 10;
  collapseId?: string;
  body: Record<string, unknown>;
}

/**
 * Token-based (JWT, ES256) APNs HTTP/2 client using only Node built-ins + jose.
 * One multiplexed HTTP/2 session is kept per provider and recreated after errors / idleness.
 */
export class ApnsPushProvider implements PushProvider {
  readonly name = "apns" as const;

  private key: CryptoKey | undefined;
  private cachedToken: { value: string; issuedAt: number } | undefined;
  private session: ClientHttp2Session | undefined;
  private readonly host: string;

  constructor(private readonly config: ApnsConfig) {
    if (!config.keyId || !config.teamId || !config.privateKeyPem || !config.bundleId) {
      throw new Error("ApnsPushProvider requires keyId, teamId, privateKeyPem and bundleId");
    }
    this.host = config.host ?? APNS_HOSTS[config.environment];
  }

  /** Build from the env representation (base64-encoded .p8 contents). */
  static fromBase64Key(
    config: Omit<ApnsConfig, "privateKeyPem"> & { p8Base64: string },
  ): ApnsPushProvider {
    const pem = Buffer.from(config.p8Base64, "base64").toString("utf8");
    const { p8Base64: _ignored, ...rest } = config;
    return new ApnsPushProvider({ ...rest, privateKeyPem: pem });
  }

  /**
   * Provider authentication token (`iss` = team id, `iat`, header `kid` = key id, alg ES256), cached
   * for 50 minutes. Public so it can be unit-tested without the network.
   */
  async getAuthToken(now: number = Date.now()): Promise<string> {
    if (this.cachedToken && now - this.cachedToken.issuedAt < TOKEN_LIFETIME_MS)
      return this.cachedToken.value;
    if (!this.key) this.key = await importPKCS8(this.config.privateKeyPem, "ES256");
    const value = await new SignJWT({ iss: this.config.teamId })
      .setProtectedHeader({ alg: "ES256", kid: this.config.keyId })
      .setIssuedAt(Math.floor(now / 1_000))
      .sign(this.key);
    this.cachedToken = { value, issuedAt: now };
    return value;
  }

  async sendSilent(deviceTokens: string[], payload: SilentPushPayload): Promise<PushReport> {
    return this.deliver(deviceTokens, {
      pushType: "background",
      priority: 5,
      collapseId: payload.reason.slice(0, 64),
      // Custom keys first so they can never override `aps` / `reason`.
      body: { ...(payload.data ?? {}), aps: { "content-available": 1 }, reason: payload.reason },
    });
  }

  async sendAlert(deviceTokens: string[], payload: AlertPushPayload): Promise<PushReport> {
    return this.deliver(deviceTokens, {
      pushType: "alert",
      priority: 10,
      body: {
        ...(payload.data ?? {}),
        aps: {
          alert: { title: payload.title, body: payload.body },
          ...(payload.badge !== undefined ? { badge: payload.badge } : {}),
          sound: payload.sound ?? "default",
          ...(payload.threadId ? { "thread-id": payload.threadId } : {}),
        },
      },
    });
  }

  /** Build the APNs request headers for a notification (exposed for tests). */
  async buildHeaders(deviceToken: string, request: ApnsRequest): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      [constants.HTTP2_HEADER_METHOD]: "POST",
      [constants.HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
      [constants.HTTP2_HEADER_AUTHORITY]: new URL(this.host).host,
      authorization: `bearer ${await this.getAuthToken()}`,
      "apns-topic": this.config.bundleId,
      "apns-push-type": request.pushType,
      "apns-priority": String(request.priority),
      "content-type": "application/json",
    };
    if (request.collapseId) headers["apns-collapse-id"] = request.collapseId;
    return headers;
  }

  /** Close the HTTP/2 session (tests / shutdown). */
  close(): void {
    this.session?.close();
    this.session = undefined;
  }

  private async deliver(deviceTokens: string[], request: ApnsRequest): Promise<PushReport> {
    const unique = [...new Set(deviceTokens.filter((t) => /^[0-9a-fA-F]{32,200}$/.test(t)))];
    const report: PushReport = {
      provider: "apns",
      requested: deviceTokens.length,
      sent: 0,
      failed: 0,
      invalidTokens: [],
      failures: [],
    };
    for (const token of deviceTokens) {
      if (!unique.includes(token)) {
        report.failed++;
        report.failures.push({ token, status: 0, reason: "MalformedToken" });
        report.invalidTokens.push(token);
      }
    }
    if (unique.length === 0) return report;

    const body = JSON.stringify(request.body);
    const results = await Promise.all(unique.map((token) => this.sendOne(token, request, body)));
    for (const result of results) {
      if (result === null) {
        report.sent++;
      } else {
        report.failed++;
        report.failures.push(result);
        if (INVALID_TOKEN_REASONS.has(result.reason) || result.status === 410)
          report.invalidTokens.push(result.token);
      }
    }
    if (report.failed > 0) {
      logger.warn(
        { sent: report.sent, failed: report.failed, invalid: report.invalidTokens.length },
        "apns delivery",
      );
    }
    return report;
  }

  private getSession(): ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
    const session = connect(this.host);
    session.setTimeout(SESSION_IDLE_MS, () => session.close());
    session.on("error", (err) => {
      logger.error({ error: errorSummary(err) }, "apns session error");
      if (this.session === session) this.session = undefined;
    });
    session.on("close", () => {
      if (this.session === session) this.session = undefined;
    });
    this.session = session;
    return session;
  }

  private async sendOne(
    token: string,
    request: ApnsRequest,
    body: string,
  ): Promise<PushFailure | null> {
    const headers = await this.buildHeaders(token, request);
    const timeoutMs = this.config.requestTimeoutMs ?? 10_000;
    return new Promise<PushFailure | null>((resolve) => {
      let settled = false;
      const finish = (value: PushFailure | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        const stream = this.getSession().request(headers);
        const timer = setTimeout(() => {
          stream.close(constants.NGHTTP2_CANCEL);
          finish({ token, status: 0, reason: "Timeout" });
        }, timeoutMs);
        let status = 0;
        const chunks: Buffer[] = [];
        stream.on("response", (responseHeaders) => {
          status = Number(responseHeaders[constants.HTTP2_HEADER_STATUS] ?? 0);
        });
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => {
          clearTimeout(timer);
          if (status === 200) return finish(null);
          let reason = `HTTP_${status}`;
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              reason?: string;
            };
            if (parsed.reason) reason = parsed.reason;
          } catch {
            // keep HTTP status reason
          }
          finish({ token, status, reason });
        });
        stream.on("error", (err) => {
          clearTimeout(timer);
          finish({ token, status: 0, reason: errorSummary(err).message });
        });
        stream.end(body);
      } catch (err) {
        finish({ token, status: 0, reason: errorSummary(err).message });
      }
    });
  }
}
