import { logger } from "@/lib/logger";
import type { EmailMessage, EmailProvider } from "./EmailProvider";

export interface ConsoleEmailProviderOptions {
  /**
   * Log only the subject: no recipient, no body (the body carries single-use links). Set in production,
   * where the console provider is a misconfiguration (`env()` warns) and logs must not hold PII or
   * credentials.
   */
  suppressContent?: boolean;
  /**
   * Also keep the last {@link DEV_OUTBOX_SIZE} messages in an in-memory ring buffer, read by the
   * development-only `GET /api/dev/last-email` (Playwright reads verification links from it). Only
   * `createEmailProvider()` turns this on, and only when `DEV_TOOLS_ENABLED` is set outside production.
   * Ignored when `suppressContent` is set.
   */
  recordOutbox?: boolean;
}

/** A message kept in the development outbox. */
export interface DevOutboxEntry extends EmailMessage {
  sentAt: string;
}

/** Ring-buffer capacity: enough for a test run, small enough that nothing piles up in a long dev session. */
export const DEV_OUTBOX_SIZE = 50;

declare global {
  var __clockoffDevOutbox: DevOutboxEntry[] | undefined;
}

/** Process-wide (on globalThis so Next dev HMR and separate route bundles share one buffer). */
function devOutbox(): DevOutboxEntry[] {
  if (!globalThis.__clockoffDevOutbox) globalThis.__clockoffDevOutbox = [];
  return globalThis.__clockoffDevOutbox;
}

function recordInDevOutbox(message: EmailMessage, now: Date = new Date()): void {
  const outbox = devOutbox();
  outbox.push({ ...message, sentAt: now.toISOString() });
  if (outbox.length > DEV_OUTBOX_SIZE) outbox.splice(0, outbox.length - DEV_OUTBOX_SIZE);
}

/** Most recent outbox message to `to` (case-insensitive), or undefined. Development tooling only. */
export function lastDevOutboxEmail(to: string): DevOutboxEntry | undefined {
  const wanted = to.trim().toLowerCase();
  const outbox = devOutbox();
  for (let i = outbox.length - 1; i >= 0; i -= 1) {
    if (outbox[i]!.to.toLowerCase() === wanted) return outbox[i];
  }
  return undefined;
}

/** Empty the development outbox (tests). */
export function clearDevOutbox(): void {
  devOutbox().length = 0;
}

/**
 * Development transport: prints the whole message (including verification / reset / invite links)
 * to the server log in a clearly delimited block so a developer can click the link.
 *
 * This is the one place where a recipient address is intentionally written to the log, and only
 * outside production: `createEmailProvider()` turns on `suppressContent` when `NODE_ENV=production`.
 */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console" as const;

  constructor(private readonly options: ConsoleEmailProviderOptions = {}) {}

  async send(message: EmailMessage): Promise<void> {
    if (this.options.suppressContent) {
      logger.warn(
        { subject: message.subject },
        "email not delivered: EMAIL_PROVIDER=console in production (recipient and body withheld from logs)",
      );
      return;
    }
    if (this.options.recordOutbox) recordInDevOutbox(message);
    const block = [
      "",
      "┌──────────────────────────── EMAIL (console provider) ────────────────────────────",
      `│ To:      ${message.to}`,
      `│ Subject: ${message.subject}`,
      "├──────────────────────────────────────────────────────────────────────────────────",
      ...message.text.split("\n").map((line) => `│ ${line}`),
      "└──────────────────────────────────────────────────────────────────────────────────",
      "",
    ].join("\n");
    // The message text is the payload here by design; no structured fields so redaction does not
    // remove the link a developer needs.
    logger.info(block);
  }
}
