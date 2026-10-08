import type { RealtimeEvent } from "./EventBus";

/**
 * Wire format of a realtime event on the Postgres NOTIFY channel: `{"v":1,"o":"<originId>","e":<event>}`.
 * `o` is the publishing bus's id, so a process ignores its own notifications (it already delivered them
 * locally). Postgres rejects NOTIFY payloads of 8000 bytes or more; envelopes are capped at
 * {@link NOTIFY_MAX_BYTES} UTF-8 bytes to keep a margin.
 */

export const ENVELOPE_VERSION = 1;
export const NOTIFY_MAX_BYTES = 7500;

export interface EncodedEnvelope {
  /** The NOTIFY payload. */
  payload: string;
  /** UTF-8 byte length of `payload`. */
  bytes: number;
  /** The event's payload was replaced by `{ truncated: true }` to fit. */
  truncated: boolean;
}

export interface DecodedEnvelope {
  originId: string;
  event: RealtimeEvent;
}

/**
 * The event with its payload replaced by `{ truncated: true }`; type, organisation, employee and `at` are
 * kept. Consumers read it as "refetch" (dashboards) and "every device" (push bridge, except
 * `SCHEDULE_CHANGED`, which keeps its top-level `employeeId`).
 */
export function truncatedEvent(event: RealtimeEvent): RealtimeEvent {
  return {
    type: event.type,
    organisationId: event.organisationId,
    ...(event.employeeId !== undefined ? { employeeId: event.employeeId } : {}),
    payload: { truncated: true },
    at: event.at,
  };
}

/** Like {@link truncatedEvent} without the employee: "something of this type changed in the organisation". */
export function organisationWideTruncatedEvent(event: RealtimeEvent): RealtimeEvent {
  return {
    type: event.type,
    organisationId: event.organisationId,
    payload: { truncated: true },
    at: event.at,
  };
}

function serialise(originId: string, event: RealtimeEvent): string {
  return JSON.stringify({ v: ENVELOPE_VERSION, o: originId, e: event });
}

/**
 * The NOTIFY payload for `event`, truncated when the full envelope exceeds `maxBytes`; `null` when even
 * the truncated envelope does not fit (an absurdly long type or id — the caller drops and logs it).
 */
export function encodeEnvelope(
  originId: string,
  event: RealtimeEvent,
  maxBytes: number = NOTIFY_MAX_BYTES,
): EncodedEnvelope | null {
  const full = serialise(originId, event);
  const fullBytes = Buffer.byteLength(full, "utf8");
  if (fullBytes <= maxBytes) return { payload: full, bytes: fullBytes, truncated: false };
  const short = serialise(originId, truncatedEvent(event));
  const shortBytes = Buffer.byteLength(short, "utf8");
  if (shortBytes <= maxBytes) return { payload: short, bytes: shortBytes, truncated: true };
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Parses a NOTIFY payload. `null` for anything that is not a well-formed version-1 envelope (malformed
 * JSON, another version, a foreign sender's message, missing or mistyped event fields).
 */
export function decodeEnvelope(text: string): DecodedEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || parsed.v !== ENVELOPE_VERSION || !nonEmptyString(parsed.o)) {
    return null;
  }
  const e = parsed.e;
  if (
    !isPlainObject(e) ||
    !nonEmptyString(e.type) ||
    !nonEmptyString(e.organisationId) ||
    !isPlainObject(e.payload) ||
    !nonEmptyString(e.at) ||
    (e.employeeId !== undefined && !nonEmptyString(e.employeeId))
  ) {
    return null;
  }
  return {
    originId: parsed.o,
    event: {
      type: e.type,
      organisationId: e.organisationId,
      ...(e.employeeId !== undefined ? { employeeId: e.employeeId as string } : {}),
      payload: e.payload,
      at: e.at,
    },
  };
}
