import { prisma } from "@clockoff/db";
import type { DeviceStatusBadge } from "@clockoff/shared/enums";
import { buildAppLink, sendEmailSafely } from "@/server/email";
import {
  createManagerNotification,
  publishNotificationCreated,
} from "@/server/workState/externalServices";

/**
 * Manager compliance digest (§10). Sent by the Work Mode job at most once per organisation per hour when
 * at least one employee with a shift today is NEEDS_ATTENTION or PERMISSIONS_MISSING:
 *   - an in-app notification (type `COMPLIANCE_DIGEST`) for every OWNER / ADMIN member;
 *   - an email through the configured EmailProvider for the members whose
 *     `notificationPreferences.digestEmail` is not `false`.
 * The hourly guard is the latest COMPLIANCE_DIGEST notification row of the organisation, read and written
 * under a per-organisation advisory lock so two concurrent ticks never send twice.
 */

export const DIGEST_NOTIFICATION_TYPE = "COMPLIANCE_DIGEST";
export const DIGEST_MIN_INTERVAL_MS = 60 * 60 * 1000;
/** Badges that put an employee in the digest. */
export const DIGEST_BADGES: ReadonlySet<DeviceStatusBadge> = new Set<DeviceStatusBadge>([
  "NEEDS_ATTENTION",
  "PERMISSIONS_MISSING",
]);

export interface DigestAttentionEmployee {
  employeeId: string;
  firstName: string;
  lastName: string;
  badge: DeviceStatusBadge;
  reason: string | null;
}

export interface DigestResult {
  sent: boolean;
  /** Why nothing was sent (when `sent` is false). */
  skipped?: "NO_EMPLOYEES" | "RECENTLY_SENT" | "NO_RECIPIENTS";
  notifications: number;
  emails: number;
}

/** `notificationPreferences.digestEmail !== false` (unset = opted in). */
export function digestEmailEnabled(preferences: unknown): boolean {
  if (typeof preferences !== "object" || preferences === null || Array.isArray(preferences))
    return true;
  return (preferences as Record<string, unknown>).digestEmail !== false;
}

function badgeLabel(badge: DeviceStatusBadge): string {
  switch (badge) {
    case "PERMISSIONS_MISSING":
      return "Permissions missing";
    case "NEEDS_ATTENTION":
      return "Needs attention";
    default:
      return badge.toLowerCase().replace(/_/g, " ");
  }
}

export function digestTitle(count: number): string {
  return count === 1
    ? "1 employee needs attention for today's shifts"
    : `${count} employees need attention for today's shifts`;
}

export function digestLines(employees: readonly DigestAttentionEmployee[]): string[] {
  return employees.map((e) => {
    const name = `${e.firstName} ${e.lastName}`.trim();
    const detail = e.reason ? `${badgeLabel(e.badge)}: ${e.reason}` : badgeLabel(e.badge);
    return `- ${name} — ${detail}`;
  });
}

export function digestEmailText(input: {
  recipientName: string;
  organisationName: string;
  employees: readonly DigestAttentionEmployee[];
}): string {
  const link = buildAppLink("/overview", {});
  return [
    `Hi ${input.recipientName},`,
    "",
    `${digestTitle(input.employees.length)} at ${input.organisationName}:`,
    "",
    ...digestLines(input.employees),
    "",
    "Work Mode cannot be enforced on these phones until the issue is fixed. Open the dashboard to see details:",
    link,
    "",
    "You receive this digest at most once an hour. Turn it off under Settings → Notifications (digest email).",
  ].join("\n");
}

export async function sendOrganisationDigest(params: {
  organisationId: string;
  now: Date;
  employees: readonly DigestAttentionEmployee[];
}): Promise<DigestResult> {
  const { organisationId, now } = params;
  const employees = [...params.employees].sort((a, b) =>
    `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`),
  );
  if (employees.length === 0)
    return { sent: false, skipped: "NO_EMPLOYEES", notifications: 0, emails: 0 };

  const outcome = await prisma.$transaction(async (tx) => {
    // Serialise per organisation so concurrent ticks cannot both pass the "recently sent" check. The lock
    // function returns `void`, which `$queryRaw` cannot deserialise — `$executeRaw` discards the result.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`workmode:digest:${organisationId}`}))`;
    const recent = await tx.notification.findFirst({
      where: {
        organisationId,
        type: DIGEST_NOTIFICATION_TYPE,
        createdAt: { gt: new Date(now.getTime() - DIGEST_MIN_INTERVAL_MS) },
      },
      select: { id: true },
    });
    if (recent) return { skipped: "RECENTLY_SENT" as const };

    const [organisation, members] = await Promise.all([
      tx.organisation.findUniqueOrThrow({ where: { id: organisationId }, select: { name: true } }),
      tx.organisationMembership.findMany({
        where: { organisationId, role: { in: ["OWNER", "ADMIN"] }, user: { deletedAt: null } },
        include: { user: { select: { id: true, name: true, email: true } } },
      }),
    ]);
    if (members.length === 0) return { skipped: "NO_RECIPIENTS" as const };

    const counts = { needsAttention: 0, permissionsMissing: 0 };
    for (const e of employees) {
      if (e.badge === "PERMISSIONS_MISSING") counts.permissionsMissing += 1;
      else counts.needsAttention += 1;
    }
    const notifications = await createManagerNotification(
      {
        organisationId,
        userIds: members.map((m) => m.userId),
        type: DIGEST_NOTIFICATION_TYPE,
        title: digestTitle(employees.length),
        body: digestLines(employees).join("\n"),
        href: "/overview",
        metadata: {
          employeeIds: employees.map((e) => e.employeeId),
          counts,
          generatedAt: now.toISOString(),
        },
      },
      { db: tx, publish: false },
    );
    return { organisationName: organisation.name, members, notifications };
  });

  if ("skipped" in outcome)
    return { sent: false, skipped: outcome.skipped, notifications: 0, emails: 0 };
  // Realtime hints only after the commit, so subscribers never see rolled-back rows.
  for (const row of outcome.notifications) publishNotificationCreated(row);

  let emails = 0;
  for (const member of outcome.members) {
    if (!digestEmailEnabled(member.notificationPreferences)) continue;
    const ok = await sendEmailSafely({
      to: member.user.email,
      subject: `[ClockOff] ${digestTitle(employees.length)}`,
      text: digestEmailText({
        recipientName: member.user.name,
        organisationName: outcome.organisationName,
        employees,
      }),
    });
    if (ok) emails += 1;
  }
  return { sent: true, notifications: outcome.notifications.length, emails };
}
