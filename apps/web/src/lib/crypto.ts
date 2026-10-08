import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { env } from "@/lib/env";

/**
 * Cryptographic primitives used across the server.
 *
 * - AES-256-GCM at rest for integration credentials / push tokens. Ciphertext layout:
 *   `iv (12 bytes) | auth tag (16 bytes) | ciphertext`. The key is `INTEGRATION_ENCRYPTION_KEY`
 *   (32 bytes, base64) unless an explicit key is supplied. Optional associated data (`aad`) binds a
 *   ciphertext to where it is stored: Planday secrets use `integration:<integrationId>:<column>`
 *   ({@link integrationAad}), so a value copied into another row or column fails to decrypt (D-038).
 * - sha256 hex for storing opaque tokens (sessions, reset/verification/invite/refresh tokens).
 * - base64url random tokens.
 * - constant-time comparison and HMAC-SHA256 (CSRF token signatures).
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export function getEncryptionKey(): Buffer {
  const key = Buffer.from(env().INTEGRATION_ENCRYPTION_KEY, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error("INTEGRATION_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return key;
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES)
    throw new Error(`Encryption key must be ${KEY_BYTES} bytes, got ${key.length}`);
}

/**
 * Associated data must be non-empty: GCM treats empty AAD exactly like none, which would silently drop the
 * binding (e.g. an `integration::refresh_token` built from a missing id is caught here instead).
 */
function aadBuffer(aad: string): Buffer {
  if (aad.length === 0) throw new Error("Associated data must not be empty");
  return Buffer.from(aad, "utf8");
}

/**
 * Encrypt with AES-256-GCM. Returns `iv | tag | ciphertext`. With `aad`, the same associated data must be
 * given to {@link decrypt}; it is authenticated, not stored.
 */
export function encrypt(
  plaintext: Buffer | string,
  key: Buffer = getEncryptionKey(),
  aad?: string,
): Buffer {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad !== undefined) cipher.setAAD(aadBuffer(aad));
  const input = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

/**
 * Decrypt `iv | tag | ciphertext` produced by {@link encrypt}. Throws on tampering, on a wrong key and when
 * `aad` differs from the associated data used to encrypt (including one given on only one side).
 */
export function decrypt(blob: Buffer, key: Buffer = getEncryptionKey(), aad?: string): Buffer {
  assertKey(key);
  if (blob.length < IV_BYTES + TAG_BYTES) throw new Error("Ciphertext too short");
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  if (aad !== undefined) decipher.setAAD(aadBuffer(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Convenience: decrypt to a UTF-8 string. */
export function decryptToString(blob: Buffer, key?: Buffer, aad?: string): string {
  return decrypt(blob, key, aad).toString("utf8");
}

/** The encrypted columns of `integration_connections` (each with its own associated data). */
export const INTEGRATION_SECRET_COLUMNS = ["client_id", "refresh_token", "access_token"] as const;
export type IntegrationSecretColumn = (typeof INTEGRATION_SECRET_COLUMNS)[number];

/** Associated data for an integration secret: `integration:<integrationId>:<column>` (D-038). */
export function integrationAad(integrationId: string, column: IntegrationSecretColumn): string {
  if (!integrationId) throw new Error("integrationAad needs the integration id");
  return `integration:${integrationId}:${column}`;
}

/** Associated data for an OAuth state row's PKCE verifier: `oauth_state:<stateId>`. */
export function oauthStateAad(stateId: string): string {
  if (!stateId) throw new Error("oauthStateAad needs the state row id");
  return `oauth_state:${stateId}`;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** `bytes` random bytes as base64url (no padding). 32 bytes → 43 chars. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Constant-time equality for strings/buffers of possibly different length. */
export function constantTimeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const bufA = typeof a === "string" ? Buffer.from(a, "utf8") : a;
  const bufB = typeof b === "string" ? Buffer.from(b, "utf8") : b;
  if (bufA.length !== bufB.length) {
    // Compare against itself to keep timing independent of the mismatch position, then fail.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function hmacSha256(key: string | Buffer, data: string | Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

export function hmacSha256Base64Url(key: string | Buffer, data: string | Buffer): string {
  return hmacSha256(key, data).toString("base64url");
}

/**
 * Signed CSRF token: `<random>.<hmac(SESSION_SECRET, random)>`. The signature prevents a cookie
 * planted by a sibling sub-domain from being accepted; the double-submit comparison itself is done
 * by {@link verifyCsrfPair}.
 */
export function createCsrfToken(secret: string = env().SESSION_SECRET): string {
  const nonce = randomToken(32);
  return `${nonce}.${hmacSha256Base64Url(secret, nonce)}`;
}

export function isValidCsrfToken(
  token: string | undefined | null,
  secret: string = env().SESSION_SECRET,
): boolean {
  if (!token || token.length > 512) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const nonce = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  return constantTimeEqual(signature, hmacSha256Base64Url(secret, nonce));
}

/** Double-submit check: cookie and header must both be present, valid and identical. */
export function verifyCsrfPair(
  cookieValue: string | undefined | null,
  headerValue: string | undefined | null,
): boolean {
  if (!cookieValue || !headerValue) return false;
  if (!isValidCsrfToken(cookieValue)) return false;
  return constantTimeEqual(cookieValue, headerValue);
}
