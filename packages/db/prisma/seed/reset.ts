import type { Prisma } from "@prisma/client";

export interface ResetTarget {
  organisationIds: readonly string[];
  slugs: readonly string[];
  userIds: readonly string[];
  userEmails: readonly string[];
}

export interface ResetResult {
  organisations: number;
  users: number;
  mobileUsers: number;
}

/**
 * Deletes the demo organisations (cascades to every tenant-owned row), the mobile identities attached to
 * their employees (MobileUser has no organisation and would otherwise be orphaned) and the demo manager
 * accounts (cascades memberships, sessions and tokens). Matches by stable id AND by slug / email so a seed
 * written by an older version of this script is removed too. Idempotent: nothing to delete → counts of 0.
 */
export async function resetDemoData(
  tx: Prisma.TransactionClient,
  target: ResetTarget,
): Promise<ResetResult> {
  const organisations = await tx.organisation.findMany({
    where: {
      OR: [{ id: { in: [...target.organisationIds] } }, { slug: { in: [...target.slugs] } }],
    },
    select: { id: true },
  });
  const organisationIds = organisations.map((o) => o.id);

  let mobileUsers = 0;
  if (organisationIds.length > 0) {
    const [devices, links] = await Promise.all([
      tx.device.findMany({
        where: { organisationId: { in: organisationIds } },
        select: { mobileUserId: true },
      }),
      tx.employeeUserLink.findMany({
        where: { employee: { organisationId: { in: organisationIds } } },
        select: { mobileUserId: true },
      }),
    ]);
    const mobileUserIds = [...new Set([...devices, ...links].map((r) => r.mobileUserId))];
    if (mobileUserIds.length > 0) {
      mobileUsers = (await tx.mobileUser.deleteMany({ where: { id: { in: mobileUserIds } } }))
        .count;
    }
  }

  const deletedOrganisations =
    organisationIds.length > 0
      ? (await tx.organisation.deleteMany({ where: { id: { in: organisationIds } } })).count
      : 0;

  const users = (
    await tx.user.deleteMany({
      where: {
        OR: [{ id: { in: [...target.userIds] } }, { email: { in: [...target.userEmails] } }],
      },
    })
  ).count;

  return { organisations: deletedOrganisations, users, mobileUsers };
}
