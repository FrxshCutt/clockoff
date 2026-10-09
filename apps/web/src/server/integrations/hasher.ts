import { createHmac, hkdfSync } from "node:crypto";
import type { RecordHasher } from "@clockoff/integrations";
import { getEncryptionKey } from "@/lib/crypto";

/**
 * The keyed hash behind `ExternalEntityMap.lastHash` (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §6.2):
 * HMAC-SHA256 over the canonical decision inputs with a key derived from INTEGRATION_ENCRYPTION_KEY (HKDF-SHA256,
 * info {@link ENTITY_HASH_INFO}). The stored hash therefore cannot be used to guess names or emails offline, and
 * it never equals a plain digest of the inputs. The package (`@clockoff/integrations/core/hash.ts`) owns the
 * canonical form; this module only supplies the key.
 */

/** HKDF `info`: versioned, so a change of the canonical inputs or of the key derivation re-decides every row. */
export const ENTITY_HASH_INFO = "external-entity-hash:v2";

let cached: { source: Buffer; key: Buffer } | null = null;

function hashKey(): Buffer {
  const source = getEncryptionKey();
  if (cached && cached.source.equals(source)) return cached.key;
  const key = Buffer.from(hkdfSync("sha256", source, Buffer.alloc(0), ENTITY_HASH_INFO, 32));
  cached = { source, key };
  return key;
}

/** `recordHasher()(canonicalJson(inputs))`: lower-case hex HMAC-SHA256 (64 characters). */
export function recordHasher(): RecordHasher {
  const key = hashKey();
  return (canonical) => createHmac("sha256", key).update(canonical, "utf8").digest("hex");
}
