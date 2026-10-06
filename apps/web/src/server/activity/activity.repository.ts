import { prisma, type Prisma } from "@workmode/db";
import type { ActivityEventType } from "@workmode/shared/enums";

/** Organisation-scoped activity-feed reads. `organisationId` always comes from the verified context. */

type Db = Prisma.TransactionClient | typeof prisma;

export const activityEmployeeSelect = {
  id: true,
  firstName: true,
  lastName: true,
  jobTitle: true,
  inviteStatus: true,
  primaryLocation: { select: { id: true, name: true } },
} satisfies Prisma.EmployeeSelect;

export const activityEventInclude = {
  employee: { select: activityEmployeeSelect },
} satisfies Prisma.ActivityEventInclude;
export type ActivityEventRow = Prisma.ActivityEventGetPayload<{ include: typeof activityEventInclude }>;

export interface ActivityFeedFilter {
  employeeId?: string;
  types?: readonly ActivityEventType[];
  from?: Date;
  to?: Date;
  /** Events of employees whose primary location is this one. */
  locationId?: string;
  /** Exclusive keyset cursor: rows strictly older than (occurredAt, id). */
  after?: { occurredAt: Date; id: string };
}

/** Newest first (`occurredAt` desc, `id` desc), `limit` rows. */
export async function findActivityEvents(
  organisationId: string,
  filter: ActivityFeedFilter,
  limit: number,
  db: Db = prisma,
): Promise<ActivityEventRow[]> {
  const and: Prisma.ActivityEventWhereInput[] = [];
  if (filter.employeeId) and.push({ employeeId: filter.employeeId });
  if (filter.types && filter.types.length > 0) and.push({ type: { in: [...filter.types] } });
  if (filter.from) and.push({ occurredAt: { gte: filter.from } });
  if (filter.to) and.push({ occurredAt: { lte: filter.to } });
  if (filter.locationId) and.push({ employee: { primaryLocationId: filter.locationId } });
  if (filter.after) {
    and.push({
      OR: [
        { occurredAt: { lt: filter.after.occurredAt } },
        { occurredAt: filter.after.occurredAt, id: { lt: filter.after.id } },
      ],
    });
  }
  return db.activityEvent.findMany({
    where: { organisationId, ...(and.length > 0 ? { AND: and } : {}) },
    include: activityEventInclude,
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: limit,
  });
}

export async function findActorUsers(userIds: readonly string[], db: Db = prisma) {
  if (userIds.length === 0) return [];
  return db.user.findMany({
    where: { id: { in: [...userIds] } },
    select: { id: true, name: true, email: true },
  });
}
