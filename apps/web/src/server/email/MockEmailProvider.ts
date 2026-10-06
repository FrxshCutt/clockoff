import type { EmailMessage, EmailProvider } from "./EmailProvider";

/**
 * Test-only in-memory transport. Installed by `test/integration/setup.ts` via
 * `setEmailProviderForTesting`, so integration tests can read verification / reset / invite tokens
 * out of the "sent" messages. Never selected by environment.
 */
export class MockEmailProvider implements EmailProvider {
  readonly name = "mock" as const;
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }

  clear(): void {
    this.sent.length = 0;
  }

  /** Last message sent to `to` (case-insensitive), or to anyone when omitted. */
  last(to?: string): EmailMessage | undefined {
    const list = to ? this.sent.filter((m) => m.to.toLowerCase() === to.toLowerCase()) : this.sent;
    return list[list.length - 1];
  }

  /** Extract `?token=` from the first link on `path` (e.g. `/verify-email`) in a message. */
  static extractToken(message: EmailMessage | undefined, path: string): string | undefined {
    if (!message) return undefined;
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`${escaped}\\?token=([A-Za-z0-9_-]+)`).exec(message.text);
    return match?.[1];
  }
}
