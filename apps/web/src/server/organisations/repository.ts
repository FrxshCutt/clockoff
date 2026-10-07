import { prisma, type Prisma } from "@clockoff/db";

/**
 * Organisation-scoped queries. Every function takes the `organisationId` explicitly (it always comes
 * from the caller's verified membership, never from request input).
 */

type Db = Prisma.TransactionClient | typeof prisma;

export interface OnboardingSignals {
  activePolicies: number;
  activeBreakPolicies: number;
  employees: number;
  shifts: number;
  employeeInvites: number;
  activeDevices: number;
}

/** Counts behind the onboarding checklist, computed from real data (never trusted flags). */
export async function countOnboardingSignals(
  organisationId: string,
  db: Db = prisma,
): Promise<OnboardingSignals> {
  const [activePolicies, activeBreakPolicies, employees, shifts, employeeInvites, activeDevices] =
    await Promise.all([
      db.policy.count({ where: { organisationId, deletedAt: null, status: "ACTIVE" } }),
      db.breakPolicy.count({ where: { organisationId, deletedAt: null, status: "ACTIVE" } }),
      db.employee.count({ where: { organisationId, deletedAt: null } }),
      db.shift.count({ where: { organisationId, deletedAt: null, status: { not: "CANCELLED" } } }),
      db.employeeInvite.count({ where: { organisationId, status: { not: "REVOKED" } } }),
      db.device.count({ where: { organisationId, isActive: true } }),
    ]);
  return { activePolicies, activeBreakPolicies, employees, shifts, employeeInvites, activeDevices };
}

/**
 * Lock the organisation's OWNER memberships (`SELECT … FOR UPDATE`) inside a transaction and return
 * their ids. Concurrent demotions/removals of owners serialise on these rows, so the "last owner"
 * check cannot be raced.
 */
export async function lockOwnerMemberships(
  tx: Prisma.TransactionClient,
  organisationId: string,
): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM organisation_memberships
    WHERE organisation_id = ${organisationId}::uuid AND role = 'OWNER'
    FOR UPDATE`;
  return rows.map((r) => r.id);
}

export async function findMembershipInOrganisation(
  organisationId: string,
  membershipId: string,
  db: Db = prisma,
) {
  return db.organisationMembership.findFirst({
    where: { id: membershipId, organisationId },
    include: {
      user: {
        select: { id: true, name: true, email: true, emailVerifiedAt: true, lastLoginAt: true },
      },
    },
  });
}

export async function findManagerInviteInOrganisation(
  organisationId: string,
  inviteId: string,
  db: Db = prisma,
) {
  return db.managerInvite.findFirst({
    where: { id: inviteId, organisationId },
    include: { invitedBy: { select: { id: true, name: true } } },
  });
}
