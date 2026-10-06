import { createHash, randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/**
 * Deterministic UUID for a seed key: the first 128 bits of sha256("workmode-seed:" + key) laid out as an
 * RFC 9562 UUID (version nibble 4, variant 10xx), so `@db.Uuid` columns and `z.uuid()` both accept it. The
 * same key yields the same id on every run — bookmarked dashboard URLs and e2e fixtures survive a re-seed.
 */
export function stableId(key: string): string {
  const hex = createHash("sha256").update(`workmode-seed:${key}`).digest("hex");
  const variantNibble = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  const body = `${hex.slice(0, 12)}4${hex.slice(13, 16)}${variantNibble}${hex.slice(17, 32)}`;
  return [
    body.slice(0, 8),
    body.slice(8, 12),
    body.slice(12, 16),
    body.slice(16, 20),
    body.slice(20, 32),
  ].join("-");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * sha256 of a fresh 32-byte base64url token — the shape `apps/web/src/lib/tokens.ts` stores. The raw token
 * is discarded: seeded invite links are never meant to be followed, only displayed.
 */
export function randomTokenHash(): string {
  return sha256Hex(randomBytes(32).toString("base64url"));
}

/** JSON-serialise for a `Json` column: `Date`s become ISO strings and `undefined` members are dropped. */
export function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MINUTE_MS);
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

/** Whole minutes, rounded up; never negative (same reading as the break rules). */
export function ceilMinutes(ms: number): number {
  return ms <= 0 ? 0 : Math.ceil(ms / MINUTE_MS);
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`seed: ${message}`);
}

/** Half-open `[startsAt, endsAt)` intervals must not overlap — the shifts API enforces the same rule. */
export function assertNoOverlaps(
  label: string,
  intervals: ReadonlyArray<{ startsAt: Date; endsAt: Date }>,
): void {
  const sorted = [...intervals].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous && current && current.startsAt.getTime() < previous.endsAt.getTime()) {
      throw new Error(
        `seed: overlapping shifts for ${label}: ` +
          `${previous.startsAt.toISOString()}–${previous.endsAt.toISOString()} and ` +
          `${current.startsAt.toISOString()}–${current.endsAt.toISOString()}`,
      );
    }
  }
}

/** `YYYY-MM-DD` → `DD/MM/YYYY` (the organisation's DMY date format, as a rota export would print it). */
export function toDmy(localDate: string): string {
  const [year = "", month = "", day = ""] = localDate.split("-");
  return `${day}/${month}/${year}`;
}
