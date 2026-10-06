import { env } from "@/lib/env";
import type { EmailContent } from "./EmailProvider";

/**
 * Plain-text-first templates. Links are built from APP_URL so they work in every environment; the
 * web pages at these paths (owned by the dashboard engineer) read `?token=`.
 */

export const EMAIL_LINK_PATHS = {
  verifyEmail: "/verify-email",
  resetPassword: "/reset-password",
  acceptInvite: "/accept-invite",
  login: "/login",
  forgotPassword: "/forgot-password",
} as const;

export function buildAppLink(path: string, params: Record<string, string>): string {
  const url = new URL(path, env().APP_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function articleFor(role: string): string {
  return /^[aeiou]/i.test(role) ? "an" : "a";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function wrapHtml(title: string, lines: string[], link: { href: string; label: string }): string {
  const paragraphs = lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("\n");
  return [
    `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">`,
    `<h2 style="margin:0 0 12px">${escapeHtml(title)}</h2>`,
    paragraphs,
    `<p><a href="${escapeHtml(link.href)}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;border-radius:6px;text-decoration:none">${escapeHtml(link.label)}</a></p>`,
    `<p style="color:#666;font-size:12px">If the button does not work, copy this link:<br>${escapeHtml(link.href)}</p>`,
    `</body></html>`,
  ].join("\n");
}

export function verificationEmail(input: { name: string; token: string }): EmailContent {
  const link = buildAppLink(EMAIL_LINK_PATHS.verifyEmail, { token: input.token });
  const lines = [
    `Hi ${input.name},`,
    "Confirm your email address to finish setting up your Work Mode account.",
    "This link is valid for 24 hours.",
  ];
  return {
    subject: "Confirm your Work Mode email",
    text: [
      ...lines,
      "",
      link,
      "",
      "If you did not create an account, you can ignore this email.",
    ].join("\n"),
    html: wrapHtml("Confirm your email", lines, { href: link, label: "Confirm email" }),
  };
}

export function passwordResetEmail(input: { name: string; token: string }): EmailContent {
  const link = buildAppLink(EMAIL_LINK_PATHS.resetPassword, { token: input.token });
  const lines = [
    `Hi ${input.name},`,
    "Someone requested a password reset for your Work Mode account.",
    "This link is valid for 1 hour and can be used once.",
  ];
  return {
    subject: "Reset your Work Mode password",
    text: [
      ...lines,
      "",
      link,
      "",
      "If this was not you, no action is needed — your password has not changed.",
    ].join("\n"),
    html: wrapHtml("Reset your password", lines, { href: link, label: "Choose a new password" }),
  };
}

export function managerInviteEmail(input: {
  organisationName: string;
  inviterName: string | null;
  role: string;
  token: string;
}): EmailContent {
  const link = buildAppLink(EMAIL_LINK_PATHS.acceptInvite, { token: input.token });
  const intro = input.inviterName
    ? `${input.inviterName} has invited you to manage ${input.organisationName} on Work Mode`
    : `You have been invited to manage ${input.organisationName} on Work Mode`;
  const lines = [
    `${intro} as ${articleFor(input.role)} ${input.role.toLowerCase()}.`,
    "Work Mode helps teams keep phones distraction-free during shifts without monitoring employees.",
    "This invitation is valid for 7 days.",
  ];
  return {
    subject: `You're invited to ${input.organisationName} on Work Mode`,
    text: [...lines, "", link].join("\n"),
    html: wrapHtml(`Join ${input.organisationName}`, lines, {
      href: link,
      label: "Accept invitation",
    }),
  };
}

/**
 * Sent when someone registers with an address that already has an account. Registration answers the
 * same way for new and existing addresses (no account enumeration), so the owner learns about it here.
 * Carries no token: it only points at the sign-in and forgot-password pages.
 */
export function accountExistsEmail(input: { name: string }): EmailContent {
  const login = buildAppLink(EMAIL_LINK_PATHS.login, {});
  const forgot = buildAppLink(EMAIL_LINK_PATHS.forgotPassword, {});
  const lines = [
    `Hi ${input.name},`,
    "Someone tried to create a Work Mode account with this email address, but you already have one.",
    `If it was you, sign in instead. Forgotten your password? Reset it at ${forgot}`,
    "If it was not you, you can ignore this email: nothing about your account has changed.",
  ];
  return {
    subject: "You already have a Work Mode account",
    text: [...lines, "", login].join("\n"),
    html: wrapHtml("You already have an account", lines, { href: login, label: "Sign in" }),
  };
}
