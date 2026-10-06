import { describe, expect, it } from "vitest";
import { detectTimeZone, getTimeZones, isValidTimeZone } from "./timezones";

describe("time zones", () => {
  it("validates IANA identifiers with Intl", () => {
    expect(isValidTimeZone("Europe/London")).toBe(true);
    expect(isValidTimeZone("America/Argentina/Buenos_Aires")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });

  it("lists every supported zone once, sorted, always including UTC", () => {
    const zones = getTimeZones();
    expect(zones.length).toBeGreaterThan(100);
    expect(zones).toContain("UTC");
    expect(zones).toContain("Europe/London");
    expect(new Set(zones).size).toBe(zones.length);
    expect([...zones]).toEqual([...zones].sort((a, b) => a.localeCompare(b)));
    for (const zone of zones) expect(isValidTimeZone(zone), zone).toBe(true);
    expect(getTimeZones()).toBe(zones);
  });

  it("detects a valid zone for the runtime, or the fallback", () => {
    const detected = detectTimeZone("Europe/London");
    expect(isValidTimeZone(detected)).toBe(true);
  });
});
