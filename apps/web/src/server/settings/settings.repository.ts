import { prisma, type Prisma } from "@workmode/db";

/** Membership preference rows and plan-usage counts, scoped by the verified organisation id. */

export type Db = Prisma.TransactionClient | typeof prisma;

export async function findMembershipInOrganisation(
  organisationId: string,
  membershipId: string,
  db: Db = prisma,
) {
  return db.organisationMembership.findFirst({ where: { id: membershipId, organisationId } });
}

export async function updateMembershipPreferences(
  membershipId: string,
  notificationPreferences: Prisma.InputJsonValue,
  db: Db = prisma,
) {
  return db.organisationMembership.update({
    where: { id: membershipId },
    data: { notificationPreferences },
  });
}

export interface BillingUsage {
  /** Active, non-archived employees — what plan limits count. */
  employees: number;
  /** Live (not soft-deleted) locations. */
  locations: number;
  /** CONNECTED workforce integrations. */
  integrations: number;
}

export async function countBillingUsage(
  organisationId: string,
  db: Db = prisma,
): Promise<BillingUsage> {
  const [employees, locations, integrations] = await Promise.all([
    db.employee.count({ where: { organisationId, deletedAt: null, employmentStatus: "ACTIVE" } }),
    db.location.count({ where: { organisationId, deletedAt: null } }),
    db.integration.count({ where: { organisationId, status: "CONNECTED" } }),
  ]);
  return { employees, locations, integrations };
}
