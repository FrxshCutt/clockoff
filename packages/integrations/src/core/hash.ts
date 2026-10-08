/**
 * Decision-input hashing for idempotent syncs (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §6.2):
 * `ExternalEntityMap.lastHash = HMAC-SHA256(key, canonicalJson(decisionInputs))`. This module owns the canonical
 * form; the keyed hash is injected by the caller (`apps/web/src/server/integrations/hasher.ts` derives the key from
 * INTEGRATION_ENCRYPTION_KEY), so the package never sees a secret and the stored hash cannot be recomputed from
 * the database alone.
 */

/** Keyed hash over a canonical JSON string, e.g. HMAC-SHA256 hex. Supplied by the web layer. */
export type RecordHasher = (canonical: string) => string;

/**
 * Deterministic JSON for hashing: object keys sorted (by UTF-16 code unit) at every level, no whitespace, `Date`
 * as its ISO string, `undefined` properties dropped (as JSON.stringify does) and `undefined` array items as `null`.
 * Anything without a stable JSON form (functions, symbols, bigints, non-finite numbers, Maps, Sets, class
 * instances other than Date) throws, so a hash can never silently depend on how a value happens to print.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, new Set());
}

/** `hasher(canonicalJson(inputs))`: the value stored in `lastHash`. */
export function hashDecisionInputs(hasher: RecordHasher, inputs: unknown): string {
  return hasher(canonicalJson(inputs));
}

function encode(value: unknown, stack: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
      // JSON has no -0; normalise it so 0 and -0 hash alike.
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case "object":
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
  }
  const obj = value as object;
  if (obj instanceof Date) {
    if (Number.isNaN(obj.getTime())) throw new TypeError("canonicalJson: invalid Date");
    return JSON.stringify(obj.toISOString());
  }
  if (stack.has(obj)) throw new TypeError("canonicalJson: circular structure");
  stack.add(obj);
  try {
    if (Array.isArray(obj)) {
      return `[${obj.map((item) => (item === undefined ? "null" : encode(item, stack))).join(",")}]`;
    }
    const proto = Object.getPrototypeOf(obj) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError("canonicalJson: only plain objects, arrays and Dates are supported");
    }
    const record = obj as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${encode(item, stack)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    stack.delete(obj);
  }
}
