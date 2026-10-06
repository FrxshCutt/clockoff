import { hash, type Algorithm, type Version } from "@node-rs/argon2";

/**
 * Same argon2id parameters as `apps/web/src/lib/password.ts` (OWASP minimum: m = 19 MiB, t = 2, p = 1), so
 * seeded managers sign in through the real login flow and `needsRehash()` stays false for them. The seed
 * cannot import from apps/web, so the constants are mirrored here; `Algorithm` / `Version` are ambient
 * const enums in @node-rs/argon2 whose numeric values are part of the native binding's stable API.
 */
const ARGON2ID = 2 as Algorithm; // Algorithm.Argon2id
const VERSION_0X13 = 1 as Version; // Version.V0x13

export const SEED_ARGON2_PARAMS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  algorithm: ARGON2ID,
  version: VERSION_0X13,
} as const;

export async function hashSeedPassword(password: string): Promise<string> {
  return hash(password, SEED_ARGON2_PARAMS);
}
