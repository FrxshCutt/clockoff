import { logger } from "@/lib/logger";
import type { AlertPushPayload, PushProvider, PushReport, SilentPushPayload } from "./PushProvider";

/**
 * Used when APNs is not configured. Logs the intent (counts only, never tokens or content) and reports
 * every token as "sent" so callers behave the same way; the iOS app falls back to BGAppRefresh /
 * foreground sync.
 */
export class NoopPushProvider implements PushProvider {
  readonly name = "noop" as const;

  async sendSilent(deviceTokens: string[], payload: SilentPushPayload): Promise<PushReport> {
    logger.info(
      { count: deviceTokens.length, reason: payload.reason },
      "push (noop): silent push not sent (APNs not configured)",
    );
    return this.report(deviceTokens.length);
  }

  async sendAlert(deviceTokens: string[], payload: AlertPushPayload): Promise<PushReport> {
    logger.info(
      { count: deviceTokens.length, threadId: payload.threadId },
      "push (noop): alert push not sent (APNs not configured)",
    );
    return this.report(deviceTokens.length);
  }

  private report(requested: number): PushReport {
    return {
      provider: "noop",
      requested,
      sent: requested,
      failed: 0,
      invalidTokens: [],
      failures: [],
    };
  }
}
