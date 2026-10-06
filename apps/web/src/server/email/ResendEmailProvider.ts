import { logger } from "@/lib/logger";
import type { EmailMessage, EmailProvider } from "./EmailProvider";

/** Resend's send-email endpoint (https://resend.com/docs/api-reference/emails/send-email). */
export const RESEND_API_URL = "https://api.resend.com/emails";

/** Budget for one send, response body included (`AbortSignal.timeout`). */
export const RESEND_TIMEOUT_MS = 10_000;

/** The part of `fetch` the provider uses: the global `fetch` by default, a mock in tests. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ResendConfig {
  /** `RESEND_API_KEY`. Required: construction fails without it (surrounding whitespace is trimmed). */
  apiKey: string | undefined;
  /** `EMAIL_FROM`, e.g. `Work Mode <noreply@clockoff.online>`. Its domain must be verified in Resend. */
  from: string;
  /** Defaults to the global `fetch` (looked up per send, so `vi.stubGlobal("fetch", …)` also works). */
  fetch?: FetchLike;
  /** Defaults to {@link RESEND_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** JSON body of `POST /emails`. */
interface ResendSendEmailBody {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
}

/**
 * A failed send. The message carries the HTTP status and Resend's error `name` / `message` (or the
 * network failure), sanitised: never the API key, the recipient or any other email address.
 * `code` is Resend's error name (e.g. `validation_error`), which `errorSummary` logs.
 */
export class ResendEmailError extends Error {
  override readonly name = "ResendEmailError";
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(message: string, details: { status?: number; code?: string } = {}) {
    super(message);
    this.status = details.status;
    this.code = details.code;
  }
}

const MAX_DETAIL_LENGTH = 200;
/**
 * Upstream text is cut to this many characters (after the literal key/recipient redaction, before the
 * pattern-based redaction), so an oversized error body cannot make the regexes below run for long.
 */
const MAX_RAW_DETAIL_LENGTH = 2_000;
const EMAIL_ADDRESS = /[^\s@<>()[\]"'`,;:]+@[^\s@<>()[\]"'`,;:]+/g;
const RESEND_KEY_SHAPE = /\bre_[A-Za-z0-9_]{6,}/g;
/** Ids and error codes we are willing to put in logs / error codes: short, no spaces, no `@`. */
const SAFE_IDENTIFIER = /^[A-Za-z0-9_.-]{1,64}$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Production transport: Resend's HTTP API over the global `fetch` (no SDK dependency).
 *
 * Logging: one info line per accepted message with Resend's message id only — no recipient, subject
 * or body. Failures throw {@link ResendEmailError}; `sendEmailSafely` logs and swallows them.
 *
 * No `Idempotency-Key` is sent: the provider does not retry, and a key derived from the content would
 * make Resend silently drop legitimate repeats of an identical message within 24 h (the hourly
 * compliance digest for an unchanged set of employees, or an employee invite re-sent on the same day,
 * whose code and expiry date do not change).
 */
export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend" as const;

  // ES private fields: not enumerable, so the key never shows up if the provider object is logged.
  readonly #apiKey: string;
  readonly #from: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(config: ResendConfig) {
    const apiKey = config.apiKey?.trim() ?? "";
    if (!apiKey) throw new Error("EMAIL_PROVIDER=resend requires RESEND_API_KEY to be set.");
    if (/[\s\p{Cc}]/u.test(apiKey)) {
      throw new Error("RESEND_API_KEY must not contain whitespace or control characters.");
    }
    if (!config.from.trim())
      throw new Error("EMAIL_PROVIDER=resend requires EMAIL_FROM to be set.");
    this.#apiKey = apiKey;
    this.#from = config.from.trim();
    this.#fetch = config.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = config.timeoutMs ?? RESEND_TIMEOUT_MS;
  }

  async send(message: EmailMessage): Promise<void> {
    const body: ResendSendEmailBody = {
      from: this.#from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      ...(message.html !== undefined ? { html: message.html } : {}),
    };

    let response: Response;
    try {
      response = await this.#fetch(RESEND_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": "workmode-web",
        },
        body: JSON.stringify(body),
        // A redirect is never a valid answer from this endpoint. Following one would turn the POST into
        // a GET (301/302/303) whose 2xx landing page would be reported as "sent", and could carry the
        // bearer key to another host. Fail the send instead.
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      throw this.#networkError(err, message.to);
    }

    if (!response.ok) throw await this.#httpError(response, message.to);

    let id: string | null = null;
    try {
      const data: unknown = await response.json();
      if (isRecord(data) && typeof data.id === "string" && SAFE_IDENTIFIER.test(data.id)) {
        id = data.id;
      }
    } catch {
      // A 2xx means Resend accepted the message; an unreadable body only costs us the id.
    }
    logger.info({ provider: "resend", id }, "email sent");
  }

  /** Strip the API key, the recipient and any email address; one line, bounded length. */
  #sanitize(value: string, recipient: string): string {
    // Literal (linear-time) redactions run on the whole text so no fragment of the key or recipient
    // survives the cut; the pattern-based ones then only see a bounded prefix.
    let out = value.split(this.#apiKey).join("[redacted]");
    if (recipient) out = out.replace(new RegExp(escapeRegExp(recipient), "gi"), "[recipient]");
    out = out.slice(0, MAX_RAW_DETAIL_LENGTH);
    out = out.replace(RESEND_KEY_SHAPE, "[redacted]").replace(EMAIL_ADDRESS, "[email]");
    out = out.replace(/\s+/g, " ").trim();
    return out.length > MAX_DETAIL_LENGTH ? `${out.slice(0, MAX_DETAIL_LENGTH)}…` : out;
  }

  async #httpError(response: Response, recipient: string): Promise<ResendEmailError> {
    let raw = "";
    try {
      raw = await response.text();
    } catch {
      // Body unreadable (e.g. the timeout fired while reading it): report the status alone.
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }

    const status = response.status;
    if (!isRecord(parsed)) {
      return new ResendEmailError(`Resend API error: HTTP ${status} (no JSON error body)`, {
        status,
      });
    }
    const name = typeof parsed.name === "string" ? this.#sanitize(parsed.name, recipient) : "";
    const detail =
      typeof parsed.message === "string" ? this.#sanitize(parsed.message, recipient) : "";
    const code = SAFE_IDENTIFIER.test(name) ? name : undefined;
    const summary = [name, detail].filter(Boolean).join(": ") || "no error details";
    return new ResendEmailError(`Resend API error: HTTP ${status} ${summary}`, { status, code });
  }

  #networkError(err: unknown, recipient: string): ResendEmailError {
    // AbortSignal.timeout rejects with a DOMException named "TimeoutError".
    const errName = isRecord(err) && typeof err.name === "string" ? err.name : undefined;
    if (errName === "TimeoutError" || errName === "AbortError") {
      return new ResendEmailError(`Resend API request timed out after ${this.#timeoutMs} ms`, {
        code: "TIMEOUT",
      });
    }
    const type = err instanceof Error ? err.name : "NonError";
    const detail = this.#sanitize(err instanceof Error ? err.message : String(err), recipient);
    // Node's fetch rejects with a bare "fetch failed"; the reason is on `cause`: a system error code
    // (ECONNREFUSED, ENOTFOUND, UND_ERR_SOCKET, …) or, without one, a message such as "unexpected
    // redirect" (sanitised like everything else). The cause object itself is never attached.
    const cause = err instanceof Error && isRecord(err.cause) ? err.cause : undefined;
    const causeCode =
      typeof cause?.code === "string" && SAFE_IDENTIFIER.test(cause.code) ? cause.code : undefined;
    const causeDetail =
      causeCode ??
      (typeof cause?.message === "string" ? this.#sanitize(cause.message, recipient) : "");
    return new ResendEmailError(
      `Resend API request failed: ${type}${detail ? `: ${detail}` : ""}${causeDetail ? ` (${causeDetail})` : ""}`,
      causeCode ? { code: causeCode } : {},
    );
  }
}
