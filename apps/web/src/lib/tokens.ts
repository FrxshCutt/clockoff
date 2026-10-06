import { randomToken, sha256Hex } from "@/lib/crypto";

/**
 * Opaque single-use / bearer tokens. The raw value is given to the user exactly once (cookie, email
 * link, JSON body); only its sha256 is stored. Lookups hash the presented value and compare.
 */

export interface GeneratedToken {
  /** Base64url, 43 chars for 32 bytes. Never persist this. */
  raw: string;
  /** sha256 hex of `raw`; this is what the database stores. */
  hash: string;
}

export function generateToken(bytes = 32): GeneratedToken {
  const raw = randomToken(bytes);
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw: string): string {
  return sha256Hex(raw);
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export const EMAIL_VERIFICATION_TOKEN_TTL_MS = 24 * HOUR_MS;
export const PASSWORD_RESET_TOKEN_TTL_MS = 1 * HOUR_MS;
export const MANAGER_INVITE_TTL_MS = 7 * DAY_MS;

export function expiresIn(ms: number, from: Date = new Date()): Date {
  return new Date(from.getTime() + ms);
}

export function isExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}
