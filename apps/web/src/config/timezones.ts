/** IANA time-zone helpers for pickers. Values are validated server-side with `timezoneSchema`. */

const FALLBACK_TIME_ZONES = [
  "UTC",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Amsterdam",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
] as const;

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone });
    return true;
  } catch {
    return false;
  }
}

let cachedZones: readonly string[] | null = null;

/** Every zone the runtime supports (sorted, always including UTC). */
export function getTimeZones(): readonly string[] {
  if (cachedZones) return cachedZones;
  let zones: string[] = [];
  try {
    zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  } catch {
    zones = [];
  }
  if (zones.length === 0) zones = [...FALLBACK_TIME_ZONES];
  const set = new Set(zones);
  set.add("UTC");
  cachedZones = [...set].sort((a, b) => a.localeCompare(b));
  return cachedZones;
}

/** The viewer's zone from the browser, or `fallback` when unavailable/invalid. */
export function detectTimeZone(fallback = "UTC"): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isValidTimeZone(zone) ? zone : fallback;
  } catch {
    return fallback;
  }
}
