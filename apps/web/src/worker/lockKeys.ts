/**
 * Postgres advisory lock keys used by the worker (session locks on the worker's DIRECT_URL lock session,
 * see `advisoryLock.ts`). High 32 bits = ASCII "CLKO" (0x434C4B4F), low bits = an ordinal that is never
 * reused: stable across deploys, greppable in `pg_locks` (`(classid::bigint << 32) | objid`), and outside
 * the int4 range used by `pg_advisory_xact_lock(hashtext(…))` (the digest) and the integration suite's
 * lock, so they can never collide.
 *
 * NEVER renumber or reuse a key: during a deploy the old and the new worker must agree on them.
 */

export const LOCK_KEY_NAMESPACE = 0x434c4b4fn << 32n;

export const LOCK_KEYS = {
  /** `work-mode-tick` job (4849333701445681153). */
  workModeTick: LOCK_KEY_NAMESPACE | 1n,
  /** `override-expiry` job (4849333701445681154). */
  overrideExpiry: LOCK_KEY_NAMESPACE | 2n,
  /** `schedule-upkeep` job (4849333701445681155). */
  scheduleUpkeep: LOCK_KEY_NAMESPACE | 3n,
  /** `integrations-sync` job (4849333701445681156). */
  integrationsSync: LOCK_KEY_NAMESPACE | 4n,
  /** Push-bridge leadership lease, not a job (4849333701445681157). */
  pushLeader: LOCK_KEY_NAMESPACE | 5n,
} as const;
