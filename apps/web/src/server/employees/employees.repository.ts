import { Prisma, prisma } from "@workmode/db";
import type { NamedRef } from "@workmode/validation/refs";

/**
 * Employee-scoped queries. Every function takes `organisationId` explicitly (it always comes from the
 * caller's verified membership or device row, never from request input) and filters on it, so a row of
 * another tenant can never be returned by id.
 */

export type Db = Prisma.TransactionClient | typeof prisma;

export const employeeInclude = {
  department: { select: { id: true, name: true } },
  primaryLocation: { select: { id: true, name: true, timezone: true } },
  locations: {
    include: { location: { select: { id: true, name: true, deletedAt: true } } },
  },
  teams: { include: { team: { select: { id: true, name: true } } } },
  userLink: { select: { id: true, mobileUserId: true, linkedAt: true, unlinkedAt: true } },
} satisfies Prisma.EmployeeInclude;

export type EmployeeRow = Prisma.EmployeeGetPayload<{ include: typeof employeeInclude }>;

export const deviceInclude = {
  policyVersion: { select: { id: true, versionNumber: true } },
} satisfies Prisma.DeviceInclude;
export type DeviceRow = Prisma.DeviceGetPayload<{ include: typeof deviceInclude }>;

/** Shifts as the state machine consumes them (location + scheduled breaks for presentation). */
export const shiftInclude = {
  location: { select: { id: true, name: true } },
  scheduledBreaks: { orderBy: { offsetMinutesFromStart: "asc" } },
} satisfies Prisma.ShiftInclude;
export type ShiftRow = Prisma.ShiftGetPayload<{ include: typeof shiftInclude }>;

export const overrideInclude = {
  employee: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      jobTitle: true,
      inviteStatus: true,
      primaryLocation: { select: { id: true, name: true } },
    },
  },
  createdBy: { select: { id: true, name: true, email: true } },
} satisfies Prisma.ManagerOverrideInclude;
export type OverrideRow = Prisma.ManagerOverrideGetPayload<{ include: typeof overrideInclude }>;

export const policySelect = {
  id: true,
  name: true,
  status: true,
  deletedAt: true,
  organisationId: true,
  currentVersionId: true,
  currentVersion: {
    select: { id: true, versionNumber: true, restrictionConfig: true, publishedAt: true },
  },
} satisfies Prisma.PolicySelect;
export type PolicyRow = Prisma.PolicyGetPayload<{ select: typeof policySelect }>;

export const breakPolicySelect = {
  id: true,
  name: true,
  status: true,
  deletedAt: true,
  organisationId: true,
} satisfies Prisma.BreakPolicySelect;
export type BreakPolicyRow = Prisma.BreakPolicyGetPayload<{ select: typeof breakPolicySelect }>;

// ── Employees ───────────────────────────────────────────────────────────────

export async function findEmployeeInOrganisation(
  organisationId: string,
  employeeId: string,
  db: Db = prisma,
  options: { includeArchived?: boolean } = {},
): Promise<EmployeeRow | null> {
  return db.employee.findFirst({
    where: {
      id: employeeId,
      organisationId,
      ...(options.includeArchived ? {} : { deletedAt: null }),
    },
    include: employeeInclude,
  });
}

export async function findEmployeesInOrganisation(
  organisationId: string,
  employeeIds: readonly string[],
  db: Db = prisma,
): Promise<EmployeeRow[]> {
  if (employeeIds.length === 0) return [];
  return db.employee.findMany({
    where: { organisationId, id: { in: [...employeeIds] }, deletedAt: null },
    include: employeeInclude,
  });
}

/** Active, non-archived employees — the number plan limits count. */
export async function countActiveEmployees(organisationId: string, db: Db = prisma): Promise<number> {
  return db.employee.count({
    where: { organisationId, deletedAt: null, employmentStatus: "ACTIVE" },
  });
}

/**
 * `SELECT … FOR UPDATE` on one employee row inside a transaction, so concurrent joins / deactivations of
 * the same employee serialise. Returns false when the row does not exist in the organisation.
 */
export async function lockEmployeeRow(
  tx: Prisma.TransactionClient,
  organisationId: string,
  employeeId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM employees
    WHERE id = ${employeeId}::uuid AND organisation_id = ${organisationId}::uuid
    FOR UPDATE`;
  return rows.length === 1;
}

/**
 * Ids of ACTIVE, non-archived employees whose names match case-insensitively (uses the
 * `employees_org_lower_name_idx` functional index). Inputs must already be trimmed.
 */
export async function findEmployeeIdsByName(
  organisationId: string,
  firstName: string,
  lastName: string,
  db: Db = prisma,
): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM employees
    WHERE organisation_id = ${organisationId}::uuid
      AND lower(first_name) = lower(${firstName})
      AND lower(last_name) = lower(${lastName})
      AND deleted_at IS NULL
      AND employment_status = 'ACTIVE'`;
  return rows.map((r) => r.id);
}

/** What the mobile join flow needs to know about a candidate employee (never more — §12). */
export const joinCandidateSelect = {
  id: true,
  organisationId: true,
  firstName: true,
  lastName: true,
  jobTitle: true,
  employmentStatus: true,
  deletedAt: true,
  primaryLocation: { select: { id: true, name: true } },
  userLink: { select: { unlinkedAt: true } },
  devices: { where: { isActive: true }, select: { id: true } },
} satisfies Prisma.EmployeeSelect;
export type JoinCandidateRow = Prisma.EmployeeGetPayload<{ select: typeof joinCandidateSelect }>;

export async function findJoinCandidates(
  organisationId: string,
  employeeIds: readonly string[],
  db: Db = prisma,
): Promise<JoinCandidateRow[]> {
  if (employeeIds.length === 0) return [];
  return db.employee.findMany({
    where: { organisationId, id: { in: [...employeeIds] }, deletedAt: null },
    select: joinCandidateSelect,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

// ── Reference checks (all scoped to the organisation) ───────────────────────

export async function findLocationIdsInOrganisation(
  organisationId: string,
  ids: readonly string[],
  db: Db = prisma,
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.location.findMany({
    where: { organisationId, id: { in: [...ids] }, deletedAt: null },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

export async function findTeamIdsInOrganisation(
  organisationId: string,
  ids: readonly string[],
  db: Db = prisma,
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.team.findMany({
    where: { organisationId, id: { in: [...ids] } },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

export async function departmentExistsInOrganisation(
  organisationId: string,
  id: string,
  db: Db = prisma,
): Promise<boolean> {
  const row = await db.department.findFirst({ where: { organisationId, id }, select: { id: true } });
  return row !== null;
}

export async function findPolicyInOrganisation(
  organisationId: string,
  policyId: string,
  db: Db = prisma,
): Promise<PolicyRow | null> {
  return db.policy.findFirst({ where: { organisationId, id: policyId }, select: policySelect });
}

export async function findBreakPolicyInOrganisation(
  organisationId: string,
  breakPolicyId: string,
  db: Db = prisma,
): Promise<BreakPolicyRow | null> {
  return db.breakPolicy.findFirst({
    where: { organisationId, id: breakPolicyId },
    select: breakPolicySelect,
  });
}

// ── Devices, links, work states, invites ────────────────────────────────────

/** Every device of the given employees, active ones first, newest first. */
export async function findDevicesForEmployees(
  organisationId: string,
  employeeIds: readonly string[],
  db: Db = prisma,
): Promise<DeviceRow[]> {
  if (employeeIds.length === 0) return [];
  return db.device.findMany({
    where: { organisationId, employeeId: { in: [...employeeIds] } },
    include: deviceInclude,
    orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
  });
}

export async function findWorkStatesForEmployees(employeeIds: readonly string[], db: Db = prisma) {
  if (employeeIds.length === 0) return [];
  return db.employeeWorkState.findMany({ where: { employeeId: { in: [...employeeIds] } } });
}

/** PENDING / SENT invites that have not expired, grouped later by employee. */
export async function findLiveInvitesForEmployees(
  organisationId: string,
  employeeIds: readonly string[],
  now: Date,
  db: Db = prisma,
) {
  if (employeeIds.length === 0) return [];
  return db.employeeInvite.findMany({
    where: {
      organisationId,
      employeeId: { in: [...employeeIds] },
      status: { in: ["PENDING", "SENT"] },
      expiresAt: { gt: now },
    },
    select: { id: true, employeeId: true },
  });
}

export async function findLatestInviteForEmployee(
  organisationId: string,
  employeeId: string,
  db: Db = prisma,
) {
  return db.employeeInvite.findFirst({
    where: { organisationId, employeeId },
    orderBy: { createdAt: "desc" },
  });
}

// ── Schedule inputs for the state machine ───────────────────────────────────

export interface InstantWindow {
  from: Date;
  to: Date;
}

/** Non-deleted shifts overlapping `[window.from, window.to)` for the employees. */
export async function findShiftsForEmployees(
  organisationId: string,
  employeeIds: readonly string[],
  window: InstantWindow,
  db: Db = prisma,
): Promise<ShiftRow[]> {
  if (employeeIds.length === 0) return [];
  return db.shift.findMany({
    where: {
      organisationId,
      employeeId: { in: [...employeeIds] },
      deletedAt: null,
      endsAt: { gt: window.from },
      startsAt: { lt: window.to },
    },
    include: shiftInclude,
    orderBy: [{ startsAt: "asc" }, { endsAt: "asc" }],
  });
}

export interface NextShiftRow {
  id: string;
  employeeId: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  status: "SCHEDULED";
  locationId: string | null;
  locationName: string | null;
}

/**
 * The earliest SCHEDULED shift per employee that has not ended yet (the one in progress while on shift).
 * `DISTINCT ON` walks the `(organisation_id, employee_id, starts_at)` index once per employee.
 */
export async function findNextShiftsForEmployees(
  organisationId: string,
  employeeIds: readonly string[],
  now: Date,
  db: Db = prisma,
): Promise<NextShiftRow[]> {
  if (employeeIds.length === 0) return [];
  const ids = Prisma.join(employeeIds.map((id) => Prisma.sql`${id}::uuid`));
  return db.$queryRaw<NextShiftRow[]>`
    SELECT DISTINCT ON (s.employee_id)
      s.id,
      s.employee_id AS "employeeId",
      s.starts_at AS "startsAt",
      s.ends_at AS "endsAt",
      s.timezone,
      s.status::text AS status,
      s.location_id AS "locationId",
      l.name AS "locationName"
    FROM shifts s
    LEFT JOIN locations l ON l.id = s.location_id
    WHERE s.organisation_id = ${organisationId}::uuid
      AND s.employee_id IN (${ids})
      AND s.deleted_at IS NULL
      AND s.status = 'SCHEDULED'
      AND s.ends_at > ${now}::timestamptz
    ORDER BY s.employee_id, s.starts_at ASC, s.ends_at ASC, s.id ASC`;
}

export async function findBreakSessionsForShifts(
  organisationId: string,
  shiftIds: readonly string[],
  db: Db = prisma,
) {
  if (shiftIds.length === 0) return [];
  return db.breakSession.findMany({
    where: { organisationId, shiftId: { in: [...shiftIds] } },
    orderBy: { startedAt: "asc" },
  });
}

/**
 * Overrides that are, or will be inside `window`, in force for these employees: not revoked, not yet
 * expired at `window.from`, starting before `window.to`. Organisation-wide overrides (`employeeId` null)
 * are always included.
 */
export async function findOverridesForEmployees(
  organisationId: string,
  employeeIds: readonly string[],
  window: InstantWindow,
  db: Db = prisma,
): Promise<OverrideRow[]> {
  return db.managerOverride.findMany({
    where: {
      organisationId,
      revokedAt: null,
      expiresAt: { gt: window.from },
      startsAt: { lt: window.to },
      OR: [{ employeeId: null }, { employeeId: { in: [...employeeIds] } }],
    },
    include: overrideInclude,
    orderBy: { startsAt: "asc" },
  });
}

// ── Employee-level policy overrides ─────────────────────────────────────────

export interface EmployeeLevelAssignments {
  /** The Work Policy of the live EMPLOYEE-scope assignment (whatever its status), or null. */
  policy: NamedRef | null;
  /** The Break Policy of the live EMPLOYEE-scope assignment, or null. */
  breakPolicy: NamedRef | null;
}

function activeWindowAt(now: Date) {
  return {
    AND: [
      { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: now } }] },
      { OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
    ],
  };
}

/**
 * Live EMPLOYEE-scope Work / Break Policy assignments for a set of employees (the `policyOverride` /
 * `breakPolicyOverride` fields). Resolution itself is the policies service's job; this only reports which
 * override a manager set. Newest assignment wins per employee.
 */
export async function findEmployeeLevelAssignments(
  organisationId: string,
  employeeIds: readonly string[],
  now: Date,
  db: Db = prisma,
): Promise<Map<string, EmployeeLevelAssignments>> {
  const result = new Map<string, EmployeeLevelAssignments>();
  if (employeeIds.length === 0) return result;
  const where = {
    organisationId,
    scopeType: "EMPLOYEE" as const,
    scopeId: { in: [...employeeIds] },
    ...activeWindowAt(now),
  };
  const [policyRows, breakRows] = await Promise.all([
    db.policyAssignment.findMany({
      where,
      select: { scopeId: true, policy: { select: { id: true, name: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
    db.breakPolicyAssignment.findMany({
      where,
      select: { scopeId: true, breakPolicy: { select: { id: true, name: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
  ]);
  const entry = (employeeId: string): EmployeeLevelAssignments => {
    let current = result.get(employeeId);
    if (!current) {
      current = { policy: null, breakPolicy: null };
      result.set(employeeId, current);
    }
    return current;
  };
  for (const row of policyRows) {
    const e = entry(row.scopeId);
    if (e.policy === null) e.policy = { id: row.policy.id, name: row.policy.name };
  }
  for (const row of breakRows) {
    const e = entry(row.scopeId);
    if (e.breakPolicy === null) e.breakPolicy = { id: row.breakPolicy.id, name: row.breakPolicy.name };
  }
  return result;
}

/** End every live EMPLOYEE-scope Work Policy assignment for the employee at `now`. */
export async function endEmployeePolicyAssignments(
  tx: Prisma.TransactionClient,
  organisationId: string,
  employeeId: string,
  now: Date,
): Promise<number> {
  const result = await tx.policyAssignment.updateMany({
    where: {
      organisationId,
      scopeType: "EMPLOYEE",
      scopeId: employeeId,
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    data: { effectiveTo: now },
  });
  return result.count;
}

export async function endEmployeeBreakPolicyAssignments(
  tx: Prisma.TransactionClient,
  organisationId: string,
  employeeId: string,
  now: Date,
): Promise<number> {
  const result = await tx.breakPolicyAssignment.updateMany({
    where: {
      organisationId,
      scopeType: "EMPLOYEE",
      scopeId: employeeId,
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    data: { effectiveTo: now },
  });
  return result.count;
}

// ── Activity ────────────────────────────────────────────────────────────────

export async function findUsersByIds(ids: readonly string[], db: Db = prisma) {
  if (ids.length === 0) return [];
  return db.user.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, name: true, email: true },
  });
}
