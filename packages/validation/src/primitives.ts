import { z } from "zod";
import { uuidSchema } from "./common";
import { apiErrorCodeSchema } from "./enumSchemas";

/**
 * Building blocks shared by the domain schemas that are not in `common.ts`.
 *
 * Conventions (see docs/API.md):
 * - Requests accept instants as `isoDateTimeSchema` (ISO-8601 with an offset); responses emit `instantSchema`
 *   (ISO-8601 in UTC with millisecond precision).
 * - Query strings are parsed with `z.coerce` / `queryBooleanSchema` / `queryListSchema` because every
 *   value arrives as a string.
 */

// ── Time ────────────────────────────────────────────────────────────────────

/** ISO-8601 instant as emitted in responses (always UTC, e.g. `2026-10-05T09:00:00.000Z`). */
export const instantSchema = z.string().meta({
  format: "date-time",
  description: "ISO-8601 instant in UTC (e.g. 2026-10-05T09:00:00.000Z)",
});
export const nullableInstantSchema = instantSchema.nullable();

/** Calendar date without a time component, `YYYY-MM-DD`, interpreted in the request's timezone. */
export const localDateSchema = z.iso
  .date()
  .meta({ description: "Calendar date (YYYY-MM-DD), interpreted in the relevant timezone" });

/** Wall-clock time `HH:mm` (24-hour). */
export const localTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected a time in HH:mm (24-hour) format")
  .meta({ description: "Wall-clock time, HH:mm (24-hour)" });

// ── Query-string helpers ────────────────────────────────────────────────────

/**
 * Boolean from a query string. Accepts `true/false`, `1/0`, `yes/no`, `on/off` (case-insensitive).
 * `z.coerce.boolean()` is deliberately NOT used: it turns the string "false" into `true`.
 */
export const queryBooleanSchema = z.stringbool();

function splitQueryList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * List from a query string. Accepts repeated keys (`?a=x&a=y`, what `searchParamsToObject` produces), a
 * comma-separated list (`?a=x,y`) or a single value. An empty string yields an empty list.
 */
export function queryListSchema<T extends z.ZodType>(item: T, max = 50) {
  return z.preprocess((value) => {
    if (Array.isArray(value))
      return value.flatMap((v) => (typeof v === "string" ? splitQueryList(v) : [v]));
    if (typeof value === "string") return splitQueryList(value);
    return value;
  }, z.array(item).max(max));
}

export type SortKey<F extends string> = F | `-${F}`;

/** `?sort=field` (ascending) or `?sort=-field` (descending) over a fixed allow-list of fields. */
export function sortParamSchema<const F extends readonly [string, ...string[]]>(fields: F) {
  const values = [...fields, ...fields.map((f) => `-${f}`)] as [
    SortKey<F[number]>,
    ...SortKey<F[number]>[],
  ];
  return z.enum(values);
}

// ── Identifiers & codes ─────────────────────────────────────────────────────

export const idParamsSchema = z.object({ id: uuidSchema }).strict();
export type IdParams = z.infer<typeof idParamsSchema>;

/** Body for action endpoints that take no input. Handlers treat an absent body as `{}`. */
export const emptyBodySchema = z.object({}).strict();

/** Query for endpoints that take no query parameters but must reject unknown ones (mobile API, §12). */
export const emptyQuerySchema = z.object({}).strict();

/** A list of ids with no duplicates (bulk actions, team membership, ...). */
export function uuidListSchema(options: { min?: number; max: number }) {
  return z
    .array(uuidSchema)
    .min(options.min ?? 0)
    .max(options.max)
    .refine(
      (ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length,
      "Ids must be unique",
    )
    .meta({ uniqueItems: true });
}

/** Company join code, `WORD-####` (e.g. `BREW-4821`). Case-insensitive on input, normalised to upper case. */
export const companyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3,8}-\d{4}$/, "Company code looks like BREW-4821")
  .meta({ description: "Company join code, WORD-#### (case-insensitive)" });

/** Per-employee invite code shown in the manager's invite instructions. */
export const inviteCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{4,16}$/, "Invalid invite code")
  .meta({ description: "Per-employee invite code (case-insensitive)" });

export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9 ()-]{5,24}$/, "Invalid phone number")
  .meta({ description: "Phone number, digits with optional leading +" });

/** Short machine-readable token such as a reason code: `UPPER_SNAKE_CASE`, max 64 chars. */
export const shortCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/, "Expected an UPPER_SNAKE_CASE code");

/** Free-form JSON object (operational metadata). Never used for anything beyond §12. */
export const jsonObjectSchema = z.record(z.string(), z.unknown());

// ── Envelopes ───────────────────────────────────────────────────────────────

/**
 * `{ error: { code, message, details? } }` — every non-2xx response. Same shape as `apiErrorSchema`, with
 * `code` typed as the shared `ApiErrorCode` enum (one named component, not an inline copy).
 */
export const apiErrorResponseSchema = z
  .object({
    error: z.object({
      code: apiErrorCodeSchema,
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .meta({ id: "ApiError", description: "Error envelope returned by every non-2xx response." });
export type ApiErrorResponseBody = z.infer<typeof apiErrorResponseSchema>;

export const okResponseSchema = z.object({ ok: z.literal(true) }).meta({ id: "Ok" });
export type OkResponse = z.infer<typeof okResponseSchema>;

/** Page-number pagination (lists where a total is cheap and users jump between pages). */
export function offsetPaginatedResponseSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    page: z.int().min(1),
    pageSize: z.int().min(1),
    total: z.int().min(0),
    totalPages: z.int().min(0),
  });
}

// ── PATCH helpers ───────────────────────────────────────────────────────────

/**
 * Nullable string for PATCH bodies: `undefined` = leave unchanged, `null` or `""` = clear, string = set.
 * (`optionalString` from common.ts maps `undefined` to `null`, which would clear the field on PATCH.)
 */
export const patchStringSchema = (max = 200) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((s) => (s === "" ? null : s));
