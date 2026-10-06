import { Prisma, prisma, type User } from "@workmode/db";
import { AppError } from "@workmode/shared/errors";
import type { CurrentUser, LoginInput, RegisterInput } from "@workmode/validation/auth";
import {
  ORG_COOKIE,
  SESSION_COOKIE,
  clearAuthCookies,
  clearCookie,
  csrfCookie,
  orgCookie,
  sessionCookie,
} from "@/lib/cookies";
import { createCsrfToken } from "@/lib/crypto";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { DUMMY_PASSWORD_HASH, hashPassword, needsRehash, verifyPassword } from "@/lib/password";
import {
  EMAIL_VERIFICATION_TOKEN_TTL_MS,
  PASSWORD_RESET_TOKEN_TTL_MS,
  expiresIn,
  generateToken,
  hashToken,
  isExpired,
} from "@/lib/tokens";
import { ensureCsrfToken } from "@/server/auth/csrf";
import {
  createSession,
  revokeSessionByToken,
  revokeUserSessions,
  type SessionMeta,
} from "@/server/auth/sessions";
import { runAfterResponse } from "@/server/background";
import {
  accountExistsEmail,
  passwordResetEmail,
  sendEmailSafely,
  verificationEmail,
} from "@/server/email";
import {
  resolveOrganisationSelection,
  type RequestMeta,
  type UserContext,
} from "@/server/tenancy/context";

/**
 * Manager authentication flows (first-party, D-007). Route handlers stay thin: they validate input with
 * the `@workmode/validation/auth` schemas, call these functions, and attach the returned cookies.
 *
 * Invariants:
 * - Raw tokens (session, CSRF, verification, reset) leave the server exactly once; only sha256 is stored.
 * - No account enumeration: login, register and forgot-password answer with the same status, body and
 *   (to within a database round trip) the same time whether or not the email has an account.
 * - Every successful authentication rotates the session (new token, new CSRF token).
 */

type Db = Prisma.TransactionClient | typeof prisma;

/** Result of any flow that signs a manager in. */
export interface SignedIn {
  user: User;
  /** `Set-Cookie` values: session, CSRF and organisation selection. */
  cookies: string[];
  csrfToken: string;
  /** True when `REQUIRE_EMAIL_VERIFICATION` is on and this user has not verified yet. */
  requiresEmailVerification: boolean;
}

export function requiresEmailVerification(user: Pick<User, "emailVerifiedAt">): boolean {
  return env().REQUIRE_EMAIL_VERIFICATION && !user.emailVerifiedAt;
}

function toSessionMeta(meta: Pick<RequestMeta, "ip" | "userAgent">): SessionMeta {
  return { ip: meta.ip, userAgent: meta.userAgent };
}

/**
 * Create a fresh session for `user` and build the cookies that install it. A new CSRF token is minted
 * on every sign-in; `organisationId` (when given) becomes the selected organisation, otherwise any
 * previous selection cookie is cleared so it cannot carry over between accounts on one browser.
 */
export async function signIn(
  user: User,
  meta: Pick<RequestMeta, "ip" | "userAgent">,
  options: { organisationId?: string | null; db?: Db } = {},
): Promise<SignedIn> {
  const { token } = await createSession(user.id, toSessionMeta(meta), options.db ?? prisma);
  const csrfToken = createCsrfToken();
  const cookies = [
    sessionCookie(token),
    csrfCookie(csrfToken),
    options.organisationId ? orgCookie(options.organisationId) : clearCookie(ORG_COOKIE),
  ];
  return { user, cookies, csrfToken, requiresEmailVerification: requiresEmailVerification(user) };
}

// ── Email verification tokens ───────────────────────────────────────────────

/** Replace any unused verification token of the user with a new one (24 h). Returns the raw token. */
export async function issueEmailVerificationToken(
  userId: string,
  db: Db = prisma,
): Promise<string> {
  const { raw, hash } = generateToken(32);
  await db.emailVerificationToken.deleteMany({ where: { userId, usedAt: null } });
  await db.emailVerificationToken.create({
    data: { userId, tokenHash: hash, expiresAt: expiresIn(EMAIL_VERIFICATION_TOKEN_TTL_MS) },
  });
  return raw;
}

async function sendVerificationEmail(
  user: Pick<User, "email" | "name">,
  token: string,
): Promise<void> {
  await sendEmailSafely({ to: user.email, ...verificationEmail({ name: user.name, token }) });
}

// ── Register / login / logout ───────────────────────────────────────────────

/** Outcome of `POST /api/auth/register` (identical for new and already-registered addresses). */
export interface RegisterOutcome {
  /** Mirrors `REQUIRE_EMAIL_VERIFICATION`; the same value whichever branch was taken. */
  requiresEmailVerification: boolean;
  /** Always present: a CSRF token (and its cookie) is issued even when no session is created. */
  csrfToken: string;
  /** `Set-Cookie` values. */
  cookies: string[];
  /** Whether a session was created (only for a NEW account when verification is not required). */
  signedIn: boolean;
}

/**
 * `POST /api/auth/register`. Enumeration-resistant: the status and body are the same whether or not the
 * address already has an account, and so is the expensive work (argon2 hashing happens first in every
 * branch; emails are sent after the response via `runAfterResponse`).
 *
 * - New address: the unverified account is created and a verification email is sent. When
 *   `REQUIRE_EMAIL_VERIFICATION` is on (production default) no session is created — the manager verifies,
 *   then signs in — so the response is indistinguishable from the existing-address case, cookies
 *   included. When it is off (development) the new account is signed in immediately.
 * - Existing address: nothing changes; the owner is emailed that someone tried to register (with
 *   sign-in and forgot-password links, no token).
 *
 * Registering always ends the browser's previous session (like login), so a register page left open
 * while signed in cannot leave the old account active under the new identity.
 */
export async function registerManager(
  input: RegisterInput,
  meta: RequestMeta,
  previousSessionToken?: string,
): Promise<RegisterOutcome> {
  const passwordHash = await hashPassword(input.password);
  const verificationRequired = env().REQUIRE_EMAIL_VERIFICATION;

  let created: { user: User; verificationToken: string } | null;
  try {
    created = await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({
        where: { email: input.email },
        select: { id: true },
      });
      if (existing) return null;
      const user = await tx.user.create({
        data: { email: input.email, name: input.name, passwordHash },
      });
      const verificationToken = await issueEmailVerificationToken(user.id, tx);
      return { user, verificationToken };
    });
  } catch (err) {
    // A concurrent registration of the same address won the unique index: same outcome as "exists".
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    created = null;
  }

  if (previousSessionToken) await revokeSessionByToken(previousSessionToken);

  if (!created) {
    const email = input.email;
    runAfterResponse("auth:register-existing-account", () => notifyExistingAccount(email));
    logger.info({ requestId: meta.requestId }, "registration attempted for an existing account");
    return withoutSession(verificationRequired);
  }

  const { user: newUser, verificationToken } = created;
  runAfterResponse("auth:verification-email", () =>
    sendVerificationEmail(newUser, verificationToken),
  );
  logger.info({ userId: newUser.id, requestId: meta.requestId }, "manager registered");
  if (verificationRequired) return withoutSession(true);

  const user = await prisma.user.update({
    where: { id: newUser.id },
    data: { lastLoginAt: new Date() },
  });
  const signedIn = await signIn(user, meta);
  return {
    requiresEmailVerification: false,
    csrfToken: signedIn.csrfToken,
    cookies: signedIn.cookies,
    signedIn: true,
  };
}

/** Register response without a session: fresh CSRF token, previous session / organisation cookies cleared. */
function withoutSession(requiresEmailVerification: boolean): RegisterOutcome {
  const csrfToken = createCsrfToken();
  return {
    requiresEmailVerification,
    csrfToken,
    cookies: [clearCookie(SESSION_COOKIE), csrfCookie(csrfToken), clearCookie(ORG_COOKIE)],
    signedIn: false,
  };
}

async function notifyExistingAccount(email: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { email: true, name: true, deletedAt: true },
  });
  if (!user || user.deletedAt) return;
  await sendEmailSafely({ to: user.email, ...accountExistsEmail({ name: user.name }) });
}

/**
 * `POST /api/auth/login`. Unknown emails are verified against a dummy hash so response timing does not
 * reveal whether an account exists. The presented session (if any) is revoked: sign-in always rotates.
 */
export async function loginManager(
  input: LoginInput,
  meta: RequestMeta,
  previousSessionToken?: string,
): Promise<SignedIn> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  const usable = user && !user.deletedAt ? user : null;
  const ok = await verifyPassword(usable?.passwordHash ?? DUMMY_PASSWORD_HASH, input.password);
  if (!usable || !ok) {
    logger.info({ requestId: meta.requestId, knownUser: Boolean(usable) }, "login failed");
    throw new AppError("INVALID_CREDENTIALS", "Email or password is incorrect");
  }

  const data: Prisma.UserUpdateInput = { lastLoginAt: new Date() };
  if (needsRehash(usable.passwordHash)) data.passwordHash = await hashPassword(input.password);
  const updated = await prisma.user.update({ where: { id: usable.id }, data });

  if (previousSessionToken) await revokeSessionByToken(previousSessionToken);
  const selection = await resolveOrganisationSelection(updated.id, undefined);
  return signIn(updated, meta, { organisationId: selection?.organisation.id ?? null });
}

/** `POST /api/auth/logout`: revoke the presented session (if any) and clear every auth cookie. */
export async function logoutManager(sessionToken: string | undefined): Promise<string[]> {
  if (sessionToken) await revokeSessionByToken(sessionToken);
  return clearAuthCookies();
}

// ── Password reset ──────────────────────────────────────────────────────────

/**
 * `POST /api/auth/forgot-password`. Always succeeds from the caller's point of view (no account
 * enumeration), in the same time: the request path does one lookup by email for every address; token
 * issuance and the email for an existing account happen after the response (`runAfterResponse`).
 * One active reset token per user: issuing a new one deletes the unused previous ones.
 */
export async function requestPasswordReset(email: string, meta: RequestMeta): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, deletedAt: true },
  });
  if (!user || user.deletedAt) {
    logger.info({ requestId: meta.requestId }, "password reset requested for unknown email");
    return;
  }
  const userId = user.id;
  runAfterResponse("auth:password-reset-email", () => issuePasswordReset(userId, meta.requestId));
}

async function issuePasswordReset(userId: string, requestId: string): Promise<void> {
  const { raw, hash } = generateToken(32);
  const user = await prisma.$transaction(async (tx) => {
    await tx.passwordResetToken.deleteMany({ where: { userId, usedAt: null } });
    await tx.passwordResetToken.create({
      data: { userId, tokenHash: hash, expiresAt: expiresIn(PASSWORD_RESET_TOKEN_TTL_MS) },
    });
    return tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, name: true },
    });
  });
  await sendEmailSafely({ to: user.email, ...passwordResetEmail({ name: user.name, token: raw }) });
  logger.info({ requestId, userId }, "password reset issued");
}

/**
 * `POST /api/auth/reset-password`: consume the token, set the new password, revoke every session and
 * sign in fresh. A reset link proves control of the mailbox, so an unverified address becomes verified.
 */
export async function resetPassword(
  input: { token: string; password: string },
  meta: RequestMeta,
): Promise<SignedIn> {
  const found = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(input.token) },
  });
  if (!found || found.usedAt)
    throw new AppError("INVALID_TOKEN", "This reset link is invalid or has already been used");
  if (isExpired(found.expiresAt))
    throw new AppError("TOKEN_EXPIRED", "This reset link has expired");

  const passwordHash = await hashPassword(input.password);
  const user = await prisma.$transaction(async (tx) => {
    const claimed = await tx.passwordResetToken.updateMany({
      where: { id: found.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1)
      throw new AppError("INVALID_TOKEN", "This reset link is invalid or has already been used");
    const current = await tx.user.findUniqueOrThrow({ where: { id: found.userId } });
    if (current.deletedAt)
      throw new AppError("INVALID_TOKEN", "This reset link is invalid or has already been used");
    const updated = await tx.user.update({
      where: { id: found.userId },
      data: {
        passwordHash,
        lastLoginAt: new Date(),
        ...(current.emailVerifiedAt ? {} : { emailVerifiedAt: new Date() }),
      },
    });
    await tx.passwordResetToken.deleteMany({ where: { userId: found.userId, usedAt: null } });
    await revokeUserSessions(found.userId, {}, tx);
    return updated;
  });
  logger.info({ requestId: meta.requestId, userId: user.id }, "password reset completed");
  const selection = await resolveOrganisationSelection(user.id, undefined);
  return signIn(user, meta, { organisationId: selection?.organisation.id ?? null });
}

// ── Email verification ──────────────────────────────────────────────────────

/** `POST /api/auth/verify-email`: consume a verification token and mark the address verified. */
export async function verifyEmail(token: string): Promise<{ userId: string }> {
  const found = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  if (!found || found.usedAt) {
    throw new AppError(
      "INVALID_TOKEN",
      "This verification link is invalid or has already been used",
    );
  }
  if (isExpired(found.expiresAt))
    throw new AppError("TOKEN_EXPIRED", "This verification link has expired");
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.emailVerificationToken.updateMany({
      where: { id: found.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new AppError(
        "INVALID_TOKEN",
        "This verification link is invalid or has already been used",
      );
    }
    await tx.user.updateMany({
      where: { id: found.userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    });
  });
  return { userId: found.userId };
}

/** `POST /api/auth/resend-verification` (signed in). No-op for already verified users. */
export async function resendVerification(ctx: UserContext): Promise<{ alreadyVerified: boolean }> {
  if (ctx.user.emailVerifiedAt) return { alreadyVerified: true };
  const token = await issueEmailVerificationToken(ctx.user.id);
  await sendVerificationEmail(ctx.user, token);
  return { alreadyVerified: false };
}

// ── Change password ─────────────────────────────────────────────────────────

/** `POST /api/auth/change-password`: verify the current password, set the new one, revoke other sessions. */
export async function changePassword(
  ctx: UserContext,
  input: { currentPassword: string; newPassword: string },
): Promise<{ revokedSessions: number }> {
  const ok = await verifyPassword(ctx.user.passwordHash, input.currentPassword);
  if (!ok) {
    // 400 rather than the code's default 401: the caller is signed in; the form field is wrong.
    throw new AppError("INVALID_CREDENTIALS", "Current password is incorrect", {
      status: 400,
      details: { field: "currentPassword" },
    });
  }
  const passwordHash = await hashPassword(input.newPassword);
  const revokedSessions = await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: ctx.user.id }, data: { passwordHash } });
    await tx.passwordResetToken.deleteMany({ where: { userId: ctx.user.id, usedAt: null } });
    return revokeUserSessions(ctx.user.id, { exceptSessionId: ctx.session.id }, tx);
  });
  logger.info(
    { requestId: ctx.requestId, userId: ctx.user.id, revokedSessions },
    "password changed",
  );
  return { revokedSessions };
}

// ── Current user / organisation selection ───────────────────────────────────

/**
 * `GET /api/auth/me`. Also (re)installs the CSRF cookie when it is missing and keeps the `wm_org`
 * cookie in sync with the organisation actually selected (a stale/forged value falls back to the
 * first membership).
 */
export async function getCurrentUser(
  ctx: UserContext,
  req: Request,
  requestedOrganisationId: string | undefined,
): Promise<{ body: CurrentUser; cookies: string[] }> {
  const memberships = await prisma.organisationMembership.findMany({
    where: { userId: ctx.user.id, organisation: { deletedAt: null } },
    include: { organisation: true },
    orderBy: { createdAt: "asc" },
  });
  const selected =
    memberships.find((m) => m.organisationId === requestedOrganisationId) ?? memberships[0] ?? null;

  const cookies: string[] = [];
  const csrf = ensureCsrfToken(req);
  if (csrf.setCookie) cookies.push(csrf.setCookie);
  if (selected && selected.organisationId !== requestedOrganisationId)
    cookies.push(orgCookie(selected.organisationId));
  if (!selected && requestedOrganisationId) cookies.push(clearCookie(ORG_COOKIE));

  return {
    body: {
      user: {
        id: ctx.user.id,
        email: ctx.user.email,
        name: ctx.user.name,
        emailVerified: Boolean(ctx.user.emailVerifiedAt),
        createdAt: ctx.user.createdAt.toISOString(),
      },
      organisations: memberships.map((m) => ({
        id: m.organisation.id,
        name: m.organisation.name,
        slug: m.organisation.slug,
        role: m.role,
        timezone: m.organisation.timezone,
      })),
      currentOrganisationId: selected?.organisationId ?? null,
      csrfToken: csrf.token,
    },
    cookies,
  };
}

/**
 * `POST /api/auth/switch-organisation`. The caller must be a member; otherwise `NOT_FOUND` (an
 * organisation the caller does not belong to is indistinguishable from one that does not exist).
 */
export async function switchOrganisation(
  ctx: UserContext,
  organisationId: string,
): Promise<{ organisationId: string; cookies: string[] }> {
  const membership = await prisma.organisationMembership.findFirst({
    where: { userId: ctx.user.id, organisationId, organisation: { deletedAt: null } },
    select: { organisationId: true },
  });
  if (!membership) throw new AppError("NOT_FOUND", "Organisation not found");
  return { organisationId, cookies: [orgCookie(organisationId)] };
}
