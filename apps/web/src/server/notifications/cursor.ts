import { AppError } from "@clockoff/shared/errors";

/**
 * Opaque keyset cursors for "newest first" lists ordered by `(instant DESC, id DESC)`: the cursor names
 * the last row of the previous page and the next page is everything strictly before it. Encoded as
 * base64url so clients treat it as a token (see docs/API.md → Pagination).
 */

export interface KeysetCursor {
  at: Date;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeKeysetCursor(cursor: KeysetCursor): string {
  return Buffer.from(`${cursor.at.toISOString()}|${cursor.id}`, "utf8").toString("base64url");
}

/** Throws `VALIDATION_ERROR` (on `query.cursor`) for anything this server did not produce. */
export function decodeKeysetCursor(raw: string): KeysetCursor {
  const invalid = () =>
    new AppError("VALIDATION_ERROR", "Invalid cursor", {
      details: { source: "query", formErrors: [], fieldErrors: { cursor: ["Invalid cursor"] } },
    });
  if (raw.length === 0 || raw.length > 200) throw invalid();
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    throw invalid();
  }
  const separator = decoded.indexOf("|");
  if (separator <= 0) throw invalid();
  const at = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(at.getTime()) || !UUID.test(id)) throw invalid();
  return { at, id };
}

/** Prisma `where` fragment selecting rows strictly before the cursor in `(field DESC, id DESC)` order. */
export function beforeCursorWhere<F extends string>(field: F, cursor: KeysetCursor) {
  return {
    OR: [{ [field]: { lt: cursor.at } }, { [field]: cursor.at, id: { lt: cursor.id } }],
  } as { OR: Array<Record<F, Date | { lt: Date }> & { id?: { lt: string } }> };
}
