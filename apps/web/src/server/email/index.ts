import { env } from "@/lib/env";
import { errorSummary, logger } from "@/lib/logger";
import { ConsoleEmailProvider } from "./ConsoleEmailProvider";
import type { EmailMessage, EmailProvider } from "./EmailProvider";
import { ResendEmailProvider } from "./ResendEmailProvider";
import { SmtpEmailProvider } from "./SmtpEmailProvider";

export {
  ConsoleEmailProvider,
  DEV_OUTBOX_SIZE,
  clearDevOutbox,
  lastDevOutboxEmail,
} from "./ConsoleEmailProvider";
export type { ConsoleEmailProviderOptions, DevOutboxEntry } from "./ConsoleEmailProvider";
export { MockEmailProvider } from "./MockEmailProvider";
export {
  RESEND_API_URL,
  RESEND_TIMEOUT_MS,
  ResendEmailError,
  ResendEmailProvider,
} from "./ResendEmailProvider";
export type { FetchLike, ResendConfig } from "./ResendEmailProvider";
export { SmtpEmailProvider } from "./SmtpEmailProvider";
export type { EmailContent, EmailMessage, EmailProvider } from "./EmailProvider";
export * from "./templates";

/**
 * Instantiate the provider selected by `EMAIL_PROVIDER`: `console` (development; logs links),
 * `resend` (production; Resend HTTP API with `RESEND_API_KEY`) or `smtp` (not implemented yet).
 * A provider with missing configuration throws here, i.e. at the first send; `sendEmailSafely`
 * catches and logs that. In production `env()` already refuses `resend` without a usable
 * `RESEND_API_KEY` or with an `EMAIL_FROM` Resend can never send from.
 */
export function createEmailProvider(): EmailProvider {
  const e = env();
  switch (e.EMAIL_PROVIDER) {
    case "console":
      return new ConsoleEmailProvider({
        suppressContent: e.isProduction,
        // Feeds the development-only GET /api/dev/last-email (never in production: env() refuses it there).
        recordOutbox: e.DEV_TOOLS_ENABLED && !e.isProduction,
      });
    case "resend":
      return new ResendEmailProvider({ apiKey: e.RESEND_API_KEY, from: e.EMAIL_FROM });
    case "smtp":
      return new SmtpEmailProvider({
        host: e.SMTP_HOST,
        port: e.SMTP_PORT,
        user: e.SMTP_USER,
        password: e.SMTP_PASSWORD,
        from: e.EMAIL_FROM,
      });
    default: {
      const exhaustive: never = e.EMAIL_PROVIDER;
      throw new Error(`Unknown EMAIL_PROVIDER ${String(exhaustive)}`);
    }
  }
}

declare global {
  var __workmodeEmailProvider: EmailProvider | undefined;
}

export function getEmailProvider(): EmailProvider {
  if (!globalThis.__workmodeEmailProvider)
    globalThis.__workmodeEmailProvider = createEmailProvider();
  return globalThis.__workmodeEmailProvider;
}

export function setEmailProviderForTesting(provider: EmailProvider | undefined): void {
  globalThis.__workmodeEmailProvider = provider;
}

/**
 * Send and swallow transport failures (logged with the subject only). Account flows must not fail
 * because the mail server hiccupped; users can request another email. Returns whether it was sent.
 */
export async function sendEmailSafely(message: EmailMessage): Promise<boolean> {
  try {
    await getEmailProvider().send(message);
    return true;
  } catch (err) {
    logger.error({ error: errorSummary(err), subject: message.subject }, "email send failed");
    return false;
  }
}
