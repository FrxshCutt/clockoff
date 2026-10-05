import type { Role } from "./enums";

/**
 * Permission keys (§4). Roles map to sets of permissions so new roles can be added without touching
 * handlers; handlers only ever call `requirePermission(ctx, "employees:write")`.
 */
export const PERMISSIONS = [
  "employees:read",
  "employees:write",
  "policies:read",
  "policies:write",
  "schedule:read",
  "schedule:write",
  "imports:write",
  "integrations:write",
  "overrides:create",
  "billing:manage",
  "org:manage",
  "org:delete",
  "members:invite",
  "audit:read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL: readonly Permission[] = PERMISSIONS;

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  OWNER: new Set(ALL),
  // ADMIN: everything except billing and deleting the organisation.
  ADMIN: new Set(ALL.filter((p) => p !== "billing:manage" && p !== "org:delete")),
  // MANAGER: read everything; write employees / schedule / imports / overrides.
  MANAGER: new Set<Permission>([
    "employees:read",
    "employees:write",
    "policies:read",
    "schedule:read",
    "schedule:write",
    "imports:write",
    "overrides:create",
  ]),
};

export function permissionsForRole(role: Role): ReadonlySet<Permission> {
  return ROLE_PERMISSIONS[role];
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

/** Roles ordered by privilege, used for "cannot change the role of someone above you" checks. */
export const ROLE_RANK: Record<Role, number> = { OWNER: 3, ADMIN: 2, MANAGER: 1 };

export function outranksOrEquals(a: Role, b: Role): boolean {
  return ROLE_RANK[a] >= ROLE_RANK[b];
}
