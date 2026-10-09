import type { Prisma } from "@clockoff/db";
import type { IntegrationProvider } from "@clockoff/shared/enums";
import {
  emptyAlertDelivery,
  notifyAuthError,
  type AuthErrorReason,
  type IntegrationAlertDelivery,
} from "./notifications";
import { setConnectionStatus, type ConnectionStatusChange } from "./status";

/**
 * Connection health (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §8). Build stage 3 provides what a run slice
 * needs: the thresholds, `reconnectHref()` and `enterAuthError()`. Build stage 4 adds the evaluation the upkeep job
 * runs (`DEGRADED` by time, recovery, the 6-hour email), the auth probes and the banners.
 */

type Db = Prisma.TransactionClient;

/** No successful sync for this long → DEGRADED (from `lastSuccessfulSyncAt`, else `onboardingCompletedAt`). */
export const DEGRADED_AFTER_MS = 60 * 60_000;
/** Still DEGRADED this long after the last success → email every member once per incident. */
export const DEGRADED_EMAIL_AFTER_MS = 6 * 3_600_000;
/** Scheduled cadence. */
export const SYNC_INTERVAL_MS = 15 * 60_000;
/** "Sync now" throttle. */
export const MANUAL_SYNC_MIN_INTERVAL_MS = 60_000;
/** The first automatic auth probe runs this long after entering AUTH_ERROR (§7.9 step 3). */
export const FIRST_AUTH_PROBE_DELAY_MS = 5 * 60_000;

/**
 * Where "Reconnect" leads (§8.3): the Integrations card's reconnect panel once onboarding is complete, the
 * wizard's connect step before that. Also used by the email, the notification and the connect-link redirect.
 */
export function reconnectHref(connection: { onboardingCompletedAt: Date | null }): string {
  return connection.onboardingCompletedAt
    ? "/integrations?planday=reconnect"
    : "/onboarding/planday?step=connect";
}

export interface EnterAuthErrorInput {
  organisationId: string;
  integrationId: string;
  provider: IntegrationProvider;
  /** The slice's `credential_version` (`store.knownVersion()`): a disconnect or reconnect since makes this a no-op. */
  credentialVersion?: number;
  /** The run's error code (`PLANDAY_AUTH_FAILED`, `PLANDAY_SCOPE_MISSING`, `INTEGRATION_PORTAL_MISMATCH`, …). */
  errorCode: string;
  /** Sanitised, from ClockOff's own message table (≤ 300 characters). */
  errorMessage: string;
  reason: AuthErrorReason;
  onboardingCompletedAt: Date | null;
  /** Business clock: the first automatic auth probe is due `FIRST_AUTH_PROBE_DELAY_MS` later. */
  now: Date;
}

export interface EnterAuthErrorResult {
  /** Null when the connection was not CONNECTED / SYNCING / DEGRADED at this credential version. */
  change: ConnectionStatusChange | null;
  /** The alert to deliver after commit (empty unless this call won the `auth_error_notified_at` guard). */
  delivery: IntegrationAlertDelivery;
}

/**
 * Moves the connection to AUTH_ERROR (§8.1) inside `tx`: a compare-and-set from CONNECTED, SYNCING or DEGRADED at the
 * caller's `credential_version`, so a slice can never turn a deliberate disconnect (or a reconnect made since it
 * started) into AUTH_ERROR. A connection already in AUTH_ERROR (a failed `retryAuth` run or auth probe) is left as
 * it is: no new notification, no email. The winner records the error, schedules the first auth probe and claims the
 * `auth_error_notified_at` guard; only the guard's winner notifies (§8.4).
 */
export async function enterAuthError(
  tx: Db,
  input: EnterAuthErrorInput,
): Promise<EnterAuthErrorResult> {
  const change = await setConnectionStatus(tx, input.integrationId, "AUTH_ERROR", {
    from: ["CONNECTED", "SYNCING", "DEGRADED"],
    ...(input.credentialVersion !== undefined
      ? { credentialVersion: input.credentialVersion }
      : {}),
    reason: input.errorCode,
  });
  if (!change) return { change: null, delivery: emptyAlertDelivery() };

  const probeAt = new Date(input.now.getTime() + FIRST_AUTH_PROBE_DELAY_MS);
  await tx.$executeRaw`
    UPDATE integration_connections
       SET last_error_code = ${input.errorCode},
           last_error = ${input.errorMessage.slice(0, 300)},
           next_sync_at = ${probeAt}::timestamptz,
           auth_probe_attempts = 0,
           updated_at = now()
     WHERE integration_id = ${input.integrationId}::uuid AND status = 'AUTH_ERROR'`;
  // Only the winner of this guard notifies; it is cleared on every transition out of AUTH_ERROR (§8.4).
  const guard = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE integration_connections SET auth_error_notified_at = now(), updated_at = now()
     WHERE integration_id = ${input.integrationId}::uuid
       AND status = 'AUTH_ERROR' AND auth_error_notified_at IS NULL
    RETURNING id::text AS id`;
  if (guard.length === 0) return { change, delivery: emptyAlertDelivery() };
  const delivery = await notifyAuthError(tx, {
    organisationId: input.organisationId,
    integrationId: input.integrationId,
    provider: input.provider,
    reason: input.reason,
    reconnectHref: reconnectHref(input),
  });
  return { change, delivery };
}
