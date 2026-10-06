import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AcceptInvitePanel } from "./accept-invite-panel";
import { ForgotPasswordForm } from "./forgot-password-form";
import { ResetPasswordForm } from "./reset-password-form";
import { VerifyEmailPanel } from "./verify-email-panel";

/** Server-render the auth screens that don't need the App Router (no DOM, no network). */
function render(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

function labelFor(html: string, label: string): string | undefined {
  return new RegExp(`<label[^>]*for="([^"]+)"[^>]*>${label}</label>`).exec(html)?.[1];
}

describe("auth screens", () => {
  it("forgot password: a labelled email field, submit button and a way back", () => {
    const html = render(<ForgotPasswordForm />);
    expect(html.match(/<h1/g)?.length).toBe(1);
    const id = labelFor(html, "Work email");
    expect(id).toBeDefined();
    expect(html).toContain(`id="${id}"`);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Send reset link<\/button>/);
    expect(html).toContain('href="/login"');
  });

  it("reset password: explains a missing token instead of showing the form", () => {
    const html = render(<ResetPasswordForm token={null} />);
    expect(html).toContain("This reset link is incomplete");
    expect(html).toContain('href="/forgot-password"');
    expect(html).not.toContain('type="password"');
  });

  it("reset password: new + confirm password fields with show/hide toggles", () => {
    const html = render(<ResetPasswordForm token={"t".repeat(40)} />);
    expect(labelFor(html, "New password")).toBeDefined();
    expect(labelFor(html, "Confirm new password")).toBeDefined();
    expect((html.match(/type="password"/g) ?? []).length).toBe(2);
    expect((html.match(/aria-label="Show password"/g) ?? []).length).toBe(2);
    expect(html).toContain('autoComplete="new-password"');
  });

  it("treats a truncated token like a missing one instead of sending a request that can't pass validation", () => {
    const truncated = "abc123";
    const reset = render(<ResetPasswordForm token={truncated} />);
    expect(reset).toContain("This reset link is incomplete");
    expect(reset).not.toContain('type="password"');
    expect(render(<VerifyEmailPanel token={truncated} />)).toContain(
      "This verification link is incomplete",
    );
    expect(render(<AcceptInvitePanel token={truncated} />)).toContain(
      "This invitation link is incomplete",
    );
  });

  it("accept invite: looks the invitation up when the token is well formed", () => {
    expect(render(<AcceptInvitePanel token={"t".repeat(40)} />)).toContain(
      "Checking your invitation",
    );
  });

  it("verify email: explains a missing token, and shows progress while verifying", () => {
    expect(render(<VerifyEmailPanel token={null} />)).toContain(
      "This verification link is incomplete",
    );
    expect(render(<VerifyEmailPanel token={"t".repeat(40)} />)).toContain("Verifying your email");
  });
});
