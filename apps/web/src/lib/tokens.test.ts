import { describe, expect, it } from "vitest";
import { sha256Hex } from "./crypto";
import {
  DAY_MS,
  MANAGER_INVITE_TTL_MS,
  expiresIn,
  generateToken,
  hashToken,
  isExpired,
} from "./tokens";

describe("opaque tokens", () => {
  it("returns the raw value once and its sha256 for storage", () => {
    const { raw, hash } = generateToken();
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toBe(sha256Hex(raw));
    expect(hashToken(raw)).toBe(hash);
  });

  it("computes expiry instants", () => {
    const from = new Date("2026-10-06T00:00:00.000Z");
    expect(expiresIn(MANAGER_INVITE_TTL_MS, from).toISOString()).toBe("2026-10-13T00:00:00.000Z");
    expect(isExpired(new Date(from.getTime() + DAY_MS), from)).toBe(false);
    expect(isExpired(from, from)).toBe(true);
  });
});
