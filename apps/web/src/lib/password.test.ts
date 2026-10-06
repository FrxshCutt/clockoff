import { hash } from "@node-rs/argon2";
import { describe, expect, it } from "vitest";
import {
  ARGON2_PARAMS,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  needsRehash,
  verifyPassword,
} from "./password";

describe("argon2id passwords", () => {
  it("hashes with argon2id m=19456 t=2 p=1 and verifies", async () => {
    const hashed = await hashPassword("Correct-horse-42");
    expect(hashed.startsWith("$argon2id$v=19$m=19456,t=2,p=1$")).toBe(true);
    expect(await verifyPassword(hashed, "Correct-horse-42")).toBe(true);
    expect(await verifyPassword(hashed, "correct-horse-42")).toBe(false);
    expect(needsRehash(hashed)).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same-password-1")).not.toBe(await hashPassword("same-password-1"));
  });

  it("flags weaker or different parameters for rehash", async () => {
    const weak = await hash("pw", { memoryCost: 4096, timeCost: 1, parallelism: 1 });
    expect(needsRehash(weak)).toBe(true);
    const argon2i = await hash("pw", {
      ...ARGON2_PARAMS,
      algorithm: 1 as typeof ARGON2_PARAMS.algorithm,
    });
    expect(needsRehash(argon2i)).toBe(true);
    expect(needsRehash("not-a-hash")).toBe(true);
  });

  it("never throws on malformed hashes", async () => {
    expect(await verifyPassword("garbage", "x")).toBe(false);
  });

  it("the dummy hash used for unknown emails is a real argon2id hash that matches nothing", async () => {
    expect(needsRehash(DUMMY_PASSWORD_HASH)).toBe(false);
    expect(await verifyPassword(DUMMY_PASSWORD_HASH, "")).toBe(false);
    expect(await verifyPassword(DUMMY_PASSWORD_HASH, "Password123!")).toBe(false);
  });
});
