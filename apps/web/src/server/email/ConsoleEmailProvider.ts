import { logger } from "@/lib/logger";
import type { EmailMessage, EmailProvider } from "./EmailProvider";

export interface ConsoleEmailProviderOptions {
  /**
   * Log only the subject: no recipient, no body (the body carries single-use links). Set in production,
   * where the console provider is a misconfiguration (`env()` warns) and logs must not hold PII or
   * credentials.
   */
  suppressContent?: boolean;
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
