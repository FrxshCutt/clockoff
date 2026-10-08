import type { ClientConfig } from "pg";
import { errorSummary, type Logger } from "@/lib/logger";

/**
 * Long-lived `pg` sessions on the DIRECT (non-pooled) database URL: the realtime LISTEN connection
 * (`server/events/PostgresEventBus.ts`) and the worker's advisory-lock session. Neon's pooled URL runs
 * PgBouncer in transaction mode, which can neither hold a LISTEN nor a session-level advisory lock, so
 * both go through `DIRECT_URL`; everything else keeps using Prisma on the pooled `DATABASE_URL`.
 *
 * A session whose process vanishes without closing its socket (frozen container, lost host) would leave
 * an idle backend behind Neon's proxy for hours, still holding its LISTEN and locks. Every such session
 * therefore runs {@link prepareDirectSession} right after connecting (the server ends it after
 * {@link DIRECT_SESSION_IDLE_TIMEOUT} of silence) and its owner pings it every 30 s, so a live process
 * never trips the timeout.
 */

/** Server-side idle limit for direct sessions; owners ping every 30 s, well inside it. */
export const DIRECT_SESSION_IDLE_TIMEOUT = "120s";
/** Statement limit for direct sessions (they only run tiny statements: LISTEN, locks, `SELECT 1`). */
export const DIRECT_SESSION_STATEMENT_TIMEOUT = "10s";
/** TCP keepalive probes start after this much socket silence (pg's default 0 means the OS's 2 hours). */
export const PG_KEEPALIVE_INITIAL_DELAY_MS = 10_000;
/**
 * Client-side query limit. pg rejects the caller after this long but leaves an already-sent query active
 * and queued on that client, so a client whose query timed out must be discarded, never reused.
 */
export const PG_QUERY_TIMEOUT_MS = 10_000;
/** Connect limit when the URL has no positive `connect_timeout` (pg's default 0 waits forever). */
export const PG_DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/** Postgres truncates identifiers (application_name included) at NAMEDATALEN - 1 bytes. */
export const PG_MAX_APPLICATION_NAME_BYTES = 63;

/**
 * Query parameters removed from the URL before pg sees it: Prisma's own options (pg would ignore or
 * misread them), and the ones turned into explicit client options below. pg merges the connection
 * string OVER explicit options, so `application_name` must leave the URL for ours to win.
 */
const STRIPPED_PARAMS = [
  "schema",
  "pgbouncer",
  "connection_limit",
  "pool_timeout",
  "socket_timeout",
  "statement_cache_size",
  "connect_timeout",
  "application_name",
  "channel_binding",
] as const;

/** `name` cut to at most {@link PG_MAX_APPLICATION_NAME_BYTES} UTF-8 bytes, never mid-character. */
export function truncateApplicationName(name: string): string {
  if (Buffer.byteLength(name, "utf8") <= PG_MAX_APPLICATION_NAME_BYTES) return name;
  let out = "";
  for (const char of name) {
    if (Buffer.byteLength(out + char, "utf8") > PG_MAX_APPLICATION_NAME_BYTES) break;
    out += char;
  }
  return out;
}

/**
 * `pg.Client` options for a long-lived direct session: Prisma-only parameters stripped, `connect_timeout`
 * (seconds, Prisma/libpq style) turned into `connectionTimeoutMillis`, TCP keepalive after 10 s, a 10 s
 * query timeout and our `application_name` (≤ 63 bytes; it identifies the session in `pg_stat_activity`).
 * `sslmode=require` becomes `verify-full`: pg 8 already verifies the certificate for `require`, and the
 * explicit spelling keeps that (and silences pg's deprecation warning) when pg 9 adopts libpq's weaker
 * meaning. `channel_binding=require` (Neon's URLs) turns on SCRAM channel binding.
 * Throws a `TypeError` for a string that is not a URL; never includes the URL in a message.
 */
export function pgClientConfig(connectionString: string, applicationName: string): ClientConfig {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new TypeError("database connection string is not a valid URL");
  }
  const connectTimeoutSeconds = Number(url.searchParams.get("connect_timeout") ?? "");
  const channelBinding = url.searchParams.get("channel_binding");
  for (const param of STRIPPED_PARAMS) url.searchParams.delete(param);
  if (url.searchParams.get("sslmode") === "require") url.searchParams.set("sslmode", "verify-full");

  return {
    connectionString: url.toString(),
    application_name: truncateApplicationName(applicationName),
    keepAlive: true,
    keepAliveInitialDelayMillis: PG_KEEPALIVE_INITIAL_DELAY_MS,
    query_timeout: PG_QUERY_TIMEOUT_MS,
    connectionTimeoutMillis:
      Number.isFinite(connectTimeoutSeconds) && connectTimeoutSeconds > 0
        ? Math.round(connectTimeoutSeconds * 1000)
        : PG_DEFAULT_CONNECT_TIMEOUT_MS,
    ...(channelBinding === "require" ? { enableChannelBinding: true } : {}),
  };
}

/**
 * First statements on every direct session: the server ends the session after
 * {@link DIRECT_SESSION_IDLE_TIMEOUT} without traffic (freeing a vanished process's LISTEN and advisory
 * locks) and caps each statement at {@link DIRECT_SESSION_STATEMENT_TIMEOUT}. A rejected SET is logged at
 * warn and never fatal: the session still works, only without that safety net.
 */
export async function prepareDirectSession(
  client: { query: (text: string) => Promise<unknown> },
  log: Logger,
): Promise<void> {
  const settings: Array<[string, string]> = [
    ["idle_session_timeout", DIRECT_SESSION_IDLE_TIMEOUT],
    ["statement_timeout", DIRECT_SESSION_STATEMENT_TIMEOUT],
  ];
  for (const [setting, value] of settings) {
    try {
      await client.query(`SET ${setting} = '${value}'`);
    } catch (err) {
      log.warn({ error: errorSummary(err), setting }, "direct session setting failed");
    }
  }
}

/**
 * True when the server rejected a statement (pg's `DatabaseError`: a five-character SQLSTATE `code` and
 * severity `ERROR`): the session itself is still usable. Anything else — a query timeout, a socket error
 * (`code` like `ECONNRESET`, no severity), a client that already ended, a `FATAL` that ends the session —
 * means the session must be treated as lost and the client discarded.
 */
export function isStatementError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const { code, severity } = err as Error & { code?: unknown; severity?: unknown };
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && severity === "ERROR";
}
