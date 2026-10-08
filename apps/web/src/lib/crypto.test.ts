import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  constantTimeEqual,
  createCsrfToken,
  decrypt,
  decryptToString,
  encrypt,
  hmacSha256Base64Url,
  INTEGRATION_SECRET_COLUMNS,
  integrationAad,
  isValidCsrfToken,
  oauthStateAad,
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

describe("AES-256-GCM with associated data (D-038)", () => {
  const ORG_A_INTEGRATION = "6f9619ff-8b86-d011-b42d-00c04fc964ff";
  const ORG_B_INTEGRATION = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

  it("round-trips with the same associated data; the layout is unchanged (AAD is not stored)", () => {
    const aad = integrationAad(ORG_A_INTEGRATION, "refresh_token");
    const blob = encrypt("refresh-token-value", key, aad);
    expect(blob.length).toBe(12 + 16 + Buffer.byteLength("refresh-token-value"));
    expect(blob.includes(Buffer.from(aad))).toBe(false);
    expect(decryptToString(blob, key, aad)).toBe("refresh-token-value");
    expect(decrypt(blob, key, aad)).toEqual(Buffer.from("refresh-token-value"));
  });

  it("refuses a ciphertext moved to another organisation's row or another column", () => {
    const blob = encrypt("token", key, integrationAad(ORG_A_INTEGRATION, "refresh_token"));
    // Copied into another integration's row.
    expect(() => decrypt(blob, key, integrationAad(ORG_B_INTEGRATION, "refresh_token"))).toThrow();
    // Swapped into another column of the same row.
    expect(() => decrypt(blob, key, integrationAad(ORG_A_INTEGRATION, "access_token"))).toThrow();
    expect(() => decrypt(blob, key, integrationAad(ORG_A_INTEGRATION, "client_id"))).toThrow();
  });

  it("refuses associated data on only one side", () => {
    const bound = encrypt("token", key, integrationAad(ORG_A_INTEGRATION, "access_token"));
    expect(() => decrypt(bound, key)).toThrow();
    const unbound = encrypt("token", key);
    expect(() =>
      decrypt(unbound, key, integrationAad(ORG_A_INTEGRATION, "access_token")),
    ).toThrow();
  });

  it("stays backward compatible: ciphertexts without associated data still decrypt", () => {
    expect(decryptToString(encrypt("push-token", key), key)).toBe("push-token");
    expect(decryptToString(encrypt("push-token", undefined, undefined))).toBe("push-token");
  });

  it("defaults to INTEGRATION_ENCRYPTION_KEY when only the associated data is given", () => {
    const aad = oauthStateAad("state-1");
    expect(decryptToString(encrypt("verifier", undefined, aad), undefined, aad)).toBe("verifier");
  });

  it("rejects empty associated data (GCM would treat it as none)", () => {
    expect(() => encrypt("x", key, "")).toThrow(/must not be empty/);
    expect(() => decrypt(encrypt("x", key), key, "")).toThrow(/must not be empty/);
  });

  it("formats the per-column associated data", () => {
    expect(INTEGRATION_SECRET_COLUMNS).toEqual(["client_id", "refresh_token", "access_token"]);
    expect(integrationAad(ORG_A_INTEGRATION, "client_id")).toBe(
      `integration:${ORG_A_INTEGRATION}:client_id`,
    );
    expect(oauthStateAad("abc")).toBe("oauth_state:abc");
    expect(() => integrationAad("", "client_id")).toThrow();
    expect(() => oauthStateAad("")).toThrow();
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
