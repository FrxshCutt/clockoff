/**
 * Push delivery contract. Device tokens are raw APNs hex tokens (callers decrypt
 * `Device.pushTokenEncrypted` first). Payloads carry operational data only (§12).
 */
export interface SilentPushPayload {
  /** Why the device should sync, e.g. `schedule_changed`, `policy_changed`. */
  reason: string;
  data?: Record<string, string | number | boolean | null>;
}

export interface AlertPushPayload {
  title: string;
  body: string;
  data?: Record<string, string | number | boolean | null>;
  badge?: number;
  sound?: string;
  /** APNs `thread-id` for grouping. */
  threadId?: string;
}

export interface PushFailure {
  token: string;
  status: number;
  reason: string;
}

export interface PushReport {
  provider: "noop" | "apns";
  requested: number;
  sent: number;
  failed: number;
  /** Tokens APNs reported as unregistered / bad; callers should clear them from the device. */
  invalidTokens: string[];
  failures: PushFailure[];
}

export interface PushProvider {
  readonly name: "noop" | "apns";
  sendSilent(deviceTokens: string[], payload: SilentPushPayload): Promise<PushReport>;
  sendAlert(deviceTokens: string[], payload: AlertPushPayload): Promise<PushReport>;
}
