import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  constantTimeEqual,
  createCsrfToken,
  decrypt,
  decryptToString,
  encrypt,
  hmacSha256Base64Url,
  isValidCsrfToken,
  randomToken,
  sha256Hex,
  verifyCsrfPair,
} from "./crypto";

const key = randomBytes(32);
const secret = "x".repeat(64);

describe("AES-256-GCM", () => {
  it("round-trips with layout iv(12) | tag(16) | ciphertext", () => {
    const blob = encrypt("apns-device-token", key);
    expect(blob.length).toBe(12 + 16 + Buffer.byteLength("apns-device-token"));
    expect(decryptToString(blob, key)).toBe("apns-device-token");
    expect(decrypt(encrypt(Buffer.from([1, 2, 3]), key), key)).toEqual(Buffer.from([1, 2, 3]));
  });

  it("uses a fresh IV every time", () => {
    expect(encrypt("same", key).equals(encrypt("same", key))).toBe(false);
  });

  it("detects tampering and wrong keys", () => {
    const blob = encrypt("secret", key);
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => decrypt(tampered, key)).toThrow();
    expect(() => decrypt(blob, randomBytes(32))).toThrow();
    expect(() => decrypt(Buffer.alloc(10), key)).toThrow(/too short/);
    expect(() => encrypt("x", randomBytes(16))).toThrow(/32 bytes/);
  });

  it("defaults to INTEGRATION_ENCRYPTION_KEY", () => {
    expect(decryptToString(encrypt("from env"))).toBe("from env");
  });
});

describe("hashing and tokens", () => {
  it("sha256Hex matches the known vector", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("randomToken is base64url of the requested size", () => {
    const token = randomToken(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(16)).toHaveLength(22);
    expect(randomToken()).not.toBe(randomToken());
  });

  it("constantTimeEqual handles different lengths", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual(Buffer.from("a"), Buffer.from("a"))).toBe(true);
  });
});

describe("CSRF tokens", () => {
  it("are signed with the secret", () => {
    const token = createCsrfToken(secret);
    const [nonce, signature] = token.split(".");
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(signature).toBe(hmacSha256Base64Url(secret, nonce!));
    expect(isValidCsrfToken(token, secret)).toBe(true);
    expect(isValidCsrfToken(token, "y".repeat(64))).toBe(false);
    expect(isValidCsrfToken(`${nonce}.forged`, secret)).toBe(false);
    expect(isValidCsrfToken("no-dot", secret)).toBe(false);
    expect(isValidCsrfToken(undefined, secret)).toBe(false);
    expect(isValidCsrfToken("a".repeat(600), secret)).toBe(false);
  });

  it("double-submit requires identical, valid cookie and header", () => {
    const token = createCsrfToken();
    expect(verifyCsrfPair(token, token)).toBe(true);
    expect(verifyCsrfPair(token, createCsrfToken())).toBe(false);
    expect(verifyCsrfPair(token, null)).toBe(false);
    expect(verifyCsrfPair(undefined, token)).toBe(false);
    expect(verifyCsrfPair("forged.token", "forged.token")).toBe(false);
  });
});
