import { requestDemoSchema } from "@clockoff/validation/organisation";
import { z } from "zod";

/**
 * Request-a-demo form. The wire body is `requestDemoSchema` (`POST /api/request-demo`, packages/validation):
 * name, email, company, optional team size and message, the page it came from (`source`) and the honeypot
 * (`website`). The form schema here is the same contract with form-friendly shapes (team size from a fixed
 * set of bands, empty strings for "not given") and is reduced to the wire shape by `toRequestDemoPayload`.
 *
 * The `website` field is a honeypot: visually hidden and skipped by keyboard, so people never fill it in and
 * bots do. A tripped honeypot short-circuits client-side (no request) and the server drops it too.
 */

export const DEMO_REQUEST_ENDPOINT = "/api/request-demo";

export const TEAM_SIZE_OPTIONS = ["1-10", "11-50", "51-200", "201-1000", "1000+"] as const;
export type TeamSizeOption = (typeof TEAM_SIZE_OPTIONS)[number];

/** Mirrors the limits in `requestDemoSchema` so the form never accepts something the API rejects. */
export const REQUEST_DEMO_LIMITS = {
  nameMaxLength: 120,
  emailMaxLength: 254,
  companyMaxLength: 160,
  messageMaxLength: 2000,
  sourceMaxLength: 100,
} as const;

export const requestDemoFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Enter your name")
    .max(
      REQUEST_DEMO_LIMITS.nameMaxLength,
      `Keep your name under ${REQUEST_DEMO_LIMITS.nameMaxLength} characters`,
    ),
  email: z.email("Enter a work email address").max(REQUEST_DEMO_LIMITS.emailMaxLength),
  company: z
    .string()
    .trim()
    .min(1, "Enter your company name")
    .max(
      REQUEST_DEMO_LIMITS.companyMaxLength,
      `Keep the company name under ${REQUEST_DEMO_LIMITS.companyMaxLength} characters`,
    ),
  teamSize: z.enum(TEAM_SIZE_OPTIONS).or(z.literal("")),
  message: z
    .string()
    .trim()
    .max(
      REQUEST_DEMO_LIMITS.messageMaxLength,
      `Keep your message under ${REQUEST_DEMO_LIMITS.messageMaxLength} characters`,
    ),
  /** Honeypot. Must stay empty; see `isHoneypotTripped`. */
  website: z.string().max(200),
});
export type RequestDemoFormValues = z.infer<typeof requestDemoFormSchema>;

export const EMPTY_REQUEST_DEMO_FORM: RequestDemoFormValues = {
  name: "",
  email: "",
  company: "",
  teamSize: "",
  message: "",
  website: "",
};

/** The body sent to `POST /api/request-demo` — the contract's input type. */
export type RequestDemoPayload = z.input<typeof requestDemoSchema>;

/**
 * Only `[a-z0-9-]` sources up to the contract's length are kept (the value comes from `?source=` on the
 * public page, so it is untrusted); anything else is dropped rather than rejected.
 */
export function normaliseDemoSource(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return /^[a-z0-9-]{1,100}$/.test(trimmed) ? trimmed : undefined;
}

/** Body for `POST /api/request-demo`: optional fields are omitted (never sent as empty strings). */
export function toRequestDemoPayload(
  values: RequestDemoFormValues,
  source?: string,
): RequestDemoPayload {
  const payload: RequestDemoPayload = {
    name: values.name.trim(),
    email: values.email.trim().toLowerCase(),
    company: values.company.trim(),
  };
  if (values.teamSize !== "") payload.teamSize = values.teamSize;
  const message = values.message.trim();
  if (message !== "") payload.message = message;
  const safeSource = normaliseDemoSource(source);
  if (safeSource) payload.source = safeSource;
  return payload;
}

export function isHoneypotTripped(values: Pick<RequestDemoFormValues, "website">): boolean {
  return values.website.trim() !== "";
}
