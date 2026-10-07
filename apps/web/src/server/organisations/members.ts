import { Prisma, prisma, type Role, type User } from "@clockoff/db";
import { AppError } from "@clockoff/shared/errors";
import { outranksOrEquals } from "@clockoff/shared/permissions";
import type {
  AcceptManagerInviteResponse,
  InviteMemberInput,
  ListMembersResponse,
  ManagerInvite,
  ManagerInvitePreviewResponse,
  Member,
} from "@clockoff/validation/organisation";
import { logger } from "@/lib/logger";
import { hashPassword, verifyPassword } from "@/lib/password";
import { MANAGER_INVITE_TTL_MS, expiresIn, generateToken, hashToken } from "@/lib/tokens";
import { audit } from "@/server/audit/audit";
import { signIn } from "@/server/auth/service";
import { resolveSession, revokeSessionByToken } from "@/server/auth/sessions";
import { managerInviteEmail, sendEmailSafely } from "@/server/email";
import type { ManagerContext, RequestMeta } from "@/server/tenancy/context";
import { managerInviteState, toManagerInviteDto, toMemberDto } from "./mappers";
import {
  findManagerInviteInOrganisation,
  findMembershipInOrganisation,
  lockOwnerMemberships,
} from "./repository";

/**
 * Manager membership & manager-invite rules (§4):
 * - Inviting / changing roles / removing others requires `members:invite` (enforced by the route) AND
 *   the actor's role must outrank or equal the role being granted or the member being changed.
 * - Only an OWNER can grant OWNER or change/remove an OWNER.
 * - The last OWNER can neither be demoted nor removed (`LAST_OWNER`); owner rows are locked while
 *   checking so concurrent requests cannot race past the rule.
 * - Anyone may remove their own membership (leave), subject to the last-owner rule.
 * - Invite tokens are 32 random bytes, sha256 at rest, valid 7 days, never returned by the API (only
 *   emailed). Accepting as an EXISTING account requires being signed in as that account or presenting
 *   its password, so a leaked invite link is never a login link.
 */

const memberUserSelect = {
  id: true,
  name: true,
  email: true,
  emailVerifiedAt: true,
  lastLoginAt: true,
} as const;

function assertCanGrant(actorRole: Role, role: Role): void {
  if (role === "OWNER" && actorRole !== "OWNER") {
    throw new AppError("FORBIDDEN", "Only an owner can grant the owner role");
  }
  if (!outranksOrEquals(actorRole, role)) {
    throw new AppError("FORBIDDEN", "You cannot grant a role above your own");
  }
}

function assertCanManage(actorRole: Role, targetRole: Role): void {
  if (targetRole === "OWNER" && actorRole !== "OWNER") {
    throw new AppError("FORBIDDEN", "Only an owner can change another owner");
  }
  if (!outranksOrEquals(actorRole, targetRole)) {
    throw new AppError("FORBIDDEN", "You cannot change a member with a higher role");
  }
}

// ── List ────────────────────────────────────────────────────────────────────

/** `GET /api/organisations/current/members`: members plus manager invites (newest first). */
export async function listMembers(ctx: ManagerContext): Promise<ListMembersResponse> {
  const organisationId = ctx.organisation.id;
  const [memberships, invites] = await Promise.all([
    prisma.organisationMembership.findMany({
      where: { organisationId },
      include: { user: { select: memberUserSelect } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.managerInvite.findMany({
      where: { organisationId },
      include: { invitedBy: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
  ]);
  const now = new Date();
  return {
    members: memberships.map((m) => toMemberDto(m, ctx.user.id)),
    invites: invites.map((i) => toManagerInviteDto(i, now)),
  };
}

// ── Invite / resend / revoke ────────────────────────────────────────────────

async function sendInviteEmail(
  ctx: ManagerContext,
  invite: { email: string; role: Role },
  rawToken: string,
): Promise<void> {
  await sendEmailSafely({
    to: invite.email,
    ...managerInviteEmail({
      organisationName: ctx.organisation.name,
      inviterName: ctx.user.name,
      role: invite.role,
      token: rawToken,
    }),
  });
}

/**
 * `POST /api/organisations/current/members`: invite a manager by email. Any earlier pending invite for
 * the same address is revoked so only the newest link works.
 */
export async function inviteMember(
  ctx: ManagerContext,
  input: InviteMemberInput,
): Promise<ManagerInvite> {
  assertCanGrant(ctx.membership.role, input.role);
  const organisationId = ctx.organisation.id;

  const existingMember = await prisma.organisationMembership.findFirst({
    where: { organisationId, user: { email: input.email } },
    select: { id: true },
  });
  if (existingMember)
    throw new AppError("CONFLICT", "This person is already a member of the organisation");

  const { raw, hash } = generateToken(32);
  const invite = await prisma.$transaction(async (tx) => {
    await tx.managerInvite.updateMany({
      where: { organisationId, email: input.email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const created = await tx.managerInvite.create({
      data: {
        organisationId,
        email: input.email,
        role: input.role,
        tokenHash: hash,
        invitedById: ctx.user.id,
        expiresAt: expiresIn(MANAGER_INVITE_TTL_MS),
      },
      include: { invitedBy: { select: { id: true, name: true } } },
    });
    await audit(
      ctx,
      {
        action: "member.invited",
        entityType: "ManagerInvite",
        entityId: created.id,
        after: { email: created.email, role: created.role, expiresAt: created.expiresAt },
      },
      tx,
    );
    return created;
  });
  await sendInviteEmail(ctx, invite, raw);
  return toManagerInviteDto(invite);
}

/**
 * `POST /api/organisations/current/members/invite` `{ inviteId }`: re-send a pending (or expired)
 * invite with a fresh token and a new 7-day expiry. The previous link stops working.
 */
export async function resendManagerInvite(
  ctx: ManagerContext,
  inviteId: string,
): Promise<ManagerInvite> {
  const existing = await findManagerInviteInOrganisation(ctx.organisation.id, inviteId);
  if (!existing) throw new AppError("NOT_FOUND", "Invite not found");
  const state = managerInviteState(existing);
  if (state === "ACCEPTED" || state === "REVOKED") {
    throw new AppError(
      "CONFLICT",
      `This invite has been ${state.toLowerCase()} and cannot be re-sent`,
    );
  }
  assertCanGrant(ctx.membership.role, existing.role);

  const { raw, hash } = generateToken(32);
  const invite = await prisma.$transaction(async (tx) => {
    const claimed = await tx.managerInvite.updateMany({
      where: {
        id: existing.id,
        organisationId: ctx.organisation.id,
        acceptedAt: null,
        revokedAt: null,
      },
      data: {
        tokenHash: hash,
        expiresAt: expiresIn(MANAGER_INVITE_TTL_MS),
        invitedById: ctx.user.id,
      },
    });
    if (claimed.count !== 1) throw new AppError("CONFLICT", "This invite can no longer be re-sent");
    await audit(
      ctx,
      { action: "member.invite_resent", entityType: "ManagerInvite", entityId: existing.id },
      tx,
    );
    return tx.managerInvite.findUniqueOrThrow({
      where: { id: existing.id },
      include: { invitedBy: { select: { id: true, name: true } } },
    });
  });
  await sendInviteEmail(ctx, invite, raw);
  return toManagerInviteDto(invite);
}

/** `DELETE /api/organisations/current/members/invites/:inviteId`: revoke a not-yet-accepted invite. */
export async function revokeManagerInvite(
  ctx: ManagerContext,
  inviteId: string,
): Promise<ManagerInvite> {
  const existing = await findManagerInviteInOrganisation(ctx.organisation.id, inviteId);
  if (!existing) throw new AppError("NOT_FOUND", "Invite not found");
  if (existing.acceptedAt) throw new AppError("CONFLICT", "This invite has already been accepted");
  assertCanGrant(ctx.membership.role, existing.role);
  if (existing.revokedAt) return toManagerInviteDto(existing);

  const invite = await prisma.$transaction(async (tx) => {
    const updated = await tx.managerInvite.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
      include: { invitedBy: { select: { id: true, name: true } } },
    });
    await audit(
      ctx,
      {
        action: "member.invite_revoked",
        entityType: "ManagerInvite",
        entityId: existing.id,
        before: { email: existing.email, role: existing.role },
      },
      tx,
    );
    return updated;
  });
  return toManagerInviteDto(invite);
}

// ── Role changes / removal ──────────────────────────────────────────────────

/** `PATCH /api/organisations/current/members/:membershipId` `{ role }`. */
export async function changeMemberRole(
  ctx: ManagerContext,
  membershipId: string,
  role: Role,
): Promise<Member> {
  const organisationId = ctx.organisation.id;
  const target = await findMembershipInOrganisation(organisationId, membershipId);
  if (!target) throw new AppError("NOT_FOUND", "Member not found");
  if (target.role === role) return toMemberDto(target, ctx.user.id);

  assertCanManage(ctx.membership.role, target.role);
  assertCanGrant(ctx.membership.role, role);

  const updated = await prisma.$transaction(async (tx) => {
    const owners = await lockOwnerMemberships(tx, organisationId);
    const current = await tx.organisationMembership.findFirst({
      where: { id: membershipId, organisationId },
    });
    if (!current) throw new AppError("NOT_FOUND", "Member not found");
    if (
      current.role === "OWNER" &&
      role !== "OWNER" &&
      owners.filter((id) => id !== current.id).length === 0
    ) {
      throw new AppError("LAST_OWNER", "An organisation must keep at least one owner");
    }
    const after = await tx.organisationMembership.update({
      where: { id: current.id },
      data: { role },
      include: { user: { select: memberUserSelect } },
    });
    await audit(
      ctx,
      {
        action: "member.role_changed",
        entityType: "OrganisationMembership",
        entityId: current.id,
        before: { userId: current.userId, role: current.role },
        after: { userId: current.userId, role },
      },
      tx,
    );
    return after;
  });
  return toMemberDto(updated, ctx.user.id);
}

/**
 * `DELETE /api/organisations/current/members/:membershipId`. Removing yourself ("leave") needs no
 * permission; removing others needs `members:invite` and a role at least as high as theirs.
 */
export async function removeMember(
  ctx: ManagerContext,
  membershipId: string,
): Promise<{ removedSelf: boolean }> {
  const organisationId = ctx.organisation.id;
  const target = await findMembershipInOrganisation(organisationId, membershipId);
  if (!target) throw new AppError("NOT_FOUND", "Member not found");
  const removedSelf = target.userId === ctx.user.id;
  if (!removedSelf) {
    if (!ctx.permissions.has("members:invite")) {
      throw new AppError("FORBIDDEN", "Missing permission: members:invite", {
        details: { permission: "members:invite" },
      });
    }
    assertCanManage(ctx.membership.role, target.role);
  }

  await prisma.$transaction(async (tx) => {
    const owners = await lockOwnerMemberships(tx, organisationId);
    const current = await tx.organisationMembership.findFirst({
      where: { id: membershipId, organisationId },
    });
    if (!current) throw new AppError("NOT_FOUND", "Member not found");
    if (current.role === "OWNER" && owners.filter((id) => id !== current.id).length === 0) {
      throw new AppError("LAST_OWNER", "An organisation must keep at least one owner");
    }
    await tx.organisationMembership.delete({ where: { id: current.id } });
    await audit(
      ctx,
      {
        action: removedSelf ? "member.left" : "member.removed",
        entityType: "OrganisationMembership",
        entityId: current.id,
        before: { userId: current.userId, role: current.role },
      },
      tx,
    );
  });
  return { removedSelf };
}

// ── Public invite lookup / accept ───────────────────────────────────────────

async function findInviteByToken(rawToken: string) {
  const invite = await prisma.managerInvite.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { organisation: true, invitedBy: { select: { id: true, name: true } } },
  });
  if (!invite || invite.organisation.deletedAt) return null;
  return invite;
}

/** `GET /api/invites/manager/:token`: what the invitee sees before accepting. Unknown token → 404. */
export async function previewManagerInvite(
  rawToken: string,
): Promise<ManagerInvitePreviewResponse> {
  const invite = await findInviteByToken(rawToken);
  if (!invite)
    throw new AppError("INVITE_INVALID", "This invitation link is not valid", { status: 404 });
  const existingUser = await prisma.user.findUnique({
    where: { email: invite.email },
    select: { id: true },
  });
  return {
    organisation: { name: invite.organisation.name },
    email: invite.email,
    role: invite.role,
    invitedByName: invite.invitedBy?.name ?? null,
    expiresAt: invite.expiresAt.toISOString(),
    status: managerInviteState(invite),
    requiresAccount: !existingUser,
  };
}

export interface AcceptManagerInviteParams {
  token: string;
  name?: string | undefined;
  password?: string | undefined;
}

export interface AcceptedManagerInvite {
  body: AcceptManagerInviteResponse & { csrfToken: string };
  cookies: string[];
}

/**
 * `POST /api/organisations/current/members/accept` (public). Signs the invitee in and selects the
 * organisation.
 * - New address: `name` + `password` are required; the account is created already verified (the
 *   emailed invite proved control of the address).
 * - Existing account: the caller must be signed in as that account or supply its password.
 */
export async function acceptManagerInvite(
  input: AcceptManagerInviteParams,
  meta: RequestMeta,
  sessionToken: string | undefined,
): Promise<AcceptedManagerInvite> {
  const invite = await findInviteByToken(input.token);
  if (!invite) throw new AppError("INVITE_INVALID", "This invitation link is not valid");
  const state = managerInviteState(invite);
  if (state === "ACCEPTED")
    throw new AppError("INVITE_INVALID", "This invitation has already been accepted");
  if (state === "REVOKED")
    throw new AppError("INVITE_INVALID", "This invitation has been withdrawn");
  if (state === "EXPIRED")
    throw new AppError("INVITE_EXPIRED", "This invitation has expired; ask for a new one");

  const existingUser = await prisma.user.findUnique({ where: { email: invite.email } });
  if (existingUser?.deletedAt)
    throw new AppError("INVITE_INVALID", "This invitation link is not valid");

  let user: User;
  let createdAccount = false;

  if (existingUser) {
    const session = sessionToken ? await resolveSession(sessionToken) : null;
    const signedInAsInvitee = session?.user.id === existingUser.id;
    if (!signedInAsInvitee) {
      if (!input.password) {
        throw new AppError(
          "UNAUTHENTICATED",
          "Sign in to the invited account to accept this invitation",
          {
            details: { requiresLogin: true, email: invite.email },
          },
        );
      }
      if (!(await verifyPassword(existingUser.passwordHash, input.password))) {
        throw new AppError("INVALID_CREDENTIALS", "Email or password is incorrect");
      }
    }
    user = await prisma.$transaction(async (tx) => {
      await claimInvite(tx, invite.id);
      await tx.organisationMembership.upsert({
        where: {
          userId_organisationId: { userId: existingUser.id, organisationId: invite.organisationId },
        },
        create: {
          userId: existingUser.id,
          organisationId: invite.organisationId,
          role: invite.role,
        },
        update: {},
      });
      return tx.user.update({
        where: { id: existingUser.id },
        data: {
          lastLoginAt: new Date(),
          ...(existingUser.emailVerifiedAt ? {} : { emailVerifiedAt: new Date() }),
        },
      });
    });
  } else {
    const fieldErrors: Record<string, string[]> = {};
    if (!input.name) fieldErrors.name = ["Name is required to create your account"];
    if (!input.password) fieldErrors.password = ["Password is required to create your account"];
    if (!input.name || !input.password) {
      throw new AppError("VALIDATION_ERROR", "Name and password are required", {
        details: { source: "body", formErrors: [], fieldErrors },
      });
    }
    const name = input.name;
    const passwordHash = await hashPassword(input.password);
    try {
      user = await prisma.$transaction(async (tx) => {
        await claimInvite(tx, invite.id);
        const created = await tx.user.create({
          data: {
            email: invite.email,
            name,
            passwordHash,
            emailVerifiedAt: new Date(),
            lastLoginAt: new Date(),
          },
        });
        await tx.organisationMembership.create({
          data: { userId: created.id, organisationId: invite.organisationId, role: invite.role },
        });
        return created;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new AppError(
          "EMAIL_ALREADY_REGISTERED",
          "An account with this email already exists; sign in to accept",
        );
      }
      throw err;
    }
    createdAccount = true;
  }

  const membership = await prisma.organisationMembership.findUniqueOrThrow({
    where: { userId_organisationId: { userId: user.id, organisationId: invite.organisationId } },
  });
  await audit(
    { organisation: { id: invite.organisationId }, user, ip: meta.ip, userAgent: meta.userAgent },
    {
      action: "member.joined",
      entityType: "OrganisationMembership",
      entityId: membership.id,
      after: { userId: user.id, role: membership.role, inviteId: invite.id, createdAccount },
    },
  );

  if (sessionToken) await revokeSessionByToken(sessionToken);
  const signedIn = await signIn(user, meta, { organisationId: invite.organisationId });
  logger.info(
    {
      requestId: meta.requestId,
      organisationId: invite.organisationId,
      userId: user.id,
      createdAccount,
    },
    "manager invite accepted",
  );
  return {
    body: {
      organisation: { id: invite.organisation.id, name: invite.organisation.name },
      role: membership.role,
      createdAccount,
      csrfToken: signedIn.csrfToken,
    },
    cookies: signedIn.cookies,
  };
}

/** Mark the invite accepted exactly once (compare-and-set), or fail with `INVITE_INVALID`. */
async function claimInvite(tx: Prisma.TransactionClient, inviteId: string): Promise<void> {
  const claimed = await tx.managerInvite.updateMany({
    where: { id: inviteId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    data: { acceptedAt: new Date() },
  });
  if (claimed.count !== 1)
    throw new AppError("INVITE_INVALID", "This invitation is no longer valid");
}
