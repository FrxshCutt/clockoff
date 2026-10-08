import { prisma } from "@clockoff/db";
import { decryptToString } from "@/lib/crypto";
import { childLogger, errorSummary } from "@/lib/logger";
import {
  getEventBus,
  isPushBridgeEventType,
  type EventBus,
  type PushBridgeEventType,
  type RealtimeEvent,
  type Unsubscribe,
} from "@/server/events";
import { getPushProvider } from "@/server/push";

/**
 * Bus → silent push bridge (§10). When a policy, break policy, schedule or override changes, the
 * employees' phones must re-sync; this module turns the bus events below into content-available pushes
 * through the configured `PushProvider`, debounced per device so a burst of edits (bulk import, series
 * update) sends one push.
 *
 * Ownership: the realtime bus carries every event to every process (Postgres LISTEN/NOTIFY), so a bridge
 * in more than one process would push every change twice. Only the worker that holds the push-bridge
 * leadership lease calls {@link enablePushBridge} (one all-organisations subscription); it calls
 * {@link disablePushBridge} when it loses the lease or shuts down. The web process never bridges. The
 * leader also passes `stillLeader` (its lease is still held): checked when an event arrives, when a
 * device lookup finishes and right before each send, so a leader whose lock session just died sends
 * nothing more, even before it has disabled the bridge.
 *
 * A truncated event (`payload: { truncated: true }`, see `server/events/envelope.ts`) has lost its
 * employee list: policy events then reach every active device of the organisation (a safe superset),
 * schedule and override events keep their top-level `employeeId` when they had one.
 *
 * Privacy (§12): tokens are decrypted only for the provider call and never logged; log lines carry counts
 * and reasons only.
 */

export const PUSH_DEBOUNCE_MS = 5_000;

/** Bus event kinds that make a device re-sync (declared next to the bus, which never drops them). */
export { PUSH_BRIDGE_EVENT_TYPES } from "@/server/events";
export type { PushBridgeEventType } from "@/server/events";

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
  /** The all-organisations bus subscription while enabled (worker leader only). */
  subscription: { bus: EventBus; unsubscribe: Unsubscribe } | null;
  /** Debounced pushes by device id. */
  pending: Map<string, PendingPush>;
  /** Device lookups still running (awaited by `flushPushBridge`). */
  inFlight: Set<Promise<void>>;
  /** Pushes delivered since the last reset (diagnostics / tests). */
  delivered: number;
  /** The leader's "lease still held" check while enabled (null: always allowed). */
  stillLeader: (() => boolean) | null;
  /**
   * Bumped by every disable: a device lookup started before a `flush: false` disable finds a newer epoch
   * when it completes and enqueues nothing.
   */
  epoch: number;
}

declare global {
  var __clockoffPushBridge: PushBridgeState | undefined;
}

function state(): PushBridgeState {
  if (!globalThis.__clockoffPushBridge) {
    globalThis.__clockoffPushBridge = {
      subscription: null,
      pending: new Map(),
      inFlight: new Set(),
      delivered: 0,
      stillLeader: null,
      epoch: 0,
    };
  }
  return globalThis.__clockoffPushBridge;
}

const log = childLogger({ module: "pushBridge" });

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * Which employees an event affects: a list of ids, `null` for "every active device of the organisation",
 * or `undefined` when the event is not a bridge event. A truncated policy event has lost its list and
 * reaches every device.
 */
export function affectedEmployeeIds(event: RealtimeEvent): string[] | null | undefined {
  if (!isPushBridgeEventType(event.type)) return undefined;
  const payload = event.payload ?? {};
  switch (event.type) {
    case "POLICY_CHANGED":
    case "BREAK_POLICY_CHANGED":
      return payload.truncated === true ? null : stringArray(payload.affectedEmployeeIds);
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

/** False once the leader's lease is gone (see the module comment); true without a `stillLeader` check. */
function mayPush(): boolean {
  const check = state().stillLeader;
  return check === null || check();
}

async function deliver(deviceId: string, pending: PendingPush): Promise<void> {
  const s = state();
  if (s.pending.get(deviceId) === pending) s.pending.delete(deviceId);
  if (!mayPush()) {
    log.debug({ deviceId }, "silent push dropped: push bridge leadership lost");
    return;
  }
  try {
    const device = await prisma.device.findFirst({
      where: { id: deviceId, organisationId: pending.organisationId, isActive: true },
      select: { pushTokenEncrypted: true },
    });
    const token = device ? decryptPushToken(device.pushTokenEncrypted) : null;
    if (!token || !mayPush()) return;
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

function enqueue(organisationId: string, deviceId: string, reason: string, epoch: number): void {
  const s = state();
  if (epoch !== s.epoch || !mayPush()) return;
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
  epoch: number,
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
  for (const device of devices) enqueue(organisationId, device.id, reason, epoch);
}

function handleEvent(event: RealtimeEvent): void {
  const employeeIds = affectedEmployeeIds(event);
  if (employeeIds === undefined || !mayPush()) return;
  const s = state();
  const reason = PUSH_REASON[event.type as PushBridgeEventType];
  const task = schedulePushes(event.organisationId, employeeIds, reason, s.epoch).catch(
    (err: unknown) => {
      log.error(
        { error: errorSummary(err), eventType: event.type },
        "push bridge: device lookup failed",
      );
    },
  );
  s.inFlight.add(task);
  void task.finally(() => s.inFlight.delete(task));
}

/**
 * Starts bridging every organisation's events on `bus` (one all-organisations subscription). Idempotent:
 * a second call on the same bus changes nothing; a call with another bus moves the subscription there.
 * Called only by the worker holding the push-bridge leadership lease, with `stillLeader` checking that
 * lease (see the module comment).
 */
export function enablePushBridge(
  bus: EventBus = getEventBus(),
  options: { stillLeader?: () => boolean } = {},
): void {
  const s = state();
  s.stillLeader = options.stillLeader ?? null;
  if (s.subscription?.bus === bus) return;
  s.subscription?.unsubscribe();
  s.subscription = { bus, unsubscribe: bus.subscribeAll(handleEvent) };
  log.info("push bridge enabled");
}

/**
 * Stops bridging new events. With `flush` (the default) the pushes already debounced or being looked up
 * are delivered before this resolves (leadership hand-over, shutdown); with `flush: false` (the lease
 * was lost: another worker may already be leading) they are dropped, including lookups still running.
 * Safe to call when not enabled.
 */
export async function disablePushBridge(options: { flush?: boolean } = {}): Promise<void> {
  const s = state();
  const wasEnabled = s.subscription !== null;
  s.subscription?.unsubscribe();
  s.subscription = null;
  if (options.flush ?? true) {
    await flushPushBridge();
  } else {
    for (const entry of s.pending.values()) clearTimeout(entry.timer);
    s.pending.clear();
  }
  s.epoch += 1;
  s.stillLeader = null;
  if (wasEnabled) log.info({ flushed: options.flush ?? true }, "push bridge disabled");
}

export function isPushBridgeEnabled(): boolean {
  return state().subscription !== null;
}

/** Deliver every debounced push now (tests, leadership hand-over, graceful shutdown). */
export async function flushPushBridge(): Promise<void> {
  const s = state();
  while (s.inFlight.size > 0) await Promise.all([...s.inFlight]);
  const entries = [...s.pending.entries()];
  for (const [, entry] of entries) clearTimeout(entry.timer);
  await Promise.all(entries.map(([deviceId, entry]) => deliver(deviceId, entry)));
}

/** Unsubscribe, drop pending pushes and reset the counters (tests). */
export function resetPushBridgeForTesting(): void {
  const s = state();
  s.subscription?.unsubscribe();
  s.subscription = null;
  for (const entry of s.pending.values()) clearTimeout(entry.timer);
  s.pending.clear();
  s.inFlight.clear();
  s.delivered = 0;
  s.stillLeader = null;
  s.epoch += 1;
}

export function pushBridgeDiagnostics(): { enabled: boolean; pending: number; delivered: number } {
  const s = state();
  return { enabled: s.subscription !== null, pending: s.pending.size, delivered: s.delivered };
}
