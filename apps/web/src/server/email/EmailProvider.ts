export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** A rendered template without a recipient; routes add `to`. */
export type EmailContent = Omit<EmailMessage, "to">;

export interface EmailProvider {
  readonly name: "console" | "smtp" | "mock";
  send(message: EmailMessage): Promise<void>;
}
