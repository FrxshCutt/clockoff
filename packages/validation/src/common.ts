import { z } from "zod";
import { isValidTimeZone } from "@workmode/shared/time/time";

/** Reusable primitives shared by every API schema. */
export const uuidSchema = z.uuid();
export const emailSchema = z.email().max(254).transform((s) => s.trim().toLowerCase());
export const nonEmptyString = (max = 200) => z.string().trim().min(1).max(max);
export const optionalString = (max = 200) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((s) => (s === "" ? null : (s ?? null)));

/** ISO-8601 instant (string) → Date. Accepts anything `Date.parse` understands but requires a timezone. */
export const isoDateTimeSchema = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "Invalid date-time" })
  .refine((s) => /(Z|[+-]\d{2}:?\d{2})$/.test(s), { message: "Date-time must include a timezone offset" });

/**
 * IANA timezone identifier. Delegates to the shared time helpers so the API never accepts a zone the
 * domain logic would later reject (e.g. fixed offsets like "+01:00", which Intl accepts).
 */
export const timezoneSchema = z
  .string()
  .refine((tz) => isValidTimeZone(tz), { message: "Invalid IANA timezone" });

/**
 * Password policy: 10+ chars, at least one letter and one digit. Length is the primary defence; the
 * character-class rule exists only to reject trivially weak passwords like "aaaaaaaaaa".
 */
export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(200)
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), {
    message: "Password must contain at least one letter and one number",
  });

export const cursorPaginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type CursorPaginationQuery = z.infer<typeof cursorPaginationQuerySchema>;

export const offsetPaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export function paginatedResponseSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    total: z.number().int().optional(),
  });
}

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorResponse = z.infer<typeof apiErrorSchema>;

export const okSchema = z.object({ ok: z.literal(true) });

/** Parses a URLSearchParams / Record into a schema, turning repeated keys into arrays when needed. */
export function searchParamsToObject(params: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of params.entries()) {
    const existing = out[k];
    if (existing === undefined) out[k] = v;
    else if (Array.isArray(existing)) existing.push(v);
    else out[k] = [existing, v];
  }
  return out;
}
