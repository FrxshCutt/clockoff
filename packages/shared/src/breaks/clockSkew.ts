/**
 * Clock-skew helpers used by the break rules documentation and the device-status derivation.
 *
 * Server timestamps are authoritative for every break decision (`canStartBreak` receives `now` from the
 * server). The device reports its own clock on each sync; the difference is stored as
 * `Device.lastClockSkewSeconds`. Apple's DeviceActivity schedules follow the *device* clock, so a skewed
 * device applies/lifts restrictions at the wrong real-world moment even though the server state is
 * correct. That is why skew beyond the threshold is surfaced as NEEDS_ATTENTION rather than silently
 * corrected. See docs/BREAK_RULES.md § "Clock skew".
 */
import { DEVICE_STATUS_THRESHOLDS } from "../status/deriveDeviceStatus";

/**
 * |skew| strictly above this is shown to managers as NEEDS_ATTENTION ("Device clock is N s ahead of/behind
 * server time"). Single source of truth: `DEVICE_STATUS_THRESHOLDS.clockSkewSeconds` used by
 * `deriveDeviceStatus`, so the break docs, the device UI hint and the manager badge always agree.
 */
export const CLOCK_SKEW_ATTENTION_THRESHOLD_SECONDS: number =
  DEVICE_STATUS_THRESHOLDS.clockSkewSeconds;

/**
 * DeviceActivity cannot reliably fire for intervals shorter than this. A break timer below it is still
 * honoured by the server and by the app while open; if the app is closed, restrictions are restored
 * within this many minutes instead of exactly at `plannedEndsAt`.
 */
export const DEVICE_ACTIVITY_MIN_RELIABLE_INTERVAL_MINUTES = 15;

/**
 * Positive when the device clock is ahead of the server, negative when behind. Rounded to whole seconds
 * so it can be stored in `Device.lastClockSkewSeconds` (Int).
 */
export function computeClockSkewSeconds(deviceReportedAt: Date, serverReceivedAt: Date): number {
  return Math.round((deviceReportedAt.getTime() - serverReceivedAt.getTime()) / 1000);
}

/**
 * Converts a device-clock instant to the server clock using a skew from `computeClockSkewSeconds`
 * (`deviceInstant − skew`). Used when re-validating an offline break at its device-reported start.
 */
export function deviceInstantToServerTime(deviceInstant: Date, skewSeconds: number): Date {
  const skewMs = Number.isFinite(skewSeconds) ? skewSeconds * 1000 : 0;
  return new Date(deviceInstant.getTime() - skewMs);
}

/**
 * The server-clock instant at which a break requested from a device starts (`now` for `canStartBreak`):
 * `min(receivedAt, deviceInstantToServerTime(requestedAt, skewSeconds))`.
 *
 * - Online the result is the receive time minus network latency (within seconds of `receivedAt`).
 * - For a break the device started while offline it is the moment the employee tapped, on the server clock,
 *   so the break is validated and counted where it really happened instead of being granted afresh.
 * - It is never later than `receivedAt`: a device cannot pre-book a future start. Backdating cannot gain
 *   anything either — an earlier start is checked against the same history and ends earlier.
 *
 * `skewSeconds` is the device's last reported skew (`Device.lastClockSkewSeconds`); `null`/`undefined`/non-
 * finite means none is known and the device clock is taken as is. An invalid `requestedAt` yields
 * `receivedAt`.
 */
export function breakStartInstant(
  requestedAt: Date,
  receivedAt: Date,
  skewSeconds: number | null | undefined,
): Date {
  const requestedMs = requestedAt.getTime();
  if (!Number.isFinite(requestedMs)) return new Date(receivedAt.getTime());
  const serverMs = deviceInstantToServerTime(requestedAt, skewSeconds ?? 0).getTime();
  return new Date(Math.min(serverMs, receivedAt.getTime()));
}

/**
 * `true` when a reported skew should raise NEEDS_ATTENTION (|skew| > threshold, same rule as
 * `deriveDeviceStatus`). `null`/`undefined`/non-finite (never reported) → `false`.
 */
export function clockSkewNeedsAttention(
  skewSeconds: number | null | undefined,
  thresholdSeconds: number = CLOCK_SKEW_ATTENTION_THRESHOLD_SECONDS,
): boolean {
  if (skewSeconds === null || skewSeconds === undefined || !Number.isFinite(skewSeconds))
    return false;
  return Math.abs(skewSeconds) > thresholdSeconds;
}

/** `true` when a break of this length is too short for DeviceActivity to end it precisely with the app closed. */
export function isBelowDeviceActivityInterval(durationMinutes: number): boolean {
  return durationMinutes < DEVICE_ACTIVITY_MIN_RELIABLE_INTERVAL_MINUTES;
}
