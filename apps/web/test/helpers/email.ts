import type { MockEmailProvider } from "@/server/email";
import { MockEmailProvider as MockEmailProviderClass } from "@/server/email/MockEmailProvider";

/**
 * Access to the in-memory email provider installed by `test/integration/setup.ts` for the current test.
 */
let current: MockEmailProvider | undefined;

export function setTestEmailProvider(provider: MockEmailProvider): void {
  current = provider;
}

export function testEmails(): MockEmailProvider {
  if (!current)
    throw new Error(
      "MockEmailProvider is not installed (is test/integration/setup.ts configured?)",
    );
  return current;
}

/** The `?token=` from the last email to `to` that links to `path` (e.g. `/verify-email`). */
export function lastEmailToken(
  to: string,
  path: "/verify-email" | "/reset-password" | "/accept-invite",
): string {
  const message = [...testEmails().sent]
    .reverse()
    .find((m) => m.to.toLowerCase() === to.toLowerCase() && m.text.includes(`${path}?token=`));
  const token = MockEmailProviderClass.extractToken(message, path);
  if (!token) throw new Error(`No email with a ${path} link was sent to ${to}`);
  return token;
}
