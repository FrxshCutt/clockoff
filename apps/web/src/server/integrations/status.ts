import { Prisma } from "@clockoff/db";
import type {
  IntegrationConnectionStatus,
  IntegrationProvider,
  IntegrationStatus,
} from "@clockoff/shared/enums";
import { INTEGRATION_CONNECTION_STATUSES } from "@clockoff/shared/enums";
import { publishEvent } from "@/server/events";

/**
 * Connection status transitions (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §2.2, §8.1). One function,
 * {@link setConnectionStatus}, writes the fine-grained `IntegrationConnection.status` and the coarse
 * `Integration.status` in the caller's transaction. It is a compare-and-set: the row changes only while its status
 * is one of `from` (and, when given, its `credential_version` and `last_sync_at` are still the values the caller
 * read), so a caller that lost a race does nothing else — no notification, no email. Leaving AUTH_ERROR clears the
 * auth-error guards; leaving DEGRADED clears the degraded guards, so the next incident notifies again.
 *
 * The caller publishes the returned change after its transaction commits ({@link publishConnectionStatusChange}):
 * `integration.health.changed`, only for transitions that change the banner or the compliance flag.
 */

type Db = Prisma.TransactionClient;

/** Coarse `Integration.status` for each connection status (§2.2 table). */
export const COARSE_STATUS: Readonly<Record<IntegrationConnectionStatus, IntegrationStatus>> = {
  CONNECTING: "NOT_CONNECTED",
  CONNECTED: "CONNECTED",
  SYNCING: "CONNECTED",
  DEGRADED: "CONNECTED",
  AUTH_ERROR: "ERROR",
  DISCONNECTED: "DISCONNECTED",
};

export function coarseStatus(status: IntegrationConnectionStatus): IntegrationStatus {
  return COARSE_STATUS[status];
}

/** Statuses that show a banner or flag the compliance view (§7.11, §8.3, §8.5). */
const BANNER_STATUSES: ReadonlySet<IntegrationConnectionStatus> = new Set([
  "DEGRADED",
  "AUTH_ERROR",
  "DISCONNECTED",
]);

/** Whether moving `from` → `to` changes a banner or the compliance flag (never CONNECTED ↔ SYNCING). */
export function isHealthTransition(
  from: IntegrationConnectionStatus,
  to: IntegrationConnectionStatus,
): boolean {
  return from !== to && (BANNER_STATUSES.has(from) || BANNER_STATUSES.has(to));
}

export interface SetConnectionStatusOptions {
  /** Statuses the row may be in for the change to apply; `"ANY"` for every status (disconnect). */
  from: readonly IntegrationConnectionStatus[] | "ANY";
  /** Apply only while `credential_version` still has this value (a slice's fence, §7.6). */
  credentialVersion?: number;
  /** Apply only while `last_sync_at` still has this value (null included; the health evaluation, §7.9). */
  lastSyncAt?: Date | null;
  /** Free-form reason for logs and tests (never stored). */
  reason?: string;
}

export interface ConnectionStatusChange {
  organisationId: string;
  integrationId: string;
  provider: IntegrationProvider;
  from: IntegrationConnectionStatus;
  to: IntegrationConnectionStatus;
}

/**
 * Compare-and-set of the connection status (and the coarse integration status) inside `tx`. Returns the change,
 * or null when nothing changed (the status was not in `from`, already `next`, or a guard no longer matched).
 */
export async function setConnectionStatus(
  tx: Db,
  integrationId: string,
  next: IntegrationConnectionStatus,
  options: SetConnectionStatusOptions,
): Promise<ConnectionStatusChange | null> {
  const from = (options.from === "ANY" ? INTEGRATION_CONNECTION_STATUSES : options.from).filter(
    (status) => status !== next,
  );
  if (from.length === 0) return null;
  const versionGuard =
    options.credentialVersion === undefined
      ? Prisma.empty
      : Prisma.sql`AND c.credential_version = ${options.credentialVersion}`;
  const syncGuard =
    options.lastSyncAt === undefined
      ? Prisma.empty
      : Prisma.sql`AND c.last_sync_at IS NOT DISTINCT FROM ${options.lastSyncAt}::timestamptz`;
  const rows = await tx.$queryRaw<Array<{ prev: IntegrationConnectionStatus }>>`
    UPDATE integration_connections c
       SET status = ${next}::"IntegrationConnectionStatus",
           status_changed_at = now(),
           auth_error_notified_at = CASE WHEN p.prev = 'AUTH_ERROR' THEN NULL ELSE c.auth_error_notified_at END,
           auth_probe_attempts = CASE WHEN p.prev = 'AUTH_ERROR' THEN 0 ELSE c.auth_probe_attempts END,
           degraded_notified_at = CASE WHEN p.prev = 'DEGRADED' THEN NULL ELSE c.degraded_notified_at END,
           degraded_email_sent_at = CASE WHEN p.prev = 'DEGRADED' THEN NULL ELSE c.degraded_email_sent_at END,
           updated_at = now()
      FROM (SELECT id, status AS prev FROM integration_connections
             WHERE integration_id = ${integrationId}::uuid FOR UPDATE) p
     WHERE c.id = p.id
       AND c.status = ANY(${from}::"IntegrationConnectionStatus"[])
       ${versionGuard}
       ${syncGuard}
    RETURNING p.prev::text AS prev`;
  const prev = rows[0]?.prev;
  if (!prev) return null;
  const integrations = await tx.$queryRaw<
    Array<{ organisation_id: string; provider: IntegrationProvider }>
  >`
    UPDATE integrations SET status = ${coarseStatus(next)}::"IntegrationStatus", updated_at = now()
     WHERE id = ${integrationId}::uuid
    RETURNING organisation_id::text AS organisation_id, provider::text AS provider`;
  const integration = integrations[0];
  if (!integration) throw new Error("setConnectionStatus: the connection has no integration row");
  return {
    organisationId: integration.organisation_id,
    integrationId,
    provider: integration.provider,
    from: prev,
    to: next,
  };
}

/** After commit: the `integration.health.changed` hint, for banner-relevant transitions only (§7.11). */
export function publishConnectionStatusChange(change: ConnectionStatusChange | null): void {
  if (!change || !isHealthTransition(change.from, change.to)) return;
  publishEvent({
    type: "integration.health.changed",
    organisationId: change.organisationId,
    payload: {
      provider: change.provider,
      integrationId: change.integrationId,
      status: change.to,
    },
  });
}
