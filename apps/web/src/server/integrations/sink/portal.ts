import type { Prisma } from "@clockoff/db";
import type { ExternalPortal } from "@clockoff/shared/providers/workforceProvider";
import { notifyRecovered } from "../notifications";
import { setConnectionStatus } from "../status";
import type { SinkContext } from "./context";
import { writeCatalogPortal } from "./structure";

/**
 * PORTAL_CHECK's batch (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §7.2): the provider already compared the
 * portal id with the connection's (a mismatch fails the run with INTEGRATION_PORTAL_MISMATCH). The connection keeps
 * the portal's current name and time zone (not personal data), STRUCTURE records the child-portal count for step 2,
 * and in a `retryAuth` run a successful check is the connection test: AUTH_ERROR → CONNECTED (SYNCING for a SYNC run)
 * at once, compare-and-set at the slice's `credential_version` (§2.2), and an automatic probe tells OWNER / ADMIN the
 * connection recovered (§8.4).
 */

type Tx = Prisma.TransactionClient;

export async function applyPortal(tx: Tx, ctx: SinkContext, portal: ExternalPortal): Promise<void> {
  await tx.integrationConnection.updateMany({
    where: {
      integrationId: ctx.integrationId,
      externalPortalId: portal.externalId,
      status: { not: "DISCONNECTED" },
    },
    data: {
      externalPortalName: portal.name,
      ...(portal.timezone ? { externalPortalTimezone: portal.timezone } : {}),
    },
  });
  if (ctx.run.kind === "STRUCTURE") await writeCatalogPortal(tx, ctx, portal.childPortalCount);
  if (!ctx.run.retryAuth) return;
  const change = await setConnectionStatus(
    tx,
    ctx.integrationId,
    ctx.run.kind === "SYNC" ? "SYNCING" : "CONNECTED",
    {
      from: ["AUTH_ERROR"],
      credentialVersion: ctx.credentialVersion(),
      reason: "AUTH_RETRY_PASSED",
    },
  );
  if (!change) return;
  ctx.effects.statusChanges.push(change);
  if (ctx.run.trigger === "RECOVERY") {
    ctx.effects.alerts.push(
      await notifyRecovered(tx, {
        organisationId: ctx.organisationId,
        integrationId: ctx.integrationId,
        provider: ctx.provider,
      }),
    );
  }
}
