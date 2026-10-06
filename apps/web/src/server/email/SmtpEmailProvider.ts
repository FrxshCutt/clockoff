import type { EmailMessage, EmailProvider } from "./EmailProvider";

export interface SmtpConfig {
  host: string | undefined;
  port: number;
  user: string | undefined;
  password: string | undefined;
  from: string;
}

/**
 * Production transport placeholder. Constructing it with incomplete SMTP settings throws a clear
 * configuration error at startup rather than at the first password reset.
 *
 * Sending is not implemented: the repository has no SMTP client dependency (nodemailer). When it
 * is added, implement `send` here; the interface and selection logic in `index.ts` stay as they are.
 */
export class SmtpEmailProvider implements EmailProvider {
  readonly name = "smtp" as const;

  constructor(private readonly config: SmtpConfig) {
    const missing = (["host", "user", "password"] as const).filter((key) => !config[key]);
    if (missing.length > 0) {
      throw new Error(
        `EMAIL_PROVIDER=smtp requires ${missing.map((m) => `SMTP_${m.toUpperCase()}`).join(", ")} to be set.`,
      );
    }
  }

  async send(_message: EmailMessage): Promise<void> {
    throw new Error(
      `SmtpEmailProvider(${this.config.host}:${this.config.port}) cannot send: no SMTP client is installed. ` +
        "Add `nodemailer` to apps/web and implement SmtpEmailProvider.send, or use EMAIL_PROVIDER=console.",
    );
  }
}
