import { randomUUID } from "node:crypto";
import { prisma } from "@clockoff/db";
import { flushEventBus, publishEvent } from "@/server/events";

/**
 * `node main.mjs emit-diagnostic <organisationId>` (D19): proves the cross-process realtime path end to
 * end. The worker publishes a `diagnostic.ping` event (payload `{ source: "worker", nonce }`) for the
 * organisation, waits until the queued NOTIFY is sent, and prints the nonce; a dashboard SSE stream of
 * that organisation (in the web process) then shows `event: diagnostic.ping` with the same nonce. The
 * type is not in `REALTIME_EVENT_TYPES`, so dashboards ignore it; raw SSE readers see it.
 */

export const DIAGNOSTIC_EVENT_TYPE = "diagnostic.ping";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export type EmitDiagnosticResult =
  | { ok: true; nonce: string }
  | { ok: false; reason: "INVALID_ORGANISATION_ID" | "UNKNOWN_ORGANISATION" };

export async function emitDiagnostic(
  organisationId: string,
  deps: {
    organisationExists?: (id: string) => Promise<boolean>;
    publish?: typeof publishEvent;
    flush?: (timeoutMs?: number) => Promise<void>;
    nonce?: () => string;
  } = {},
): Promise<EmitDiagnosticResult> {
  if (!isUuid(organisationId)) return { ok: false, reason: "INVALID_ORGANISATION_ID" };
  const exists =
    deps.organisationExists ??
    (async (id: string) =>
      (await prisma.organisation.findUnique({ where: { id }, select: { id: true } })) !== null);
  if (!(await exists(organisationId))) return { ok: false, reason: "UNKNOWN_ORGANISATION" };
  const nonce = (deps.nonce ?? randomUUID)();
  (deps.publish ?? publishEvent)({
    type: DIAGNOSTIC_EVENT_TYPE,
    organisationId,
    payload: { source: "worker", nonce },
  });
  await (deps.flush ?? flushEventBus)(5_000);
  return { ok: true, nonce };
}
