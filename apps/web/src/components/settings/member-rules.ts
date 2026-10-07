import { ROLES, type Role } from "@clockoff/shared/enums";
import { hasPermission, outranksOrEquals } from "@clockoff/shared/permissions";

/**
 * UI mirror of the server's manager-membership rules (apps/web/src/server/organisations/members.ts) so the
 * dashboard only offers actions that can succeed. The API remains the authority and enforces the same rules.
 *
 * - Managing members needs `members:invite`.
 * - Nobody grants a role above their own; only an OWNER grants OWNER or changes/removes an OWNER.
 * - Your own membership is changed from the Danger zone (leave), not the members table.
 */

/** Roles `actorRole` may grant, highest first. Empty when the actor cannot invite at all. */
export function assignableRoles(actorRole: Role | null): Role[] {
  if (!actorRole || !hasPermission(actorRole, "members:invite")) return [];
  return ROLES.filter((role) =>
    role === "OWNER" ? actorRole === "OWNER" : outranksOrEquals(actorRole, role),
  );
}

export function canInviteMembers(actorRole: Role | null): boolean {
  return assignableRoles(actorRole).length > 0;
}

/** Whether `actorRole` may change the role of / remove `target`. */
export function canManageMember(
  actorRole: Role | null,
  target: { role: Role; isCurrentUser: boolean | null },
): boolean {
  if (!actorRole || target.isCurrentUser) return false;
  if (!hasPermission(actorRole, "members:invite")) return false;
  if (target.role === "OWNER" && actorRole !== "OWNER") return false;
  return outranksOrEquals(actorRole, target.role);
}

/** Display order for the members table: owners first, then admins, then managers. */
export function compareRoles(a: Role, b: Role): number {
  return ROLES.indexOf(a) - ROLES.indexOf(b);
}
