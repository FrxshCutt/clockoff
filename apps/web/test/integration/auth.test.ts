import { prisma } from "@clockoff/db";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { POST as changePasswordRoute } from "@/app/api/auth/change-password/route";
import { POST as forgotPasswordRoute } from "@/app/api/auth/forgot-password/route";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { POST as logoutRoute } from "@/app/api/auth/logout/route";
import { GET as meRoute } from "@/app/api/auth/me/route";
import { POST as registerRoute } from "@/app/api/auth/register/route";
import { POST as resendVerificationRoute } from "@/app/api/auth/resend-verification/route";
import { POST as resetPasswordRoute } from "@/app/api/auth/reset-password/route";
import { POST as verifyEmailRoute } from "@/app/api/auth/verify-email/route";
import { GET as currentOrgRoute } from "@/app/api/organisations/current/route";
import { CSRF_COOKIE, SESSION_COOKIE } from "@/lib/cookies";
import { env, resetEnvCache } from "@/lib/env";
import { hashToken } from "@/lib/tokens";
import { pendingBackgroundTaskCount, settleBackgroundTasks } from "@/server/background";
import { RATE_LIMITS, getRateLimiter, rateLimitKey } from "@/server/rateLimit";
import {
  CookieJar,
  DEFAULT_TEST_PASSWORD,
  callRoute,
  createTestOrg,
  createTestUser,
  lastEmailToken,
  loginAs,
  testEmails,
  uniqueEmail,
  type ErrorBody,
} from "../helpers";

interface CurrentUserBody {
  user: { id: string; email: string; name: string; emailVerified: boolean };
  organisations: Array<{ id: string; role: string }>;
  currentOrganisationId: string | null;
  csrfToken: string;
}

describe("register → verify email → login → me", () => {
  it("runs the whole manager sign-up flow", async () => {
    const email = uniqueEmail("signup");
    const jar = new CookieJar();

    const registered = await callRoute<{
      ok: boolean;
      requiresEmailVerification: boolean;
      csrfToken: string;
    }>(registerRoute, {
      method: "POST",
      path: "/api/auth/register",
      jar,
      body: { name: "Sam Owner", email, password: "Sup3r-secret-pass" },
    });
    expect(registered.status).toBe(201);
    expect(registered.body).toMatchObject({ ok: true, requiresEmailVerification: false });
    expect(jar.get(SESSION_COOKIE)).toBeTruthy();
    expect(jar.get(CSRF_COOKIE)).toBe(registered.body.csrfToken);

    // Session cookie flags: httpOnly + SameSite=Lax; CSRF cookie readable by JS.
    expect(registered.cookies[SESSION_COOKIE]?.attributes.httponly).toBe(true);
    expect(registered.cookies[SESSION_COOKIE]?.attributes.samesite).toBe("Lax");
    expect(registered.cookies[CSRF_COOKIE]?.attributes.httponly).toBeUndefined();

    // Only the hash of the session token is stored.
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerifiedAt).toBeNull();
    expect(user.passwordHash.startsWith("$argon2id$v=19$m=19456,t=2,p=1$")).toBe(true);
    const sessions = await prisma.session.findMany({ where: { userId: user.id } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.tokenHash).toBe(hashToken(jar.get(SESSION_COOKIE)!));

    const meBefore = await callRoute<CurrentUserBody>(meRoute, { path: "/api/auth/me", jar });
    expect(meBefore.status).toBe(200);
    expect(meBefore.body.user).toMatchObject({ email, name: "Sam Owner", emailVerified: false });
    expect(meBefore.body.organisations).toEqual([]);
    expect(meBefore.body.currentOrganisationId).toBeNull();
    expect(meBefore.body.csrfToken).toBe(jar.get(CSRF_COOKIE));

    // The verification email carries an APP_URL link with a single-use token.
    const token = lastEmailToken(email, "/verify-email");
    const verified = await callRoute(verifyEmailRoute, {
      method: "POST",
      path: "/api/auth/verify-email",
      body: { token },
    });
    expect(verified.status).toBe(200);
    const reused = await callRoute<ErrorBody>(verifyEmailRoute, {
      method: "POST",
      path: "/api/auth/verify-email",
      body: { token },
    });
    expect(reused.status).toBe(400);
    expect(reused.body.error.code).toBe("INVALID_TOKEN");

    // Fresh browser: log in.
    const loginJar = new CookieJar();
    const login = await callRoute<{ ok: boolean; csrfToken: string }>(loginRoute, {
      method: "POST",
      path: "/api/auth/login",
      jar: loginJar,
      body: { email: email.toUpperCase(), password: "Sup3r-secret-pass" },
    });
    expect(login.status).toBe(200);
    expect(login.body.ok).toBe(true);

    const me = await callRoute<CurrentUserBody>(meRoute, { path: "/api/auth/me", jar: loginJar });
    expect(me.status).toBe(200);
    expect(me.body.user.emailVerified).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).lastLoginAt).not.toBeNull();
  });

  it("answers a registration for an existing email like a new one, changes nothing and emails the owner", async () => {
    const { user, password } = await createTestUser({ name: "Existing Owner" });
    const res = await callRoute<{
      ok: boolean;
      requiresEmailVerification: boolean;
      csrfToken: string;
    }>(registerRoute, {
      method: "POST",
      path: "/api/auth/register",
      body: { name: "Dupe", email: user.email.toUpperCase(), password: "Another-pass-123" },
    });
    // Same status and body shape as a new registration (no EMAIL_ALREADY_REGISTERED).
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(["csrfToken", "ok", "requiresEmailVerification"]);
    expect(res.body.ok).toBe(true);
    // No session for the existing account; only a fresh CSRF token.
    expect(res.cookies[SESSION_COOKIE]?.deleted ?? true).toBe(true);
    expect(res.cookies[CSRF_COOKIE]?.value).toBe(res.body.csrfToken);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);

    // The account is untouched: old name, old password still works.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.name).toBe("Existing Owner");
    expect(after.passwordHash).toBe(user.passwordHash);
    const login = await callRoute(loginRoute, {
      method: "POST",
      path: "/api/auth/login",
      body: { email: user.email, password },
    });
    expect(login.status).toBe(200);

    // The owner is told, with sign-in / reset links and no token.
    const notice = testEmails().last(user.email);
    expect(notice?.subject).toBe("You already have a ClockOff account");
    expect(notice?.text).toContain("/forgot-password");
    expect(notice?.text).not.toContain("token=");
  });

  it("registering ends the browser's previous session", async () => {
    const { user } = await createTestUser();
    const jar = await loginAs(user);
    const previous = jar.get(SESSION_COOKIE)!;
    const res = await callRoute(registerRoute, {
      method: "POST",
      path: "/api/auth/register",
      jar,
      body: { name: "Second Account", email: uniqueEmail("second"), password: "Sup3r-secret-pass" },
    });
    expect(res.status).toBe(201);
    expect(jar.get(SESSION_COOKIE)).not.toBe(previous);
    expect(
      (await prisma.session.findUniqueOrThrow({ where: { tokenHash: hashToken(previous) } }))
        .revokedAt,
    ).not.toBeNull();
  });

  it("validates the body with the shared schema", async () => {
    const res = await callRoute<ErrorBody>(registerRoute, {
      method: "POST",
      path: "/api/auth/register",
      body: { name: "", email: "not-an-email", password: "short" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    const details = res.body.error.details as { fieldErrors: Record<string, string[]> };
    expect(Object.keys(details.fieldErrors).sort()).toEqual(["email", "name", "password"]);
  });

  it("resend-verification issues a new token and invalidates the previous one", async () => {
    const { user } = await createTestUser({ verified: false });
    const jar = await loginAs(user);
    const first = await callRoute(resendVerificationRoute, {
      method: "POST",
      path: "/api/auth/resend-verification",
      jar,
    });
    expect(first.status).toBe(200);
    const firstToken = lastEmailToken(user.email, "/verify-email");
    await callRoute(resendVerificationRoute, {
      method: "POST",
      path: "/api/auth/resend-verification",
      jar,
    });
    const secondToken = lastEmailToken(user.email, "/verify-email");
    expect(secondToken).not.toBe(firstToken);

    const stale = await callRoute<ErrorBody>(verifyEmailRoute, {
      method: "POST",
      path: "/api/auth/verify-email",
      body: { token: firstToken },
    });
    expect(stale.body.error.code).toBe("INVALID_TOKEN");
    const ok = await callRoute(verifyEmailRoute, {
      method: "POST",
      path: "/api/auth/verify-email",
      body: { token: secondToken },
    });
    expect(ok.status).toBe(200);
  });
});

describe("login", () => {
  it("rejects a wrong password and an unknown email with the same error", async () => {
    const { user } = await createTestUser();
    const wrong = await callRoute<ErrorBody>(loginRoute, {
      method: "POST",
      path: "/api/auth/login",
      body: { email: user.email, password: "wrong-password-1" },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(wrong.setCookies).toEqual([]);

    const unknown = await callRoute<ErrorBody>(loginRoute, {
      method: "POST",
      path: "/api/auth/login",
      body: { email: uniqueEmail("nobody"), password: "wrong-password-1" },
    });
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it("rate limits login attempts per IP + email (10 per 15 minutes)", async () => {
    const { user } = await createTestUser();
    for (let i = 0; i < 10; i++) {
      const res = await callRoute(loginRoute, {
        method: "POST",
        path: "/api/auth/login",
        ip: "203.0.113.7",
        body: { email: user.email, password: `wrong-password-${i}` },
      });
      expect(res.status).toBe(401);
    }
    const blocked = await callRoute<ErrorBody>(loginRoute, {
      method: "POST",
      path: "/api/auth/login",
      ip: "203.0.113.7",
      body: { email: user.email, password: DEFAULT_TEST_PASSWORD },
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);

    // A different IP (or a different email) has its own bucket.
    const otherIp = await callRoute(loginRoute, {
      method: "POST",
      path: "/api/auth/login",
      ip: "203.0.113.8",
      body: { email: user.email, password: DEFAULT_TEST_PASSWORD },
    });
    expect(otherIp.status).toBe(200);
  });

  it("rotates the session on login and revokes the previous one", async () => {
    const { user, password } = await createTestUser();
    const jar = await loginAs(user);
    const before = jar.get(SESSION_COOKIE)!;
    const res = await callRoute(loginRoute, {
      method: "POST",
      path: "/api/auth/login",
      jar,
      body: { email: user.email, password },
    });
    expect(res.status).toBe(200);
    expect(jar.get(SESSION_COOKIE)).not.toBe(before);
    const old = await prisma.session.findUniqueOrThrow({ where: { tokenHash: hashToken(before) } });
    expect(old.revokedAt).not.toBeNull();
  });

  it("logout revokes the session and clears cookies", async () => {
    const { user } = await createTestUser();
    const jar = await loginAs(user);
    const token = jar.get(SESSION_COOKIE)!;
    const res = await callRoute(logoutRoute, { method: "POST", path: "/api/auth/logout", jar });
    expect(res.status).toBe(200);
    expect(jar.has(SESSION_COOKIE)).toBe(false);
    expect(jar.has(CSRF_COOKIE)).toBe(false);
    const session = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashToken(token) },
    });
    expect(session.revokedAt).not.toBeNull();

    const me = await callRoute<ErrorBody>(meRoute, {
      path: "/api/auth/me",
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects requests without a session", async () => {
    const res = await callRoute<ErrorBody>(meRoute, { path: "/api/auth/me" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { code: "UNAUTHENTICATED", message: "Sign in required" } });
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("treats expired sessions as signed out and slides active ones", async () => {
    const { user } = await createTestUser();
    const jar = await loginAs(user);
    const tokenHash = hashToken(jar.get(SESSION_COOKIE)!);

    // Less than half the TTL left → the expiry is extended.
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    await prisma.session.update({ where: { tokenHash }, data: { expiresAt: soon } });
    const slidResponse = await callRoute(meRoute, { path: "/api/auth/me", jar });
    expect(slidResponse.status).toBe(200);
    const slid = await prisma.session.findUniqueOrThrow({ where: { tokenHash } });
    expect(slid.expiresAt.getTime()).toBeGreaterThan(soon.getTime() + 24 * 60 * 60 * 1000);
    // The browser cookie is re-issued with a fresh Max-Age to match the extended session.
    expect(slidResponse.cookies[SESSION_COOKIE]?.value).toBe(jar.get(SESSION_COOKIE));
    expect(Number(slidResponse.cookies[SESSION_COOKIE]?.attributes["max-age"])).toBeGreaterThan(
      24 * 60 * 60,
    );
    expect(slidResponse.cookies[CSRF_COOKIE]?.value).toBe(jar.get(CSRF_COOKIE));

    // A request that does not slide does not re-issue cookies.
    const steady = await callRoute(meRoute, { path: "/api/auth/me", jar });
    expect(steady.cookies[SESSION_COOKIE]).toBeUndefined();

    await prisma.session.update({
      where: { tokenHash },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await callRoute(meRoute, { path: "/api/auth/me", jar })).status).toBe(401);
  });
});

describe("forgot / reset password", () => {
  it("always answers 200 and only emails existing accounts", async () => {
    const unknown = await callRoute(forgotPasswordRoute, {
      method: "POST",
      path: "/api/auth/forgot-password",
      body: { email: uniqueEmail("ghost") },
    });
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual({ ok: true });
    expect(testEmails().sent).toHaveLength(0);

    const { user } = await createTestUser();
    const known = await callRoute(forgotPasswordRoute, {
      method: "POST",
      path: "/api/auth/forgot-password",
      body: { email: user.email },
    });
    expect(known.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
    expect(known.setCookies).toEqual(unknown.setCookies);
    expect(testEmails().sent).toHaveLength(1);
  });

  it("issues the reset token and email after the response, not on the request path", async () => {
    const { user } = await createTestUser();
    const req = new NextRequest(new URL("/api/auth/forgot-password", env().APP_URL), {
      method: "POST",
      headers: { "content-type": "application/json", origin: env().APP_ORIGIN },
      body: JSON.stringify({ email: user.email }),
    });
    const res = await forgotPasswordRoute(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    // The response is complete while the known-account work is still pending…
    expect(pendingBackgroundTaskCount()).toBe(1);
    expect(testEmails().sent).toHaveLength(0);
    // …and it finishes afterwards.
    await settleBackgroundTasks();
    expect(
      await prisma.passwordResetToken.count({ where: { userId: user.id, usedAt: null } }),
    ).toBe(1);
    expect(lastEmailToken(user.email, "/reset-password")).toBeTruthy();
  });

  it("resets the password with a single-use token, revokes sessions and signs in fresh", async () => {
    const { user } = await createTestUser();
    const otherBrowser = await loginAs(user);

    await callRoute(forgotPasswordRoute, {
      method: "POST",
      path: "/api/auth/forgot-password",
      body: { email: user.email },
    });
    const firstToken = lastEmailToken(user.email, "/reset-password");
    await callRoute(forgotPasswordRoute, {
      method: "POST",
      path: "/api/auth/forgot-password",
      body: { email: user.email },
    });
    const token = lastEmailToken(user.email, "/reset-password");
    expect(token).not.toBe(firstToken);
    // One active token per user: the earlier one no longer works.
    const stale = await callRoute<ErrorBody>(resetPasswordRoute, {
      method: "POST",
      path: "/api/auth/reset-password",
      body: { token: firstToken, password: "Brand-new-pass-1" },
    });
    expect(stale.body.error.code).toBe("INVALID_TOKEN");

    const jar = new CookieJar();
    const reset = await callRoute(resetPasswordRoute, {
      method: "POST",
      path: "/api/auth/reset-password",
      jar,
      body: { token, password: "Brand-new-pass-1" },
    });
    expect(reset.status).toBe(200);
    expect(jar.get(SESSION_COOKIE)).toBeTruthy();
    expect((await callRoute(meRoute, { path: "/api/auth/me", jar })).status).toBe(200);
    expect((await callRoute(meRoute, { path: "/api/auth/me", jar: otherBrowser })).status).toBe(
      401,
    );

    const again = await callRoute<ErrorBody>(resetPasswordRoute, {
      method: "POST",
      path: "/api/auth/reset-password",
      body: { token, password: "Another-pass-22" },
    });
    expect(again.body.error.code).toBe("INVALID_TOKEN");

    const oldLogin = await callRoute(loginRoute, {
      method: "POST",
      path: "/api/auth/login",
      body: { email: user.email, password: DEFAULT_TEST_PASSWORD },
    });
    expect(oldLogin.status).toBe(401);
    const newLogin = await callRoute(loginRoute, {
      method: "POST",
      path: "/api/auth/login",
      body: { email: user.email, password: "Brand-new-pass-1" },
    });
    expect(newLogin.status).toBe(200);
  });

  it("rejects expired reset tokens", async () => {
    const { user } = await createTestUser();
    await callRoute(forgotPasswordRoute, {
      method: "POST",
      path: "/api/auth/forgot-password",
      body: { email: user.email },
    });
    const token = lastEmailToken(user.email, "/reset-password");
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    const res = await callRoute<ErrorBody>(resetPasswordRoute, {
      method: "POST",
      path: "/api/auth/reset-password",
      body: { token, password: "Brand-new-pass-1" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TOKEN_EXPIRED");
  });
});

describe("change password", () => {
  it("requires the current password and revokes the user's other sessions", async () => {
    const { user, password } = await createTestUser();
    const current = await loginAs(user);
    const other = await loginAs(user);

    const wrong = await callRoute<ErrorBody>(changePasswordRoute, {
      method: "POST",
      path: "/api/auth/change-password",
      jar: current,
      body: { currentPassword: "not-my-password-1", newPassword: "Changed-pass-123" },
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe("INVALID_CREDENTIALS");

    const ok = await callRoute<{ ok: boolean; revokedSessions: number }>(changePasswordRoute, {
      method: "POST",
      path: "/api/auth/change-password",
      jar: current,
      body: { currentPassword: password, newPassword: "Changed-pass-123" },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.revokedSessions).toBe(1);
    expect((await callRoute(meRoute, { path: "/api/auth/me", jar: current })).status).toBe(200);
    expect((await callRoute(meRoute, { path: "/api/auth/me", jar: other })).status).toBe(401);
  });
});

describe("CSRF", () => {
  it("rejects a mutating manager request without the x-csrf-token header", async () => {
    const { user, password } = await createTestUser();
    const jar = await loginAs(user);
    const res = await callRoute<ErrorBody>(changePasswordRoute, {
      method: "POST",
      path: "/api/auth/change-password",
      jar,
      csrf: false,
      body: { currentPassword: password, newPassword: "Changed-pass-123" },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CSRF_FAILED");
  });

  it("rejects a header that does not match the cookie, and a forged unsigned cookie", async () => {
    const { user, password } = await createTestUser();
    const jar = await loginAs(user);
    const mismatched = await callRoute<ErrorBody>(changePasswordRoute, {
      method: "POST",
      path: "/api/auth/change-password",
      jar,
      headers: { "x-csrf-token": "attacker.value" },
      body: { currentPassword: password, newPassword: "Changed-pass-123" },
    });
    expect(mismatched.body.error.code).toBe("CSRF_FAILED");

    jar.set(CSRF_COOKIE, "forged.token");
    const forged = await callRoute<ErrorBody>(changePasswordRoute, {
      method: "POST",
      path: "/api/auth/change-password",
      jar,
      body: { currentPassword: password, newPassword: "Changed-pass-123" },
    });
    expect(forged.body.error.code).toBe("CSRF_FAILED");
  });

  it("rejects a cross-origin mutating request even with a valid token", async () => {
    const { user, password } = await createTestUser();
    const jar = await loginAs(user);
    const res = await callRoute<ErrorBody>(changePasswordRoute, {
      method: "POST",
      path: "/api/auth/change-password",
      jar,
      origin: "https://evil.example",
      body: { currentPassword: password, newPassword: "Changed-pass-123" },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CSRF_FAILED");
  });

  it("GET /api/auth/me re-issues a missing CSRF cookie", async () => {
    const { user } = await createTestUser();
    const jar = await loginAs(user);
    jar.delete(CSRF_COOKIE);
    const res = await callRoute<CurrentUserBody>(meRoute, { path: "/api/auth/me", jar });
    expect(res.status).toBe(200);
    expect(jar.get(CSRF_COOKIE)).toBe(res.body.csrfToken);
  });
});

describe("REQUIRE_EMAIL_VERIFICATION", () => {
  it("blocks org-scoped routes for unverified managers but keeps auth routes working", async () => {
    process.env.REQUIRE_EMAIL_VERIFICATION = "true";
    resetEnvCache();
    const { user } = await createTestUser({ verified: false });
    const { organisation } = await createTestOrg({ owner: user });
    const jar = await loginAs(user, { organisationId: organisation.id });

    const blocked = await callRoute<ErrorBody>(currentOrgRoute, {
      path: "/api/organisations/current",
      jar,
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("EMAIL_NOT_VERIFIED");

    const me = await callRoute<CurrentUserBody>(meRoute, { path: "/api/auth/me", jar });
    expect(me.status).toBe(200);
    expect(me.body.user.emailVerified).toBe(false);

    await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    const allowed = await callRoute(currentOrgRoute, { path: "/api/organisations/current", jar });
    expect(allowed.status).toBe(200);
  });

  it("register creates no session, answers new and existing emails identically, then verify → login works", async () => {
    process.env.REQUIRE_EMAIL_VERIFICATION = "true";
    resetEnvCache();
    const email = uniqueEmail("strict");
    const register = (address: string) =>
      callRoute<{ ok: boolean; requiresEmailVerification: boolean; csrfToken: string }>(
        registerRoute,
        {
          method: "POST",
          path: "/api/auth/register",
          body: { name: "Strict", email: address, password: "Sup3r-secret-pass" },
        },
      );

    const fresh = await register(email);
    const { user: existing } = await createTestUser();
    const duplicate = await register(existing.email);

    for (const res of [fresh, duplicate]) {
      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.requiresEmailVerification).toBe(true);
    }
    // Identical cookie names and attributes (values differ: each carries its own CSRF token).
    const shape = (r: typeof fresh) =>
      Object.values(r.cookies).map((c) => ({
        name: c.name,
        deleted: c.deleted,
        attributes: { ...c.attributes, expires: undefined },
      }));
    expect(shape(duplicate)).toEqual(shape(fresh));
    expect(fresh.cookies[SESSION_COOKIE]?.deleted).toBe(true);

    const created = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(created.emailVerifiedAt).toBeNull();
    expect(await prisma.session.count({ where: { userId: created.id } })).toBe(0);

    const token = lastEmailToken(email, "/verify-email");
    expect(
      (
        await callRoute(verifyEmailRoute, {
          method: "POST",
          path: "/api/auth/verify-email",
          body: { token },
        })
      ).status,
    ).toBe(200);
    const jar = new CookieJar();
    const login = await callRoute<{ requiresEmailVerification: boolean }>(loginRoute, {
      method: "POST",
      path: "/api/auth/login",
      jar,
      body: { email, password: "Sup3r-secret-pass" },
    });
    expect(login.status).toBe(200);
    expect(login.body.requiresEmailVerification).toBe(false);
    expect((await callRoute(meRoute, { path: "/api/auth/me", jar })).status).toBe(200);
  });
});

describe("public endpoints (origin and abuse controls)", () => {
  it("login rejects a foreign Origin at the handler, behind the middleware", async () => {
    const { user, password } = await createTestUser();
    const res = await callRoute<ErrorBody>(loginRoute, {
      method: "POST",
      path: "/api/auth/login",
      origin: "https://evil.example",
      body: { email: user.email, password },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CSRF_FAILED");
    expect(res.setCookies).toEqual([]);
  });

  it("login is also limited per IP across emails (credential stuffing)", async () => {
    const ip = "203.0.113.50";
    const rule = RATE_LIMITS.loginPerIp;
    for (let i = 0; i < rule.limit; i++)
      await getRateLimiter().hit(rateLimitKey(rule.key, ip), rule.limit, rule.windowSeconds);
    const res = await callRoute<ErrorBody>(loginRoute, {
      method: "POST",
      path: "/api/auth/login",
      ip,
      body: { email: uniqueEmail("stuffing"), password: "whatever-123" },
    });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
