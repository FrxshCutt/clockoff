import { prisma, type Prisma, type Session, type User } from "@workmode/db";
import { env } from "@/lib/env";
import { generateToken, hashToken, DAY_MS, MINUTE_MS } from "@/lib/tokens";

/**
 * Manager web sessions: opaque 32-byte token in the `wm_session` cookie, sha256 at rest, sliding
 * expiry (extended when less than half of the TTL remains), `lastSeenAt` refreshed at most once a
 * minute to avoid write amplification.
 */

export interface SessionMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface CreatedSession {
  /** Raw cookie value. Never persisted. */
  token: string;
  session: Session;
}

export interface ResolvedSession {
  session: Session;
  user: User;
  /** True when this lookup extended the expiry (the cookie should be re-issued to match). */
  slid: boolean;
}

type Db = Prisma.TransactionClient | typeof prisma;

export function sessionTtlMs(): number {
  return env().SESSION_TTL_DAYS * DAY_MS;
}

export async function createSession(
  userId: string,
  meta: SessionMeta,
  db: Db = prisma,
): Promise<CreatedSession> {
  const { raw, hash } = generateToken(32);
  const now = new Date();
  const session = await db.session.create({
    data: {
      userId,
      tokenHash: hash,
      expiresAt: new Date(now.getTime() + sessionTtlMs()),
      lastSeenAt: now,
      ip: meta.ip,
      userAgent: meta.userAgent,
    },
  });
  return { token: raw, session };
}

/**
 * Look up a presented session token. Returns null for unknown, revoked or expired sessions, or when
 * the user is soft-deleted. Slides the expiry and touches `lastSeenAt` as a side effect.
 */
export async function resolveSession(
  rawToken: string,
  meta?: Partial<SessionMeta>,
): Promise<ResolvedSession | null> {
  if (!rawToken || rawToken.length > 256) return null;
  const now = new Date();
  const found = await prisma.session.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { user: true },
  });
  if (!found) return null;
  if (found.revokedAt || found.expiresAt.getTime() <= now.getTime()) return null;
  if (found.user.deletedAt) return null;

  const ttl = sessionTtlMs();
  const remaining = found.expiresAt.getTime() - now.getTime();
  const shouldSlide = remaining < ttl / 2;
  const shouldTouch = now.getTime() - found.lastSeenAt.getTime() > MINUTE_MS;

  let session: Session = stripUser(found);
  if (shouldSlide || shouldTouch) {
    session = await prisma.session.update({
      where: { id: found.id },
      data: {
        lastSeenAt: now,
        ...(shouldSlide ? { expiresAt: new Date(now.getTime() + ttl) } : {}),
        ...(meta?.ip !== undefined ? { ip: meta.ip } : {}),
        ...(meta?.userAgent !== undefined ? { userAgent: meta.userAgent } : {}),
      },
    });
  }
  return { session, user: found.user, slid: shouldSlide };
}

function stripUser(row: Session & { user: User }): Session {
  const { user: _user, ...session } = row;
  return session;
}

export async function revokeSession(sessionId: string, db: Db = prisma): Promise<void> {
  await db.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeSessionByToken(rawToken: string): Promise<void> {
  await prisma.session.updateMany({
    where: { tokenHash: hashToken(rawToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Revoke every live session of a user, optionally keeping one (the current). Returns the count. */
export async function revokeUserSessions(
  userId: string,
  options: { exceptSessionId?: string } = {},
  db: Db = prisma,
): Promise<number> {
  const result = await db.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(options.exceptSessionId ? { id: { not: options.exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date() },
  });
  return result.count;
}
