import type { Prisma } from "@clockoff/db";
import type { IntegrationProvider } from "@clockoff/shared/enums";
import { childLogger } from "@/lib/logger";
import { publishNotificationCreated, type NotificationRow } from "@/server/notifications";

/**
 * Integration alerts (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §8.4): in-app notifications and emails for
 * connection health and the pending-employee queue. Every `notify*` function runs inside the transaction of the
 * transition that caused it (the compare-and-set winner, so a retry or a second worker never notifies twice) and
 * returns an {@link IntegrationAlertDelivery} that the caller hands to {@link deliverIntegrationAlerts} after the
 * commit: notification rows are written with `publish: false` and published then, and emails are sent with
 * `sendEmailSafely` then.
 *
 * Build stage 3 fixes these signatures and only logs (ids, counts and reason classes; never names, emails or
 * Planday values). Build stage 4 writes the notification rows and the emails (the auth-error alert to every OWNER
 * and ADMIN regardless of opt-outs, D-055; the dedupe rules of §8.4).
 */

type Db = Prisma.TransactionClient;

const log = childLogger({ module: "integrationAlerts" });

/** Who an alert is about. */
export interface IntegrationAlertSubject {
  organisationId: string;
  integrationId: string;
  provider: IntegrationProvider;
}

/** What an alert wrote in its transaction, to publish and send after the commit. */
export interface IntegrationAlertDelivery {
  /** Stored with `publish: false`; `notification.created` is published after commit. */
  notifications: NotificationRow[];
  /** Sends to run after commit (each one uses `sendEmailSafely`, so none throws). */
  emails: Array<() => Promise<void>>;
}

export function emptyAlertDelivery(): IntegrationAlertDelivery {
  return { notifications: [], emails: [] };
}

/** After commit: publishes the notifications and fires the emails (never awaited by the caller's response). */
export function deliverIntegrationAlerts(...deliveries: readonly IntegrationAlertDelivery[]): void {
  for (const delivery of deliveries) {
    for (const row of delivery.notifications) publishNotificationCreated(row);
    for (const send of delivery.emails) {
      void send().catch((err: unknown) => {
        log.warn(
          { err: err instanceof Error ? err.name : "unknown" },
          "integration alert email failed",
        );
      });
    }
  }
}

/** Why a connection entered AUTH_ERROR, as the banner, notification and email name it (§8.3). */
export type AuthErrorReason =
  "ACCESS_REVOKED" | "MISSING_PERMISSION" | "DIFFERENT_PORTAL" | "MOCK_CONNECTION_IN_LIVE_MODE";

/**
 * Entering AUTH_ERROR (§8.4 row 1): `INTEGRATION_ERROR` notification and `integrationAuthErrorEmail` to every OWNER
 * and ADMIN, whatever their preferences. Called only by the winner of the `auth_error_notified_at` guard
 * (`enterAuthError` in health.ts).
 */
export async function notifyAuthError(
  _tx: Db,
  input: IntegrationAlertSubject & { reason: AuthErrorReason; reconnectHref: string },
): Promise<IntegrationAlertDelivery> {
  log.info(
    {
      organisationId: input.organisationId,
      integrationId: input.integrationId,
      provider: input.provider,
      reason: input.reason,
    },
    "integration auth error alert pending (notifications arrive with build stage 4)",
  );
  return emptyAlertDelivery();
}

/** Leaving AUTH_ERROR through an automatic auth probe (§8.4 row 2): `INTEGRATION_RECOVERED` to OWNER and ADMIN. */
export async function notifyRecovered(
  _tx: Db,
  input: IntegrationAlertSubject,
): Promise<IntegrationAlertDelivery> {
  log.info(
    { organisationId: input.organisationId, integrationId: input.integrationId },
    "integration recovered alert pending (notifications arrive with build stage 4)",
  );
  return emptyAlertDelivery();
}

/**
 * DEGRADED (§8.4 rows 3 and 4): `ENTERED` notifies OWNER and ADMIN in app (`degraded_notified_at` guard);
 * `STILL_DEGRADED` (6 h) notifies and emails every member (`degraded_email_sent_at` guard).
 */
export async function notifyDegraded(
  _tx: Db,
  input: IntegrationAlertSubject & {
    stage: "ENTERED" | "STILL_DEGRADED";
    lastSuccessfulSyncAt: Date | null;
  },
): Promise<IntegrationAlertDelivery> {
  log.info(
    {
      organisationId: input.organisationId,
      integrationId: input.integrationId,
      stage: input.stage,
    },
    "integration degraded alert pending (notifications arrive with build stage 4)",
  );
  return emptyAlertDelivery();
}

/**
 * The pending-employee queue (§8.4 rows 5 and 6): `INTEGRATION_NEW_EMPLOYEES` to OWNER and ADMIN, "N new employees
 * found in Planday — review" (`NEW_EMPLOYEES`) or "N Planday employees can no longer be found — review"
 * (`MISSING_EMPLOYEES`). Not created while an unread one exists for the integration.
 */
export async function notifyPendingEmployees(
  _tx: Db,
  input: IntegrationAlertSubject & {
    kind: "NEW_EMPLOYEES" | "MISSING_EMPLOYEES";
    count: number;
  },
): Promise<IntegrationAlertDelivery> {
  log.info(
    {
      organisationId: input.organisationId,
      integrationId: input.integrationId,
      kind: input.kind,
      count: input.count,
    },
    "integration pending-employee alert pending (notifications arrive with build stage 4)",
  );
  return emptyAlertDelivery();
}

/**
 * A department that appeared after onboarding (§6.3, §8.4 row 7): `INTEGRATION_DEPARTMENT_FOUND` to OWNER and
 * ADMIN, once per department id (the caller sets `catalog.departments[].notifiedAt` in the same transaction).
 */
export async function notifyDepartmentsFound(
  _tx: Db,
  input: IntegrationAlertSubject & { externalDepartmentIds: readonly string[] },
): Promise<IntegrationAlertDelivery> {
  log.info(
    {
      organisationId: input.organisationId,
      integrationId: input.integrationId,
      departments: input.externalDepartmentIds.length,
    },
    "integration department-found alert pending (notifications arrive with build stage 4)",
  );
  return emptyAlertDelivery();
}
