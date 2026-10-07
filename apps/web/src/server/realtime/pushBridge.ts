import { prisma } from "@clockoff/db";
import { decryptToString } from "@/lib/crypto";
import { childLogger, errorSummary } from "@/lib/logger";
import { getEventBus, type EventBus, type RealtimeEvent, type Unsubscribe } from "@/server/events";
import { getPushProvider } from "@/server/push";

/**
 * Bus → silent push bridge (§10). When a policy, break policy, schedule or override changes, the
 * employees' phones must re-sync; this module turns the organisation bus events below into
 * content-available pushes through the configured `PushProvider`, debounced per device so a burst of
 * edits (bulk import, series update) sends one push.
 *
 * The in-process bus is keyed by organisation, so there is no wildcard subscription: an organisation is
 * bridged lazily by `ensureOrganisationBridged` (called from the mobile endpoints, the overrides service,
 * the realtime stream and every job tick) and eagerly by `startPushBridge()` in the job process for every
 * organisation with an active device. Subscriptions are tracked per bus instance, so a test that installs
 * a fresh `InProcessEventBus` re-bridges cleanly.
 *
 * Privacy (§12): tokens are decrypted only for the provider call and never logged; log lines carry counts
 * and reasons only.
 */

export const PUSH_DEBOUNCE_MS = 5_000;

/** Bus event kinds that make a device re-sync. */
export const PUSH_BRIDGE_EVENT_TYPES = [
  "POLICY_CHANGED",
  "BREAK_POLICY_CHANGED",
  "SCHEDULE_CHANGED",
  "OVERRIDE_CREATED",
  "OVERRIDE_REVOKED",
  "OVERRIDE_EXPIRED",
] as const;
export type PushBridgeEventType = (typeof PUSH_BRIDGE_EVENT_TYPES)[number];

const PUSH_REASON: Record<PushBridgeEventType, string> = {
  POLICY_CHANGED: "policy_changed",
  BREAK_POLICY_CHANGED: "break_policy_changed",
  SCHEDULE_CHANGED: "schedule_changed",
  OVERRIDE_CREATED: "override_changed",
  OVERRIDE_REVOKED: "override_changed",
  OVERRIDE_EXPIRED: "override_changed",
};

interface PendingPush {
  organisationId: string;
  reasons: Set<string>;
  timer: ReturnType<typeof setTimeout>;
}

interface PushBridgeState {
  /** Organisations bridged on each bus instance → their unsubscribe functions. */
  bridged: WeakMap<EventBus, Map<string, Unsubscribe>>;
  /** Debounced pushes by device id. */
  pending: Map<string, PendingPush>;
  /** Device lookups still running (awaited by `flushPushBridgeForTesting`). */
  inFlight: Set<Promise<void>>;
  /** Pushes delivered since the last reset (diagnostics / tests). */
  delivered: number;
}

declare global {
  var __clockoffPushBridge: PushBridgeState | undefined;
}

function state(): PushBridgeState {
  if (!globalThis.__clockoffPushBridge) {
    globalThis.__clockoffPushBridge = {
      bridged: new WeakMap(),
      pending: new Map(),
      inFlight: new Set(),
      delivered: 0,
    };
  }
  return globalThis.__clockoffPushBridge;
}

const log = childLogger({ module: "pushBridge" });

function isBridgeEvent(type: string): type is PushBridgeEventType {
  return (PUSH_BRIDGE_EVENT_TYPES as readonly string[]).includes(type);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * Which employees an event affects: a list of ids, `null` for "every active device of the organisation",
 * or `undefined` when the event is not a bridge event.
 */
export function affectedEmployeeIds(event: RealtimeEvent): string[] | null | undefined {
  if (!isBridgeEvent(event.type)) return undefined;
  const payload = event.payload ?? {};
  switch (event.type) {
    case "POLICY_CHANGED":
    case "BREAK_POLICY_CHANGED":
      return stringArray(payload.affectedEmployeeIds);
    case "SCHEDULE_CHANGED": {
      const id =
        event.employeeId ?? (typeof payload.employeeId === "string" ? payload.employeeId : null);
      return id ? [id] : null;
    }
    case "OVERRIDE_CREATED":
    case "OVERRIDE_REVOKED":
    case "OVERRIDE_EXPIRED": {
      const id =
        typeof payload.employeeId === "string" ? payload.employeeId : (event.employeeId ?? null);
      return id ? [id] : null;
    }
    default: {
      const exhaustive: never = event.type;
      throw new Error(`Unhandled bridge event ${String(exhaustive)}`);
    }
  }
}

/** The raw APNs token stored (encrypted) on a device row, or null when absent / undecryptable. */
export function decryptPushToken(encrypted: Uint8Array | null): string | null {
  if (!encrypted || encrypted.byteLength === 0) return null;
  try {
    const parsed = JSON.parse(decryptToString(Buffer.from(encrypted))) as { token?: unknown };
    return typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : null;
  } catch {
    return null;
  }
}

async function deliver(deviceId: string, pending: PendingPush): Promise<void> {
  const s = state();
  s.pending.delete(deviceId);
  try {
    const device = await prisma.device.findFirst({
      where: { id: deviceId, organisationId: pending.organisationId, isActive: true },
      select: { pushTokenEncrypted: true },
    });
    const token = device ? decryptPushToken(device.pushTokenEncrypted) : null;
    if (!token) return;
    const reasons = [...pending.reasons].sort();
    const report = await getPushProvider().sendSilent([token], {
      reason: reasons.join(","),
      data: { reasons: reasons.join(",") },
    });
    s.delivered += report.sent;
    if (report.invalidTokens.includes(token)) {
      // APNs says the token is gone: forget it so we stop trying (the app re-registers on next launch).
      await prisma.device.updateMany({
        where: { id: deviceId, organisationId: pending.organisationId },
        data: { pushTokenEncrypted: null },
      });
    }
    log.debug(
      { deviceId, reasons: reasons.join(","), sent: report.sent, failed: report.failed },
      "silent push",
    );
  } catch (err) {
    log.error({ error: errorSummary(err), deviceId }, "silent push failed");
  }
}

function enqueue(organisationId: string, deviceId: string, reason: string): void {
  const s = state();
  const existing = s.pending.get(deviceId);
  if (existing) {
    existing.reasons.add(reason);
    clearTimeout(existing.timer);
  }
  const entry: PendingPush = {
    organisationId,
    reasons: existing?.reasons ?? new Set([reason]),
    timer: setTimeout(() => void deliver(deviceId, entry), PUSH_DEBOUNCE_MS),
  };
  entry.timer.unref?.();
  s.pending.set(deviceId, entry);
}

async function schedulePushes(
  organisationId: string,
  employeeIds: string[] | null,
  reason: string,
): Promise<void> {
  if (employeeIds !== null && employeeIds.length === 0) return;
  const devices = await prisma.device.findMany({
    where: {
      organisationId,
      isActive: true,
      pushTokenEncrypted: { not: null },
      ...(employeeIds ? { employeeId: { in: employeeIds } } : {}),
    },
    select: { id: true },
  });
  for (const device of devices) enqueue(organisationId, device.id, reason);
}

function handleEvent(event: RealtimeEvent): void {
  const employeeIds = affectedEmployeeIds(event);
  if (employeeIds === undefined) return;
  const s = state();
  const reason = PUSH_REASON[event.type as PushBridgeEventType];
  const task = schedulePushes(event.organisationId, employeeIds, reason).catch((err: unknown) => {
    log.error(
      { error: errorSummary(err), eventType: event.type },
      "push bridge: device lookup failed",
    );
  });
  s.inFlight.add(task);
  void task.finally(() => s.inFlight.delete(task));
}

/** Subscribe the bridge to `organisationId` on the current bus (idempotent per bus instance). */
export function ensureOrganisationBridged(
  organisationId: string,
  bus: EventBus = getEventBus(),
): void {
  const s = state();
  let map = s.bridged.get(bus);
  if (!map) {
    map = new Map();
    s.bridged.set(bus, map);
  }
  if (map.has(organisationId)) return;
  map.set(organisationId, bus.subscribe(organisationId, handleEvent));
}

export function isOrganisationBridged(
  organisationId: string,
  bus: EventBus = getEventBus(),
): boolean {
  return state().bridged.get(bus)?.has(organisationId) ?? false;
}

/** Job-process startup: bridge every organisation that has an active device. Returns the count. */
export async function startPushBridge(bus: EventBus = getEventBus()): Promise<number> {
  const rows = await prisma.device.findMany({
    where: { isActive: true },
    select: { organisationId: true },
    distinct: ["organisationId"],
  });
  for (const row of rows) ensureOrganisationBridged(row.organisationId, bus);
  return rows.length;
}

/** Deliver every debounced push now (tests, graceful shutdown). */
export async function flushPushBridge(): Promise<void> {
  const s = state();
  while (s.inFlight.size > 0) await Promise.all([...s.inFlight]);
  const entries = [...s.pending.entries()];
  for (const [, entry] of entries) clearTimeout(entry.timer);
  await Promise.all(entries.map(([deviceId, entry]) => deliver(deviceId, entry)));
}

/** Drop pending pushes and subscriptions on the current bus (tests). */
export function resetPushBridgeForTesting(bus: EventBus = getEventBus()): void {
  const s = state();
  for (const entry of s.pending.values()) clearTimeout(entry.timer);
  s.pending.clear();
  s.inFlight.clear();
  s.delivered = 0;
  const map = s.bridged.get(bus);
  if (map) {
    for (const unsubscribe of map.values()) unsubscribe();
    map.clear();
  }
}

export function pushBridgeDiagnostics(): { pending: number; delivered: number } {
  const s = state();
  return { pending: s.pending.size, delivered: s.delivered };
}
