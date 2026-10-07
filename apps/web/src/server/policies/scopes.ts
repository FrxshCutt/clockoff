import { prisma, type Prisma } from "@clockoff/db";
import type { AssignmentScopeType } from "@clockoff/shared/enums";
import { AppError } from "@clockoff/shared/errors";

/**
 * Assignment scopes shared by Work Policy and Break Policy assignments (§6.1): validating that a scope
 * target belongs to the organisation, naming it for the dashboard and listing the employees it covers
 * (for "affected employees" on realtime events). Every function takes the organisation id explicitly.
 */

type Db = Prisma.TransactionClient | typeof prisma;

export interface ScopeRef {
  scopeType: AssignmentScopeType;
  scopeId: string;
}

export function scopeKey(scope: ScopeRef): string {
  return `${scope.scopeType}:${scope.scopeId}`;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled scope type: ${String(value)}`);
}

/**
 * The scope target must exist inside the organisation: ORGANISATION → the organisation itself, LOCATION /
 * TEAM / EMPLOYEE → a (not soft-deleted) row of this organisation. Anything else, including another
 * tenant's id, is `NOT_FOUND` (never 403, so ids cannot be probed across tenants).
 */
export async function assertScopeTargetExists(
  organisationId: string,
  scope: ScopeRef,
  db: Db = prisma,
): Promise<void> {
  const notFound = () =>
    new AppError("NOT_FOUND", `${scopeLabel(scope.scopeType)} not found`, {
      details: { scopeType: scope.scopeType, scopeId: scope.scopeId },
    });
  switch (scope.scopeType) {
    case "ORGANISATION":
      if (scope.scopeId !== organisationId) throw notFound();
      return;
    case "LOCATION": {
      const row = await db.location.findFirst({
        where: { id: scope.scopeId, organisationId, deletedAt: null },
        select: { id: true },
      });
      if (!row) throw notFound();
      return;
    }
    case "TEAM": {
      const row = await db.team.findFirst({
        where: { id: scope.scopeId, organisationId },
        select: { id: true },
      });
      if (!row) throw notFound();
      return;
    }
    case "EMPLOYEE": {
      const row = await db.employee.findFirst({
        where: { id: scope.scopeId, organisationId, deletedAt: null },
        select: { id: true },
      });
      if (!row) throw notFound();
      return;
    }
    default:
      return assertNever(scope.scopeType);
  }
}

function scopeLabel(scopeType: AssignmentScopeType): string {
  switch (scopeType) {
    case "ORGANISATION":
      return "Organisation";
    case "LOCATION":
      return "Location";
    case "TEAM":
      return "Team";
    case "EMPLOYEE":
      return "Employee";
    default:
      return assertNever(scopeType);
  }
}

/**
 * Display names for scope targets, keyed by `scopeKey`. ORGANISATION scopes map to the organisation
 * name; targets that no longer exist are simply absent (the DTO shows `scope: null`).
 */
export async function loadScopeNames(
  organisationId: string,
  scopes: readonly ScopeRef[],
  db: Db = prisma,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const ids = (type: AssignmentScopeType) => [
    ...new Set(scopes.filter((s) => s.scopeType === type).map((s) => s.scopeId)),
  ];
  const locationIds = ids("LOCATION");
  const teamIds = ids("TEAM");
  const employeeIds = ids("EMPLOYEE");
  const wantsOrganisation = scopes.some((s) => s.scopeType === "ORGANISATION");

  const [locations, teams, employees, organisation] = await Promise.all([
    locationIds.length
      ? db.location.findMany({
          where: { id: { in: locationIds }, organisationId },
          select: { id: true, name: true },
        })
      : [],
    teamIds.length
      ? db.team.findMany({
          where: { id: { in: teamIds }, organisationId },
          select: { id: true, name: true },
        })
      : [],
    employeeIds.length
      ? db.employee.findMany({
          where: { id: { in: employeeIds }, organisationId },
          select: { id: true, firstName: true, lastName: true },
        })
      : [],
    wantsOrganisation
      ? db.organisation.findUnique({ where: { id: organisationId }, select: { name: true } })
      : null,
  ]);

  for (const l of locations) names.set(scopeKey({ scopeType: "LOCATION", scopeId: l.id }), l.name);
  for (const t of teams) names.set(scopeKey({ scopeType: "TEAM", scopeId: t.id }), t.name);
  for (const e of employees) {
    names.set(
      scopeKey({ scopeType: "EMPLOYEE", scopeId: e.id }),
      `${e.firstName} ${e.lastName}`.trim(),
    );
  }
  if (organisation) {
    names.set(scopeKey({ scopeType: "ORGANISATION", scopeId: organisationId }), organisation.name);
  }
  return names;
}

/** Ids of the organisation's active (not deleted, employment ACTIVE) employees. */
export async function activeEmployeeIds(
  organisationId: string,
  db: Db = prisma,
): Promise<string[]> {
  const rows = await db.employee.findMany({
    where: { organisationId, deletedAt: null, employmentStatus: "ACTIVE" },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * Active employees a scope covers — the (super)set of people whose resolved policy an assignment change
 * for that scope can affect. ORGANISATION approximates to every active employee.
 */
export async function employeeIdsInScope(
  organisationId: string,
  scope: ScopeRef,
  db: Db = prisma,
): Promise<string[]> {
  const base = { organisationId, deletedAt: null, employmentStatus: "ACTIVE" as const };
  switch (scope.scopeType) {
    case "ORGANISATION":
      return activeEmployeeIds(organisationId, db);
    case "LOCATION": {
      const rows = await db.employee.findMany({
        where: { ...base, primaryLocationId: scope.scopeId },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    }
    case "TEAM": {
      const rows = await db.employee.findMany({
        where: { ...base, teams: { some: { teamId: scope.scopeId } } },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    }
    case "EMPLOYEE": {
      const row = await db.employee.findFirst({
        where: { ...base, id: scope.scopeId },
        select: { id: true },
      });
      return row ? [row.id] : [];
    }
    default:
      return assertNever(scope.scopeType);
  }
}

/** `effectiveFrom <= now < effectiveTo` with null bounds open (same rule as the shared resolver). */
export function isWindowActive(
  window: { effectiveFrom: Date | null; effectiveTo: Date | null },
  now: Date,
): boolean {
  const t = now.getTime();
  if (window.effectiveFrom && window.effectiveFrom.getTime() > t) return false;
  if (window.effectiveTo && window.effectiveTo.getTime() <= t) return false;
  return true;
}

export interface AssignmentWindow {
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  /** The instant from which the new assignment is in force: `effectiveFrom ?? now`. */
  replaceAt: Date;
}

/**
 * The effective window of a new assignment. The schema already guarantees `effectiveTo > effectiveFrom`;
 * `effectiveTo` must also lie in the future, because an assignment that has already ended can never apply
 * — accepting it would end the scope's current assignment and leave nothing in its place.
 */
export function parseAssignmentWindow(
  input: { effectiveFrom?: string; effectiveTo?: string },
  now: Date,
): AssignmentWindow {
  const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : null;
  const effectiveTo = input.effectiveTo ? new Date(input.effectiveTo) : null;
  if (effectiveTo && effectiveTo.getTime() <= now.getTime()) {
    throw new AppError("VALIDATION_ERROR", "Invalid body", {
      details: {
        source: "body",
        formErrors: [],
        fieldErrors: { effectiveTo: ["effectiveTo must be in the future"] },
      },
    });
  }
  return { effectiveFrom, effectiveTo, replaceAt: effectiveFrom ?? now };
}

/** Serialise a validated object for a Prisma `Json` column (drops `undefined` members). */
export function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
