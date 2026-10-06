import { hash, parseOptions, verify, type Algorithm, type Version } from "@node-rs/argon2";

/**
 * Password hashing with argon2id (OWASP 2024 minimum: m=19 MiB, t=2, p=1).
 * Hashes are PHC strings (`$argon2id$v=19$m=19456,t=2,p=1$...`) stored in `users.password_hash`.
 */

/**
 * `Algorithm` / `Version` are ambient `const enum`s in @node-rs/argon2, which cannot be referenced at
 * runtime under `isolatedModules`; their numeric values are stable parts of the native binding's API.
 */
const ARGON2ID = 2 as Algorithm; // Algorithm.Argon2id
const VERSION_0X13 = 1 as Version; // Version.V0x13

export const ARGON2_PARAMS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  algorithm: ARGON2ID,
  version: VERSION_0X13,
} as const;

/**
 * A real argon2id hash (same parameters as {@link ARGON2_PARAMS}) of 32 random bytes that were
 * discarded after hashing, so no password can match it. Unknown emails are verified against it to keep
 * login timing independent of whether the account exists; the login code also rejects unknown
 * accounts explicitly, so a match could never sign anyone in.
 */
export const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$J/lW9DhKKtLBQgfOZJqcXg$oJlY40a/1fvf2FeTBuCyVKUKan1KdgeUCSEkzdt3N7E";

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_PARAMS);
}

/** Returns false (never throws) for malformed hashes. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** True when the stored hash was produced with weaker/different parameters than {@link ARGON2_PARAMS}. */
export function needsRehash(passwordHash: string): boolean {
  try {
    const parsed = parseOptions(passwordHash);
    return (
      parsed.algorithm !== ARGON2_PARAMS.algorithm ||
      parsed.version !== ARGON2_PARAMS.version ||
      parsed.memoryCost < ARGON2_PARAMS.memoryCost ||
      parsed.timeCost < ARGON2_PARAMS.timeCost ||
      parsed.parallelism !== ARGON2_PARAMS.parallelism
    );
  } catch {
    return true;
  }
}
