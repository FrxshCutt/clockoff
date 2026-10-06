import { prisma, type Prisma } from "@workmode/db";
import type { Role } from "@workmode/shared/enums";
import { AppError } from "@workmode/shared/errors";
import {
  MANAGER_NOTIFICATION_TYPES,
  mergeNotificationPreferences,
  type ListNotificationsResponse,
  type ManagerNotificationType,
  type MarkAllNotificationsReadResponse,
  type Notification,
  type NotificationQuery,
} from "@workmode/validation/notifications";
import { toJsonValue } from "@/server/audit/audit";
import { publishEvent } from "@/server/events";
import type { ManagerContext } from "@/server/tenancy/context";
import { decodeKeysetCursor, encodeKeysetCursor } from "./cursor";
import {
  countUnreadForUser,
  createNotifications,
  findMembershipsForUsers,
  findNotificationForUser,
  findNotificationsForUser,
  findOrganisationMemberships,
  markAllReadForUser,
  markNotificationRead,
  type Db,
  type NotificationRow,
} from "./notifications.repository";

/**
 * In-app manager notifications (§5 notifications). Rows are created by server-side events (the jobs,
 * sync and import engineers call {@link createManagerNotification}); managers read their own feed, mark
 * items read and set per-type channel preferences on their membership (`PATCH /api/settings`).
 *
 * Preferences are honoured here: a manager who switched `inApp` off for a type gets no row of that type.
 * Email delivery is deliberately not done per notification — the compliance digest is the email channel —
 * so `email` preferences are read by the digest, not by this module.
 *
 * Marking notifications read is personal UI state, not an organisational change, so it is not written to
 * the audit log (which would otherwise fill with `notification.read` rows).
 */

export const NOTIFICATION_CREATED_EVENT = "notification.created" as const;

const KNOWN_TYPES: ReadonlySet<string> = new Set(MANAGER_NOTIFICATION_TYPES);

function isManagerNotificationType(type: string): type is ManagerNotificationType {
  return KNOWN_TYPES.has(type);
}

function hrefOf(metadata: Prisma.JsonValue): string | null {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const href = (metadata as Record<string, unknown>).href;
    if (typeof href === "string" && href.startsWith("/")) return href;
  }
  return null;
}

export function toNotificationDto(row: NotificationRow): Notification {
  const metadata =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    channel: row.channel,
    href: hrefOf(row.metadata),
    metadata,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** `GET /api/notifications?unreadOnly&cursor&limit` — newest first, plus the caller's unread count. */
export async function listNotifications(
  ctx: ManagerContext,
  query: NotificationQuery,
): Promise<ListNotificationsResponse> {
  const organisationId = ctx.organisation.id;
  const userId = ctx.user.id;
  const cursor = query.cursor ? decodeKeysetCursor(query.cursor) : null;
  const [rows, unreadCount] = await Promise.all([
    findNotificationsForUser(organisationId, userId, {
      unreadOnly: query.unreadOnly ?? false,
      cursor,
      take: query.limit + 1,
    }),
    countUnreadForUser(organisationId, userId),
  ]);
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toNotificationDto),
    nextCursor:
      rows.length > query.limit && last ? encodeKeysetCursor({ at: last.createdAt, id: last.id }) : null,
    unreadCount,
  };
}

/** `POST /api/notifications/:id/read` — only the recipient can mark their own notification (404 otherwise). */
export async function markNotificationAsRead(ctx: ManagerContext, id: string): Promise<Notification> {
  const existing = await findNotificationForUser(ctx.organisation.id, ctx.user.id, id);
  if (!existing) throw new AppError("NOT_FOUND", "Notification not found");
  if (existing.readAt) return toNotificationDto(existing);
  return toNotificationDto(await markNotificationRead(id, new Date()));
}

/** `POST /api/notifications/read-all` */
export async function markAllNotificationsAsRead(
  ctx: ManagerContext,
): Promise<MarkAllNotificationsReadResponse> {
  return { updated: await markAllReadForUser(ctx.organisation.id, ctx.user.id, new Date()) };
}

// ── Creating (for other services) ───────────────────────────────────────────

export interface CreateManagerNotificationInput {
  organisationId: string;
  /** One recipient (manager `User` id) … */
  userId?: string;
  /** … or several. Users who are not members of the organisation are skipped. */
  userIds?: readonly string[];
  /** One of MANAGER_NOTIFICATION_TYPES, or an additive kind such as `COMPLIANCE_DIGEST`. */
  type: string;
  title: string;
  body: string;
  /** Dashboard route to open (stored in `metadata.href`). */
  href?: string | null;
  /** Operational data only (ids, counts, states) — never content from a phone (§12). */
  metadata?: Record<string, unknown>;
}

export interface CreateManagerNotificationOptions {
  db?: Db;
  /** Publish `notification.created` on the realtime bus (default true). Pass false inside a transaction. */
  publish?: boolean;
  /** Skip recipients whose preferences turned `inApp` off for the type (default true; unknown types always go). */
  respectPreferences?: boolean;
}

function isDb(value: unknown): value is Db {
  return typeof value === "object" && value !== null && "notification" in value;
}

/** Publish the realtime hint for a stored row (after commit when the row was written in a transaction). */
export function publishNotificationCreated(row: NotificationRow): void {
  publishEvent({
    type: NOTIFICATION_CREATED_EVENT,
    organisationId: row.organisationId,
    payload: { notificationId: row.id, recipientId: row.recipientId, type: row.type },
  });
}

/**
 * Create in-app notifications (one row per recipient) and publish a `notification.created` realtime hint
 * for each. Recipients must be members of the organisation; a member who disabled `inApp` for a known
 * type receives nothing. The second argument may be a Prisma client / transaction (the seam other
 * engineers code against) or an options object.
 */
export async function createManagerNotification(
  input: CreateManagerNotificationInput,
  dbOrOptions: Db | CreateManagerNotificationOptions = prisma,
): Promise<NotificationRow[]> {
  const options: CreateManagerNotificationOptions = isDb(dbOrOptions) ? { db: dbOrOptions } : dbOrOptions;
  const db = options.db ?? prisma;
  const recipientIds = [...new Set([...(input.userIds ?? []), ...(input.userId ? [input.userId] : [])])];
  if (recipientIds.length === 0) return [];

  const memberships = await findMembershipsForUsers(input.organisationId, recipientIds, db);
  const rows = buildRows(input, memberships, options.respectPreferences ?? true);
  const created = await createNotifications(rows, db);
  if (options.publish ?? true) for (const row of created) publishNotificationCreated(row);
  return created;
}

export interface NotifyOrganisationManagersInput
  extends Omit<CreateManagerNotificationInput, "userId" | "userIds"> {
  /** Only managers with one of these roles (default: every member). */
  roles?: readonly Role[];
}

/** Notify every manager of the organisation (optionally only some roles). Same rules as above. */
export async function notifyOrganisationManagers(
  input: NotifyOrganisationManagersInput,
  dbOrOptions: Db | CreateManagerNotificationOptions = prisma,
): Promise<NotificationRow[]> {
  const options: CreateManagerNotificationOptions = isDb(dbOrOptions) ? { db: dbOrOptions } : dbOrOptions;
  const db = options.db ?? prisma;
  const memberships = await findOrganisationMemberships(input.organisationId, input.roles, db);
  const rows = buildRows(input, memberships, options.respectPreferences ?? true);
  const created = await createNotifications(rows, db);
  if (options.publish ?? true) for (const row of created) publishNotificationCreated(row);
  return created;
}

function buildRows(
  input: Omit<CreateManagerNotificationInput, "userId" | "userIds">,
  memberships: ReadonlyArray<{ userId: string; notificationPreferences: Prisma.JsonValue }>,
  respectPreferences: boolean,
): Prisma.NotificationCreateManyInput[] {
  const now = new Date();
  const metadata = (toJsonValue({ ...(input.metadata ?? {}), href: input.href ?? null }) ??
    {}) as Prisma.InputJsonValue;
  const rows: Prisma.NotificationCreateManyInput[] = [];
  for (const membership of memberships) {
    if (respectPreferences && isManagerNotificationType(input.type)) {
      const preferences = mergeNotificationPreferences(membership.notificationPreferences);
      if (!preferences[input.type].inApp) continue;
    }
    rows.push({
      organisationId: input.organisationId,
      recipientType: "MANAGER_USER",
      recipientId: membership.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      metadata,
      channel: "IN_APP",
      sentAt: now,
    });
  }
  return rows;
}
