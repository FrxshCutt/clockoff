import pino, { type Bindings, type DestinationStream, type Logger, type LoggerOptions } from "pino";

/**
 * Structured JSON logger (pino) with PII/secret redaction.
 *
 * Rules:
 * - Never log emails, names, passwords, tokens, cookies or authorization headers. The paths below
 *   redact the common field names defensively, but callers must still avoid putting PII in log
 *   objects (log ids, counts and codes instead).
 * - Use `childLogger({ requestId })` / `child(logger, { requestId })` so every line in a request carries
 *   its id.
 *
 * The level is read from `LOG_LEVEL` directly (not via `env()`) so that a misconfigured environment
 * can still be reported through the logger. Errors are logged under `error: errorSummary(err)` (not
 * `err`, which pino's built-in serializer would rewrite).
 */

const SENSITIVE_KEYS = [
  "password",
  "newPassword",
  "currentPassword",
  "passwordHash",
  "token",
  "accessToken",
  "refreshToken",
  "csrfToken",
  "secret",
  "authorization",
  "cookie",
  "set-cookie",
  "email",
  "to",
  "phone",
  "name",
  "firstName",
  "lastName",
] as const;

function pathSegment(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `.${key}` : `["${key}"]`;
}

/**
 * Redaction paths: the key at the top level, one and two levels deep, and inside request/response
 * header objects. Hyphenated keys use bracket notation (`headers["set-cookie"]`).
 */
export const REDACT_PATHS: string[] = SENSITIVE_KEYS.flatMap((key) => {
  const seg = pathSegment(key);
  const top = seg.startsWith(".") ? seg.slice(1) : seg;
  return [top, `*${seg}`, `*.*${seg}`, `req.headers${seg}`, `res.headers${seg}`, `headers${seg}`];
});

/** `LOG_LEVEL` (default info). Under test runners logs are silent unless `TEST_LOG_LEVEL` is set. */
function resolveLevel(): string {
  if (process.env.NODE_ENV === "test") return process.env.TEST_LOG_LEVEL?.trim() || "silent";
  return process.env.LOG_LEVEL?.trim() || "info";
}

/**
 * `service` on every line: `LOG_SERVICE_NAME`, else "clockoff-web". The worker bundle fixes it to
 * "clockoff-worker" at build time (scripts/build-worker.mjs `define`) and `pnpm worker` sets it in
 * development, so the two processes' lines stay distinguishable in a shared log stream.
 */
function resolveService(): string {
  return process.env.LOG_SERVICE_NAME?.trim() || "clockoff-web";
}

export const LOGGER_OPTIONS: LoggerOptions = {
  level: resolveLevel(),
  redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  base: { service: resolveService() },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
};

/**
 * Build a logger with the standard redaction/format settings. `destination` exists for tests (capture
 * output in memory); production code uses the shared {@link logger}.
 */
export function createLogger(
  overrides: Partial<LoggerOptions> = {},
  destination?: DestinationStream,
): Logger {
  const options = { ...LOGGER_OPTIONS, ...overrides };
  return destination ? pino(options, destination) : pino(options);
}

export const logger: Logger = createLogger();

/** Create a child logger carrying `bindings` on every line (e.g. `{ requestId }`). */
export function childLogger(bindings: Bindings, parent: Logger = logger): Logger {
  return parent.child(bindings);
}

/** `child(parent, bindings)` — same as {@link childLogger} with the parent first. */
export function child(parent: Logger, bindings: Bindings): Logger {
  return parent.child(bindings);
}

const MAX_ERROR_MESSAGE = 300;
const MAX_STACK_FRAMES = 15;

/**
 * Error messages can embed request data: a `PrismaClientValidationError` prints the whole failed
 * invocation, argument values (emails, names) included, after its first line. Logs keep only the first
 * non-empty line of any error message, capped at {@link MAX_ERROR_MESSAGE} characters.
 */
function safeMessage(message: string): string {
  const firstLine =
    message
      .split("\n")
      .find((line) => line.trim() !== "")
      ?.trim() ?? "";
  return firstLine.length > MAX_ERROR_MESSAGE
    ? `${firstLine.slice(0, MAX_ERROR_MESSAGE)}…`
    : firstLine;
}

/**
 * Convert an unknown thrown value into a loggable, stack-free summary. The error class goes in `type`
 * (not `name`, which is a redacted key); the message is reduced to its first line (see `safeMessage`).
 */
export function errorSummary(err: unknown): { type: string; message: string; code?: string } {
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code;
    return {
      type: err.name,
      message: safeMessage(err.message),
      ...(typeof code === "string" ? { code } : {}),
    };
  }
  return { type: "NonError", message: safeMessage(String(err)) };
}

/**
 * The `at …` frames of an error's stack without the leading `Name: message` text (which repeats the
 * full, possibly data-bearing message). Undefined for non-errors.
 */
export function stackFrames(err: unknown): string[] | undefined {
  if (!(err instanceof Error) || typeof err.stack !== "string") return undefined;
  return err.stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .slice(0, MAX_STACK_FRAMES);
}

export type { Logger };
