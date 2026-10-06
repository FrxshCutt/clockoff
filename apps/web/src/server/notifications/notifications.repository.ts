import { prisma, type Notification, type Prisma, type Role } from "@workmode/db";
import { beforeCursorWhere, type KeysetCursor } from "./cursor";

/**
 * Manager notification rows: `recipientType = MANAGER_USER`, `recipientId` = the manager's user id,
 * always inside one organisation (a manager of two organisations has two separate feeds).
 */

export type Db = Prisma.TransactionClient | typeof prisma;
export type NotificationRow = Notification;

function recipientWhere(organisationId: string, userId: string): Prisma.NotificationWhereInput {
  return { organisationId, recipientType: "MANAGER_USER", recipientId: userId };
}

export interface NotificationPageOptions {
  unreadOnly: boolean;
  cursor: KeysetCursor | null;
  /** Rows to fetch (callers ask for one more than the page size to detect a next page). */
  take: number;
}

export async function findNotificationsForUser(
  organisationId: string,
  userId: string,
  options: NotificationPageOptions,
  db: Db = prisma,
): Promise<NotificationRow[]> {
  return db.notification.findMany({
    where: {
      ...recipientWhere(organisationId, userId),
      ...(options.unreadOnly ? { readAt: null } : {}),
      ...(options.cursor ? beforeCursorWhere("createdAt", options.cursor) : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: options.take,
  });
}

export async function countUnreadForUser(
  organisationId: string,
  userId: string,
  db: Db = prisma,
): Promise<number> {
  return db.notification.count({
    where: { ...recipientWhere(organisationId, userId), readAt: null },
  });
}

export async function findNotificationForUser(
  organisationId: string,
  userId: string,
  notificationId: string,
  db: Db = prisma,
): Promise<NotificationRow | null> {
  return db.notification.findFirst({
    where: { id: notificationId, ...recipientWhere(organisationId, userId) },
  });
}

/**
 * Set `readAt` once (a second call leaves the original timestamp). The write is scoped to the recipient
 * like every other query here, so a guessed id can never flip another manager's row. Returns the fresh row.
 */
export async function markNotificationRead(
  organisationId: string,
  userId: string,
  notificationId: string,
  now: Date,
  db: Db = prisma,
): Promise<NotificationRow> {
  const where = { id: notificationId, ...recipientWhere(organisationId, userId) };
  await db.notification.updateMany({ where: { ...where, readAt: null }, data: { readAt: now } });
  return db.notification.findFirstOrThrow({ where });
}

export async function markAllReadForUser(
  organisationId: string,
  userId: string,
  now: Date,
  db: Db = prisma,
): Promise<number> {
  const result = await db.notification.updateMany({
    where: { ...recipientWhere(organisationId, userId), readAt: null },
    data: { readAt: now },
  });
  return result.count;
}

export interface RecipientMembership {
  userId: string;
  notificationPreferences: Prisma.JsonValue;
}

/** Memberships of `userIds` in the organisation (users who are not members are silently absent). */
export async function findMembershipsForUsers(
  organisationId: string,
  userIds: readonly string[],
  db: Db = prisma,
): Promise<RecipientMembership[]> {
  if (userIds.length === 0) return [];
  return db.organisationMembership.findMany({
    where: { organisationId, userId: { in: [...userIds] } },
    select: { userId: true, notificationPreferences: true },
  });
}

/** Every membership of the organisation, optionally restricted to some roles. */
export async function findOrganisationMemberships(
  organisationId: string,
  roles: readonly Role[] | undefined,
  db: Db = prisma,
): Promise<RecipientMembership[]> {
  return db.organisationMembership.findMany({
    where: { organisationId, ...(roles && roles.length > 0 ? { role: { in: [...roles] } } : {}) },
    select: { userId: true, notificationPreferences: true },
  });
}

export async function createNotifications(
  data: Prisma.NotificationCreateManyInput[],
  db: Db = prisma,
): Promise<NotificationRow[]> {
  if (data.length === 0) return [];
  return db.notification.createManyAndReturn({ data });
}
