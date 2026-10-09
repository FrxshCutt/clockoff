import {
  Prisma,
  prisma,
  type ActivityEvent as ActivityEventRow,
  type Organisation as OrganisationRow,
} from "@clockoff/db";
import { computeBreakAllowance } from "@clockoff/shared/breaks/breakRules";
import type { InviteStatus } from "@clockoff/shared/enums";
import { AppError, isAppError, type ApiErrorCode } from "@clockoff/shared/errors";
import { PLAN_CONFIG, isWithinLimit, planLimitsFor } from "@clockoff/shared/plans";
import { toExpectedStateJson } from "@clockoff/shared/workMode/workModeMachine";
import type { EmployeeActivityQuery, ListActivityResponse } from "@clockoff/validation/activity";
import type {
  AssignEmployeeBreakPolicyInput,
  AssignEmployeeLocationInput,
  AssignEmployeePolicyInput,
  AssignEmployeeTeamInput,
  BulkEmployeeActionInput,
  BulkEmployeeActionResponse,
  CreateEmployeeInput,
  DeactivateEmployeeInput,
  Employee,
  EmployeeDetail,
  EmployeeQuery,
  EmployeeStateQuery,
  EmployeeStateResponse,
  ListEmployeesResponse,
  UpdateEmployeeInput,
} from "@clockoff/validation/employees";
import { managedByFromIntegrationId } from "@clockoff/validation/integrations";
import type { EmployeeShiftsQuery, ListShiftsResponse } from "@clockoff/validation/shifts";
import { errorSummary, logger } from "@/lib/logger";
import { publishActivity } from "@/server/activity/recordActivity";
import { audit } from "@/server/audit/audit";
import { createEmployeeInvite } from "@/server/employeeInvites/employeeInvites.service";
import { publishEvent } from "@/server/events";
import { publishBreakPolicyChanged, publishPolicyChanged } from "@/server/policies";
import { RATE_LIMITS, enforceRateLimit } from "@/server/rateLimit";
import { listShiftsForEmployee } from "@/server/shifts";
import type { ManagerContext } from "@/server/tenancy/context";
import { revokeEmployeeAccess } from "./employeeAccess";
import { assertManagedEmployeeEdit } from "./employees.integration";
import {
  employeeLocations,
  toActivityEventDto,
  toBreakSessionDto,
  toDeviceStatusDto,
  toDeviceSummary,
  toEmployeeInviteDto,
  toEmployeeSummary,
  toNamedRef,
  toOverrideDto,
  toShiftSummary,
  toShiftSummaryFromNext,
  toWorkStateDto,
} from "./employees.mappers";
import {
  assertAssignableBreakPolicy,
  assertAssignablePolicy,
  resolvePoliciesForEmployees,
  type ResolvedEmployeePolicies,
} from "./employees.policies";
import {
  countActiveEmployees,
  departmentExistsInOrganisation,
  employeeInclude,
  endEmployeeBreakPolicyAssignments,
  endEmployeePolicyAssignments,
  findEmployeeInOrganisation,
  findLatestInviteForEmployee,
  findLocationIdsInOrganisation,
  findTeamIdsInOrganisation,
  findUsersByIds,
  type Db,
  type EmployeeRow,
} from "./employees.repository";
import {
  computeEmployeeStatus,
  getEmployeeStatusContext,
  type EmployeeStatusContext,
} from "./employees.status";
import { recomputeEmployeeInviteStatus } from "./inviteStatus";

export { getEmployeeStatusContext, computeEmployeeStatus } from "./employees.status";
export {
  recomputeEmployeeInviteStatus,
  recomputeEmployeeInviteStatusDetailed,
} from "./inviteStatus";

/**
 * Employees (§5 employees, §9 lifecycle). Every function receives the verified `ManagerContext` and
 * scopes by `ctx.organisation.id`; a row of another tenant reads as EMPLOYEE_NOT_FOUND (404). Every
 * mutation is audited. Device badges and resolved policies are computed per page in a fixed number of
 * queries (`getEmployeeStatusContext`, `resolvePoliciesForEmployees`).
 *
 * An employee an integration manages (`managedByIntegrationId`) keeps its synced fields locked: changing the
 * name, email (while the integration imports emails), external ID or primary location answers
 * INTEGRATION_MANAGED (`employees.integration.ts`, plan §6.5 "Locked fields"). Policies, break policies, team
 * overrides and every other ClockOff-only field stay editable, and deactivating or archiving stays available.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Upper bound on rows loaded when a derived filter / sort forces in-memory evaluation. */
const MAX_IN_MEMORY_ROWS = 5000;
const STATE_TIMELINE_DEFAULT_MS = DAY_MS;
const STATE_TIMELINE_MAX_EVENTS = 500;
const STATE_SHIFT_LOOKAHEAD_MS = 14 * DAY_MS;

type OrganisationPolicyRef = Pick<OrganisationRow, "id" | "name" | "timezone" | "plan">;

// ── DTO assembly ────────────────────────────────────────────────────────────

function toEmployeeDto(
  row: EmployeeRow,
  context: EmployeeStatusContext | undefined,
  policies: ResolvedEmployeePolicies | undefined,
  now: Date,
): Employee {
  const computed = context ? computeEmployeeStatus(context, now) : null;
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
    externalEmployeeId: row.externalEmployeeId,
    jobTitle: row.jobTitle,
    department: row.department ? toNamedRef(row.department) : null,
    primaryLocation: row.primaryLocation ? toNamedRef(row.primaryLocation) : null,
    locations: employeeLocations(row),
    teams: row.teams.map((t) => toNamedRef(t.team)),
    employmentStatus: row.employmentStatus,
    // Derived live (an invite that expired since the last recompute reads NOT_INVITED, not INVITED).
    inviteStatus: computed?.inviteStatus ?? row.inviteStatus,
    deviceStatus: computed ? toDeviceStatusDto(computed.status, computed.since) : null,
    policyOverride: policies?.policyOverride ?? null,
    breakPolicyOverride: policies?.breakPolicyOverride ?? null,
    resolvedPolicy: policies?.resolvedPolicy ?? null,
    resolvedBreakPolicy: policies?.resolvedBreakPolicy ?? null,
    nextShift: context?.nextShift ? toShiftSummaryFromNext(context.nextShift) : null,
    lastSyncAt: context?.device?.lastDeviceSyncAt?.toISOString() ?? null,
    source: row.source,
    managedBy: managedByFromIntegrationId(row.managedByIntegrationId),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface EmployeePageData {
  contexts: Map<string, EmployeeStatusContext>;
  policies: Map<string, ResolvedEmployeePolicies>;
}

async function loadPageData(
  organisation: OrganisationPolicyRef,
  rows: readonly EmployeeRow[],
  now: Date,
): Promise<EmployeePageData> {
  const [contexts, policies] = await Promise.all([
    getEmployeeStatusContext(
      organisation.id,
      rows.map((r) => r.id),
      { now, employees: rows, organisationTimezone: organisation.timezone },
    ),
    resolvePoliciesForEmployees(
      organisation.id,
      rows.map((r) => r.id),
      now,
    ),
  ]);
  return { contexts, policies };
}

async function buildEmployeeDtos(
  organisation: OrganisationPolicyRef,
  rows: readonly EmployeeRow[],
  now: Date = new Date(),
): Promise<Employee[]> {
  if (rows.length === 0) return [];
  const data = await loadPageData(organisation, rows, now);
  return rows.map((row) =>
    toEmployeeDto(row, data.contexts.get(row.id), data.policies.get(row.id), now),
  );
}

async function reloadEmployeeDto(
  ctx: ManagerContext,
  employeeId: string,
  options: { includeArchived?: boolean } = {},
): Promise<Employee> {
  const row = await findEmployeeInOrganisation(ctx.organisation.id, employeeId, prisma, options);
  if (!row) throw new AppError("EMPLOYEE_NOT_FOUND", "Employee not found");
  const [dto] = await buildEmployeeDtos(ctx.organisation, [row]);
  return dto!;
}

async function requireEmployee(ctx: ManagerContext, employeeId: string): Promise<EmployeeRow> {
  const row = await findEmployeeInOrganisation(ctx.organisation.id, employeeId);
  if (!row) throw new AppError("EMPLOYEE_NOT_FOUND", "Employee not found");
  return row;
}

// ── Validation helpers ──────────────────────────────────────────────────────

interface ReferenceInput {
  departmentId?: string | null;
  primaryLocationId?: string | null;
  locationIds?: readonly string[];
  teamIds?: readonly string[];
}

/** Every referenced department / location / team must belong to the organisation (field-level errors). */
async function assertReferences(organisationId: string, refs: ReferenceInput): Promise<void> {
  const fieldErrors: Record<string, string[]> = {};
  const locationIds = new Set<string>(refs.locationIds ?? []);
  if (refs.primaryLocationId) locationIds.add(refs.primaryLocationId);
  const [knownLocations, knownTeams, departmentOk] = await Promise.all([
    findLocationIdsInOrganisation(organisationId, [...locationIds]),
    findTeamIdsInOrganisation(organisationId, refs.teamIds ?? []),
    refs.departmentId ? departmentExistsInOrganisation(organisationId, refs.departmentId) : true,
  ]);
  if (!departmentOk) fieldErrors.departmentId = ["Unknown department"];
  if (refs.primaryLocationId && !knownLocations.has(refs.primaryLocationId)) {
    fieldErrors.primaryLocationId = ["Unknown location"];
  }
  if (refs.locationIds?.some((id) => !knownLocations.has(id))) {
    fieldErrors.locationIds = ["One or more locations are unknown"];
  }
  if (refs.teamIds?.some((id) => !knownTeams.has(id))) {
    fieldErrors.teamIds = ["One or more teams are unknown"];
  }
  if (Object.keys(fieldErrors).length > 0) {
    throw new AppError("VALIDATION_ERROR", "Some references are not valid", {
      details: { source: "body", formErrors: [], fieldErrors },
    });
  }
}

/**
 * Plan limit on ACTIVE employees (create / reactivate, and the integration importer: `adding` new employees at
 * once, counted in `db`). `CONFLICT` with `{ plan, limit, current }`.
 */
export async function assertEmployeeCapacity(
  organisation: Pick<OrganisationRow, "id" | "plan">,
  options: { adding?: number; db?: Db } = {},
): Promise<void> {
  const current = await countActiveEmployees(organisation.id, options.db);
  if (isWithinLimit(organisation.plan, "employees", current + (options.adding ?? 1))) return;
  const limit = planLimitsFor(organisation.plan).employees;
  throw new AppError(
    "CONFLICT",
    `Your ${PLAN_CONFIG[organisation.plan].name} plan includes up to ${String(limit)} active employees. Upgrade your plan or deactivate an employee to add another.`,
    {
      details: {
        reason: "PLAN_LIMIT",
        metric: "employees",
        plan: organisation.plan,
        limit,
        current,
      },
    },
  );
}

function isExternalIdConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") return false;
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  const text = Array.isArray(target) ? target.join(",") : String(target ?? "");
  return text.includes("external_employee_id") || text.includes("externalEmployeeId");
}

function externalIdConflict(): AppError {
  return new AppError("CONFLICT", "An employee with this external ID already exists", {
    details: {
      source: "body",
      formErrors: [],
      fieldErrors: { externalEmployeeId: ["Already used by another employee"] },
    },
  });
}

function auditSnapshot(row: EmployeeRow) {
  return {
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
    externalEmployeeId: row.externalEmployeeId,
    jobTitle: row.jobTitle,
    departmentId: row.departmentId,
    primaryLocationId: row.primaryLocationId,
    locationIds: row.locations.map((l) => l.locationId),
    teamIds: row.teams.map((t) => t.teamId),
    employmentStatus: row.employmentStatus,
    inviteStatus: row.inviteStatus,
  };
}

function uniqueIds(...lists: Array<readonly string[] | undefined>): string[] {
  return [...new Set(lists.flatMap((l) => l ?? []))];
}

// ── List ────────────────────────────────────────────────────────────────────

type SortField = EmployeeQuery["sort"] extends infer S ? (S extends `-${infer F}` ? F : S) : never;

function parseSort(sort: EmployeeQuery["sort"]): { field: SortField; direction: "asc" | "desc" } {
  return sort.startsWith("-")
    ? { field: sort.slice(1) as SortField, direction: "desc" }
    : { field: sort as SortField, direction: "asc" };
}

function orderByFor(
  field: SortField,
  direction: "asc" | "desc",
): Prisma.EmployeeOrderByWithRelationInput[] {
  const tieBreak: Prisma.EmployeeOrderByWithRelationInput[] = [
    { lastName: "asc" },
    { firstName: "asc" },
    { id: "asc" },
  ];
  switch (field) {
    case "lastName":
      return [{ lastName: direction }, { firstName: direction }, { id: "asc" }];
    case "firstName":
      return [{ firstName: direction }, { lastName: direction }, { id: "asc" }];
    case "createdAt":
      return [{ createdAt: direction }, { id: "asc" }];
    case "inviteStatus":
      return [{ inviteStatus: direction }, ...tieBreak];
    case "lastSyncAt":
      // Derived from the device; sorted in memory.
      return tieBreak;
    default: {
      const exhaustive: never = field;
      throw new Error(`Unknown sort field ${String(exhaustive)}`);
    }
  }
}

/**
 * `inviteStatus` filter. The stored column is a cache refreshed by `recomputeEmployeeInviteStatus`, so an
 * invite that expired since then still reads INVITED there. To agree with the DTO (derived live), INVITED
 * additionally demands a live invite and NOT_INVITED also admits INVITED rows whose invites all expired.
 */
function inviteStatusWhere(
  statuses: readonly InviteStatus[],
  now: Date,
): Prisma.EmployeeWhereInput {
  const liveInvite: Prisma.EmployeeInviteWhereInput = {
    status: { in: ["PENDING", "SENT"] },
    expiresAt: { gt: now },
  };
  const or: Prisma.EmployeeWhereInput[] = [];
  const plain = statuses.filter((s) => s !== "INVITED" && s !== "NOT_INVITED");
  if (plain.length > 0) or.push({ inviteStatus: { in: plain } });
  if (statuses.includes("INVITED")) {
    or.push({ inviteStatus: "INVITED", invites: { some: liveInvite } });
  }
  if (statuses.includes("NOT_INVITED")) {
    or.push(
      { inviteStatus: "NOT_INVITED" },
      { inviteStatus: "INVITED", invites: { none: liveInvite } },
    );
  }
  return { OR: or };
}

function whereFor(
  organisationId: string,
  query: EmployeeQuery,
  now: Date,
): Prisma.EmployeeWhereInput {
  const and: Prisma.EmployeeWhereInput[] = [];
  if (query.search) {
    const contains = { contains: query.search, mode: "insensitive" as const };
    and.push({
      OR: [
        { firstName: contains },
        { lastName: contains },
        { email: contains },
        { externalEmployeeId: contains },
        { jobTitle: contains },
      ],
    });
  }
  if (query.inviteStatus && query.inviteStatus.length > 0) {
    and.push(inviteStatusWhere(query.inviteStatus, now));
  }
  if (query.employmentStatus && query.employmentStatus.length > 0) {
    and.push({ employmentStatus: { in: query.employmentStatus } });
  }
  if (query.locationId) {
    and.push({
      OR: [
        { primaryLocationId: query.locationId },
        { locations: { some: { locationId: query.locationId } } },
      ],
    });
  }
  if (query.departmentId) and.push({ departmentId: query.departmentId });
  if (query.teamId) and.push({ teams: { some: { teamId: query.teamId } } });
  return { organisationId, deletedAt: null, ...(and.length > 0 ? { AND: and } : {}) };
}

/** `GET /api/employees` (`employees:read`). Archived employees are never listed. */
export async function listEmployees(
  ctx: ManagerContext,
  query: EmployeeQuery,
): Promise<ListEmployeesResponse> {
  const organisation = ctx.organisation;
  const now = new Date();
  const where = whereFor(organisation.id, query, now);
  const { field, direction } = parseSort(query.sort);
  const orderBy = orderByFor(field, direction);
  const deviceStatusFilter =
    query.deviceStatus && query.deviceStatus.length > 0 ? new Set(query.deviceStatus) : null;
  const needsInMemory =
    deviceStatusFilter !== null || query.policyId !== undefined || field === "lastSyncAt";

  if (!needsInMemory) {
    const [total, rows] = await Promise.all([
      prisma.employee.count({ where }),
      prisma.employee.findMany({
        where,
        include: employeeInclude,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    const items = await buildEmployeeDtos(organisation, rows, now);
    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  // Derived filters / sorts (device badge, resolved policy, last sync) are evaluated after derivation.
  const rows = await prisma.employee.findMany({
    where,
    include: employeeInclude,
    orderBy,
    take: MAX_IN_MEMORY_ROWS,
  });
  let items = await buildEmployeeDtos(organisation, rows, now);
  if (deviceStatusFilter) {
    items = items.filter(
      (e) => e.deviceStatus !== null && deviceStatusFilter.has(e.deviceStatus.badge),
    );
  }
  if (query.policyId !== undefined) {
    items = items.filter((e) => e.resolvedPolicy?.id === query.policyId);
  }
  if (field === "lastSyncAt") {
    const sign = direction === "asc" ? 1 : -1;
    items = [...items].sort((a, b) => {
      // Nulls (never synced) last in both directions.
      if (a.lastSyncAt === null && b.lastSyncAt === null) return 0;
      if (a.lastSyncAt === null) return 1;
      if (b.lastSyncAt === null) return -1;
      return sign * (Date.parse(a.lastSyncAt) - Date.parse(b.lastSyncAt));
    });
  }
  const total = items.length;
  const start = (query.page - 1) * query.pageSize;
  return {
    items: items.slice(start, start + query.pageSize),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

// ── Read ────────────────────────────────────────────────────────────────────

/** `GET /api/employees/:id` (`employees:read`). */
export async function getEmployee(
  ctx: ManagerContext,
  employeeId: string,
): Promise<EmployeeDetail> {
  const row = await requireEmployee(ctx, employeeId);
  const now = new Date();
  const [data, latestInvite] = await Promise.all([
    loadPageData(ctx.organisation, [row], now),
    findLatestInviteForEmployee(ctx.organisation.id, employeeId),
  ]);
  const context = data.contexts.get(row.id);
  const dto = toEmployeeDto(row, context, data.policies.get(row.id), now);
  return {
    ...dto,
    device: context?.device ? toDeviceSummary(context.device) : null,
    latestInvite: latestInvite ? toEmployeeInviteDto(latestInvite, now) : null,
    workState: context?.workState ? toWorkStateDto(context.workState) : null,
  };
}

// ── Create / update ─────────────────────────────────────────────────────────

/** `POST /api/employees` (`employees:write`). */
export async function createEmployee(
  ctx: ManagerContext,
  input: CreateEmployeeInput,
): Promise<Employee> {
  const organisationId = ctx.organisation.id;
  await assertEmployeeCapacity(ctx.organisation);
  await assertReferences(organisationId, input);
  if (input.policyId) await assertAssignablePolicy(organisationId, input.policyId);
  if (input.breakPolicyId) await assertAssignableBreakPolicy(organisationId, input.breakPolicyId);

  const locationIds = uniqueIds(
    input.primaryLocationId ? [input.primaryLocationId] : [],
    input.locationIds,
  );
  const teamIds = uniqueIds(input.teamIds);
  const now = new Date();
  let created: EmployeeRow;
  try {
    created = await prisma.$transaction(async (tx) => {
      const employee = await tx.employee.create({
        data: {
          organisationId,
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email ?? null,
          phone: input.phone ?? null,
          externalEmployeeId: input.externalEmployeeId ?? null,
          jobTitle: input.jobTitle ?? null,
          departmentId: input.departmentId ?? null,
          primaryLocationId: input.primaryLocationId ?? null,
          locations: { create: locationIds.map((locationId) => ({ locationId })) },
          teams: { create: teamIds.map((teamId) => ({ teamId })) },
        },
        include: employeeInclude,
      });
      if (input.policyId) {
        await tx.policyAssignment.create({
          data: {
            organisationId,
            policyId: input.policyId,
            scopeType: "EMPLOYEE",
            scopeId: employee.id,
            effectiveFrom: now,
            createdById: ctx.user.id,
          },
        });
      }
      if (input.breakPolicyId) {
        await tx.breakPolicyAssignment.create({
          data: {
            organisationId,
            breakPolicyId: input.breakPolicyId,
            scopeType: "EMPLOYEE",
            scopeId: employee.id,
            effectiveFrom: now,
            createdById: ctx.user.id,
          },
        });
      }
      await audit(
        ctx,
        {
          action: "employee.created",
          entityType: "Employee",
          entityId: employee.id,
          after: {
            ...auditSnapshot(employee),
            policyId: input.policyId ?? null,
            breakPolicyId: input.breakPolicyId ?? null,
          },
        },
        tx,
      );
      return employee;
    });
  } catch (err) {
    if (isExternalIdConflict(err)) throw externalIdConflict();
    throw err;
  }
  const [dto] = await buildEmployeeDtos(ctx.organisation, [created]);
  return dto!;
}

/** `PATCH /api/employees/:id` (`employees:write`). Omitted = unchanged, `null` = clear, arrays replace. */
export async function updateEmployee(
  ctx: ManagerContext,
  employeeId: string,
  input: UpdateEmployeeInput,
): Promise<Employee> {
  const organisationId = ctx.organisation.id;
  const before = await requireEmployee(ctx, employeeId);
  await assertManagedEmployeeEdit(prisma, organisationId, before, {
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    externalEmployeeId: input.externalEmployeeId,
    primaryLocationId: input.primaryLocationId,
  });
  await assertReferences(organisationId, {
    departmentId: input.departmentId,
    primaryLocationId: input.primaryLocationId,
    locationIds: input.locationIds,
    teamIds: input.teamIds,
  });
  if (input.policyId) await assertAssignablePolicy(organisationId, input.policyId);
  if (input.breakPolicyId) await assertAssignableBreakPolicy(organisationId, input.breakPolicyId);

  const now = new Date();
  const data: Prisma.EmployeeUncheckedUpdateInput = {};
  if (input.firstName !== undefined) data.firstName = input.firstName;
  if (input.lastName !== undefined) data.lastName = input.lastName;
  if (input.email !== undefined) data.email = input.email;
  if (input.phone !== undefined) data.phone = input.phone;
  if (input.externalEmployeeId !== undefined) data.externalEmployeeId = input.externalEmployeeId;
  if (input.jobTitle !== undefined) data.jobTitle = input.jobTitle;
  if (input.departmentId !== undefined) data.departmentId = input.departmentId;
  if (input.primaryLocationId !== undefined) data.primaryLocationId = input.primaryLocationId;

  const nextPrimary =
    input.primaryLocationId !== undefined ? input.primaryLocationId : before.primaryLocationId;

  try {
    await prisma.$transaction(async (tx) => {
      if (Object.keys(data).length > 0) {
        await tx.employee.update({ where: { id: employeeId }, data });
      }
      if (input.locationIds !== undefined) {
        const ids = uniqueIds(nextPrimary ? [nextPrimary] : [], input.locationIds);
        await tx.employeeLocation.deleteMany({ where: { employeeId } });
        if (ids.length > 0) {
          await tx.employeeLocation.createMany({
            data: ids.map((locationId) => ({ employeeId, locationId })),
          });
        }
      } else if (nextPrimary && nextPrimary !== before.primaryLocationId) {
        await tx.employeeLocation.upsert({
          where: { employeeId_locationId: { employeeId, locationId: nextPrimary } },
          create: { employeeId, locationId: nextPrimary },
          update: {},
        });
      }
      if (input.teamIds !== undefined) {
        const ids = uniqueIds(input.teamIds);
        await tx.employeeTeam.deleteMany({ where: { employeeId } });
        if (ids.length > 0) {
          await tx.employeeTeam.createMany({ data: ids.map((teamId) => ({ employeeId, teamId })) });
        }
      }
      if (input.policyId !== undefined) {
        await endEmployeePolicyAssignments(tx, organisationId, employeeId, now);
        if (input.policyId) {
          await tx.policyAssignment.create({
            data: {
              organisationId,
              policyId: input.policyId,
              scopeType: "EMPLOYEE",
              scopeId: employeeId,
              effectiveFrom: now,
              createdById: ctx.user.id,
            },
          });
        }
      }
      if (input.breakPolicyId !== undefined) {
        await endEmployeeBreakPolicyAssignments(tx, organisationId, employeeId, now);
        if (input.breakPolicyId) {
          await tx.breakPolicyAssignment.create({
            data: {
              organisationId,
              breakPolicyId: input.breakPolicyId,
              scopeType: "EMPLOYEE",
              scopeId: employeeId,
              effectiveFrom: now,
              createdById: ctx.user.id,
            },
          });
        }
      }
      const after = await tx.employee.findUniqueOrThrow({
        where: { id: employeeId },
        include: employeeInclude,
      });
      await audit(
        ctx,
        {
          action: "employee.updated",
          entityType: "Employee",
          entityId: employeeId,
          before: auditSnapshot(before),
          after: {
            ...auditSnapshot(after),
            ...(input.policyId !== undefined ? { policyId: input.policyId } : {}),
            ...(input.breakPolicyId !== undefined ? { breakPolicyId: input.breakPolicyId } : {}),
          },
        },
        tx,
      );
    });
  } catch (err) {
    if (isExternalIdConflict(err)) throw externalIdConflict();
    throw err;
  }
  return reloadEmployeeDto(ctx, employeeId);
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * `POST /api/employees/:id/deactivate`. Employment INACTIVE, lifecycle DEACTIVATED, phones cut off (devices
 * deactivated, tokens revoked, mobile identity unlinked, live invites revoked, running break ended).
 * Shifts are kept; inactive employees are simply excluded from state computation. Idempotent.
 */
export async function deactivateEmployee(
  ctx: ManagerContext,
  employeeId: string,
  input: DeactivateEmployeeInput = {},
): Promise<Employee> {
  const organisationId = ctx.organisation.id;
  const before = await requireEmployee(ctx, employeeId);
  if (before.employmentStatus === "INACTIVE") return reloadEmployeeDto(ctx, employeeId);

  const now = new Date();
  const access = await prisma.$transaction(async (tx) => {
    await tx.employee.update({
      where: { id: employeeId },
      data: { employmentStatus: "INACTIVE", inviteStatus: "DEACTIVATED" },
    });
    const result = await revokeEmployeeAccess(tx, {
      organisationId,
      employeeId,
      revokeInvites: true,
      actor: { type: "MANAGER", userId: ctx.user.id },
      breakEndReason: "MANAGER_ENDED",
      now,
    });
    await audit(
      ctx,
      {
        action: "employee.deactivated",
        entityType: "Employee",
        entityId: employeeId,
        before: { employmentStatus: before.employmentStatus, inviteStatus: before.inviteStatus },
        after: {
          employmentStatus: "INACTIVE",
          inviteStatus: "DEACTIVATED",
          reason: input.reason ?? null,
          deactivatedDevices: result.deactivatedDevices,
          revokedInvites: result.revokedInvites,
        },
      },
      tx,
    );
    return result;
  });
  for (const event of access.endedBreakEvents) publishActivity(event);
  publishEvent({
    type: "device.status.changed",
    organisationId,
    employeeId,
    payload: { employeeId, inviteStatus: "DEACTIVATED", employmentStatus: "INACTIVE" },
  });
  return reloadEmployeeDto(ctx, employeeId);
}

/** `POST /api/employees/:id/reactivate`. Subject to the plan limit; the employee must join again. */
export async function reactivateEmployee(
  ctx: ManagerContext,
  employeeId: string,
): Promise<Employee> {
  const before = await requireEmployee(ctx, employeeId);
  if (before.employmentStatus === "ACTIVE") return reloadEmployeeDto(ctx, employeeId);
  await assertEmployeeCapacity(ctx.organisation);

  const inviteStatus = await prisma.$transaction(async (tx) => {
    await tx.employee.update({ where: { id: employeeId }, data: { employmentStatus: "ACTIVE" } });
    const status = await recomputeEmployeeInviteStatus(employeeId, { db: tx, publish: false });
    await audit(
      ctx,
      {
        action: "employee.reactivated",
        entityType: "Employee",
        entityId: employeeId,
        before: { employmentStatus: before.employmentStatus, inviteStatus: before.inviteStatus },
        after: { employmentStatus: "ACTIVE", inviteStatus: status },
      },
      tx,
    );
    return status;
  });
  publishEvent({
    type: "device.status.changed",
    organisationId: ctx.organisation.id,
    employeeId,
    payload: { employeeId, inviteStatus, employmentStatus: "ACTIVE" },
  });
  return reloadEmployeeDto(ctx, employeeId);
}

/**
 * `POST /api/employees/:id/archive` and `DELETE /api/employees/:id`: soft delete. Deactivates (as above)
 * and sets `deletedAt`, so the employee disappears from every list. Shifts and history are kept.
 */
export async function archiveEmployee(ctx: ManagerContext, employeeId: string): Promise<Employee> {
  const organisationId = ctx.organisation.id;
  const before = await requireEmployee(ctx, employeeId);
  const now = new Date();
  const access = await prisma.$transaction(async (tx) => {
    await tx.employee.update({
      where: { id: employeeId },
      data: { deletedAt: now, employmentStatus: "INACTIVE", inviteStatus: "DEACTIVATED" },
    });
    const result = await revokeEmployeeAccess(tx, {
      organisationId,
      employeeId,
      revokeInvites: true,
      actor: { type: "MANAGER", userId: ctx.user.id },
      breakEndReason: "MANAGER_ENDED",
      now,
    });
    await audit(
      ctx,
      {
        action: "employee.archived",
        entityType: "Employee",
        entityId: employeeId,
        before: auditSnapshot(before),
        after: { deletedAt: now, deactivatedDevices: result.deactivatedDevices },
      },
      tx,
    );
    return result;
  });
  for (const event of access.endedBreakEvents) publishActivity(event);
  publishEvent({
    type: "device.status.changed",
    organisationId,
    employeeId,
    payload: {
      employeeId,
      inviteStatus: "DEACTIVATED",
      employmentStatus: "INACTIVE",
      archived: true,
    },
  });
  return reloadEmployeeDto(ctx, employeeId, { includeArchived: true });
}

/** `DELETE /api/employees/:id` — the archive action with a 204 response. */
export async function deleteEmployee(ctx: ManagerContext, employeeId: string): Promise<void> {
  await archiveEmployee(ctx, employeeId);
}

// ── Assignments ─────────────────────────────────────────────────────────────

/** `POST /api/employees/:id/assign-policy` — `null` removes the employee-level override. */
export async function assignEmployeePolicy(
  ctx: ManagerContext,
  employeeId: string,
  input: AssignEmployeePolicyInput,
): Promise<Employee> {
  const organisationId = ctx.organisation.id;
  await requireEmployee(ctx, employeeId);
  if (input.policyId) await assertAssignablePolicy(organisationId, input.policyId);
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const ended = await endEmployeePolicyAssignments(tx, organisationId, employeeId, now);
    if (input.policyId) {
      await tx.policyAssignment.create({
        data: {
          organisationId,
          policyId: input.policyId,
          scopeType: "EMPLOYEE",
          scopeId: employeeId,
          effectiveFrom: now,
          createdById: ctx.user.id,
        },
      });
    }
    await audit(
      ctx,
      {
        action: "employee.policy_assigned",
        entityType: "Employee",
        entityId: employeeId,
        before: { endedAssignments: ended },
        after: { policyId: input.policyId },
      },
      tx,
    );
  });
  // Devices resolving through this employee-level assignment must re-sync (silent push + dashboard frame).
  publishPolicyChanged({
    organisationId: ctx.organisation.id,
    policyId: input.policyId ?? null,
    reason: input.policyId ? "ASSIGNED" : "UNASSIGNED",
    affectedEmployeeIds: [employeeId],
  });
  return reloadEmployeeDto(ctx, employeeId);
}

/** `POST /api/employees/:id/assign-break-policy` — `null` removes the employee-level override. */
export async function assignEmployeeBreakPolicy(
  ctx: ManagerContext,
  employeeId: string,
  input: AssignEmployeeBreakPolicyInput,
): Promise<Employee> {
  const organisationId = ctx.organisation.id;
  await requireEmployee(ctx, employeeId);
  if (input.breakPolicyId) await assertAssignableBreakPolicy(organisationId, input.breakPolicyId);
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const ended = await endEmployeeBreakPolicyAssignments(tx, organisationId, employeeId, now);
    if (input.breakPolicyId) {
      await tx.breakPolicyAssignment.create({
        data: {
          organisationId,
          breakPolicyId: input.breakPolicyId,
          scopeType: "EMPLOYEE",
          scopeId: employeeId,
          effectiveFrom: now,
          createdById: ctx.user.id,
        },
      });
    }
    await audit(
      ctx,
      {
        action: "employee.break_policy_assigned",
        entityType: "Employee",
        entityId: employeeId,
        before: { endedAssignments: ended },
        after: { breakPolicyId: input.breakPolicyId },
      },
      tx,
    );
  });
  publishBreakPolicyChanged({
    organisationId: ctx.organisation.id,
    breakPolicyId: input.breakPolicyId ?? null,
    reason: input.breakPolicyId ? "ASSIGNED" : "UNASSIGNED",
    affectedEmployeeIds: [employeeId],
  });
  return reloadEmployeeDto(ctx, employeeId);
}

/** `POST /api/employees/:id/assign-location` — primary and/or the whole set of locations. */
export async function assignEmployeeLocation(
  ctx: ManagerContext,
  employeeId: string,
  input: AssignEmployeeLocationInput,
): Promise<Employee> {
  const organisationId = ctx.organisation.id;
  const before = await requireEmployee(ctx, employeeId);
  await assertManagedEmployeeEdit(prisma, organisationId, before, {
    primaryLocationId: input.primaryLocationId,
  });
  await assertReferences(organisationId, {
    primaryLocationId: input.primaryLocationId,
    locationIds: input.locationIds,
  });
  const nextPrimary =
    input.primaryLocationId !== undefined ? input.primaryLocationId : before.primaryLocationId;
  await prisma.$transaction(async (tx) => {
    if (input.primaryLocationId !== undefined) {
      await tx.employee.update({
        where: { id: employeeId },
        data: { primaryLocationId: input.primaryLocationId },
      });
    }
    if (input.locationIds !== undefined) {
      const ids = uniqueIds(nextPrimary ? [nextPrimary] : [], input.locationIds);
      await tx.employeeLocation.deleteMany({ where: { employeeId } });
      if (ids.length > 0) {
        await tx.employeeLocation.createMany({
          data: ids.map((locationId) => ({ employeeId, locationId })),
        });
      }
    } else if (nextPrimary) {
      await tx.employeeLocation.upsert({
        where: { employeeId_locationId: { employeeId, locationId: nextPrimary } },
        create: { employeeId, locationId: nextPrimary },
        update: {},
      });
    }
    await audit(
      ctx,
      {
        action: "employee.location_assigned",
        entityType: "Employee",
        entityId: employeeId,
        before: {
          primaryLocationId: before.primaryLocationId,
          locationIds: before.locations.map((l) => l.locationId),
        },
        after: { primaryLocationId: nextPrimary, locationIds: input.locationIds ?? null },
      },
      tx,
    );
  });
  return reloadEmployeeDto(ctx, employeeId);
}

/** `POST /api/employees/:id/assign-team` — replaces the team memberships. */
export async function assignEmployeeTeam(
  ctx: ManagerContext,
  employeeId: string,
  input: AssignEmployeeTeamInput,
): Promise<Employee> {
  const organisationId = ctx.organisation.id;
  const before = await requireEmployee(ctx, employeeId);
  await assertReferences(organisationId, { teamIds: input.teamIds });
  const ids = uniqueIds(input.teamIds);
  await prisma.$transaction(async (tx) => {
    await tx.employeeTeam.deleteMany({ where: { employeeId } });
    if (ids.length > 0) {
      await tx.employeeTeam.createMany({ data: ids.map((teamId) => ({ employeeId, teamId })) });
    }
    await audit(
      ctx,
      {
        action: "employee.teams_assigned",
        entityType: "Employee",
        entityId: employeeId,
        before: { teamIds: before.teams.map((t) => t.teamId) },
        after: { teamIds: ids },
      },
      tx,
    );
  });
  return reloadEmployeeDto(ctx, employeeId);
}

/** Bulk `ADD_TO_TEAM`: idempotent membership add. */
async function addEmployeeToTeam(
  ctx: ManagerContext,
  employeeId: string,
  teamId: string,
): Promise<void> {
  await requireEmployee(ctx, employeeId);
  await assertReferences(ctx.organisation.id, { teamIds: [teamId] });
  await prisma.$transaction(async (tx) => {
    await tx.employeeTeam.upsert({
      where: { employeeId_teamId: { employeeId, teamId } },
      create: { employeeId, teamId },
      update: {},
    });
    await audit(
      ctx,
      {
        action: "employee.team_added",
        entityType: "Employee",
        entityId: employeeId,
        after: { teamId },
      },
      tx,
    );
  });
}

// ── Bulk ────────────────────────────────────────────────────────────────────

/** `POST /api/employees/bulk` — partial success; per-employee failures are reported. */
export async function bulkEmployeeAction(
  ctx: ManagerContext,
  input: BulkEmployeeActionInput,
): Promise<BulkEmployeeActionResponse> {
  const failed: BulkEmployeeActionResponse["failed"] = [];
  let succeeded = 0;
  for (const employeeId of input.employeeIds) {
    try {
      await applyBulkAction(ctx, employeeId, input);
      succeeded++;
    } catch (err) {
      failed.push({ employeeId, ...describeBulkFailure(err) });
    }
  }
  return { action: input.action, processed: input.employeeIds.length, succeeded, failed };
}

async function applyBulkAction(
  ctx: ManagerContext,
  employeeId: string,
  input: BulkEmployeeActionInput,
): Promise<void> {
  switch (input.action) {
    case "INVITE":
      // `POST /employees/:id/invites` is rate limited per IP; a bulk EMAIL invite draws on the same budget
      // (same key) so one request cannot send hundreds of emails. LINK delivers nothing and is not limited.
      if (input.payload.channel === "EMAIL") {
        await enforceRateLimit(RATE_LIMITS.employeeInvite, ctx.ip ?? "unknown");
      }
      await createEmployeeInvite(ctx, employeeId, input.payload);
      return;
    case "ASSIGN_POLICY":
      await assignEmployeePolicy(ctx, employeeId, input.payload);
      return;
    case "ASSIGN_BREAK_POLICY":
      await assignEmployeeBreakPolicy(ctx, employeeId, input.payload);
      return;
    case "ASSIGN_LOCATION":
      await assignEmployeeLocation(ctx, employeeId, {
        primaryLocationId: input.payload.primaryLocationId,
      });
      return;
    case "ADD_TO_TEAM":
      await addEmployeeToTeam(ctx, employeeId, input.payload.teamId);
      return;
    case "DEACTIVATE":
      await deactivateEmployee(ctx, employeeId, input.payload ?? {});
      return;
    case "REACTIVATE":
      await reactivateEmployee(ctx, employeeId);
      return;
    case "ARCHIVE":
      await archiveEmployee(ctx, employeeId);
      return;
    default: {
      const exhaustive: never = input;
      throw new Error(`Unknown bulk action ${String(exhaustive)}`);
    }
  }
}

function describeBulkFailure(err: unknown): { code: ApiErrorCode; message: string } {
  if (isAppError(err)) return { code: err.code, message: err.message };
  logger.error({ error: errorSummary(err) }, "bulk employee action failed");
  return { code: "INTERNAL_ERROR", message: "Something went wrong" };
}

// ── State, shifts, activity ─────────────────────────────────────────────────

function parseInstant(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** `GET /api/employees/:id/state` (`employees:read`). */
export async function getEmployeeState(
  ctx: ManagerContext,
  employeeId: string,
  query: EmployeeStateQuery,
): Promise<EmployeeStateResponse> {
  const organisation = ctx.organisation;
  const row = await requireEmployee(ctx, employeeId);
  const now = new Date();
  const to = parseInstant(query.to) ?? now;
  const from = parseInstant(query.from) ?? new Date(to.getTime() - STATE_TIMELINE_DEFAULT_MS);

  const [contexts, policies, timelineRows] = await Promise.all([
    getEmployeeStatusContext(organisation.id, [employeeId], {
      now,
      employees: [row],
      organisationTimezone: organisation.timezone,
      window: {
        from: new Date(now.getTime() - DAY_MS),
        to: new Date(now.getTime() + STATE_SHIFT_LOOKAHEAD_MS),
      },
    }),
    resolvePoliciesForEmployees(organisation.id, [row.id], now),
    prisma.activityEvent.findMany({
      where: {
        organisationId: organisation.id,
        employeeId,
        occurredAt: { gte: from, lte: to },
      },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: STATE_TIMELINE_MAX_EVENTS,
    }),
  ]);
  const context = contexts.get(employeeId);
  if (!context) throw new AppError("EMPLOYEE_NOT_FOUND", "Employee not found");
  const computed = computeEmployeeStatus(context, now);
  const resolved = policies.get(employeeId);
  const summary = toEmployeeSummary({ ...row, inviteStatus: computed.inviteStatus });

  const activeShiftRow = computed.expected.activeShift
    ? (context.shifts.find((s) => s.id === computed.expected.activeShift?.id) ?? null)
    : null;
  const activeBreakRow = computed.expected.activeBreak
    ? (context.breakSessions.find((b) => b.id === computed.expected.activeBreak?.id) ?? null)
    : null;
  const breakAllowance =
    activeShiftRow && resolved?.breakPolicyRules
      ? computeBreakAllowance(
          resolved.breakPolicyRules,
          activeShiftRow,
          context.breakSessions.filter((b) => b.shiftId === activeShiftRow.id),
          now,
        )
      : null;
  const activeOverrides = context.overrides.filter(
    (o) => o.startsAt.getTime() <= now.getTime() && o.expiresAt.getTime() > now.getTime(),
  );

  const actors = await findUsersByIds(
    uniqueIds(timelineRows.map((e) => e.actorUserId).filter((id): id is string => id !== null)),
  );
  const actorById = new Map(actors.map((u) => [u.id, u]));

  return {
    employee: summary,
    expected: toExpectedStateJson(computed.expected),
    reported: {
      state: context.workState?.reportedState ?? null,
      reportedAt: context.workState?.reportedAt?.toISOString() ?? null,
    },
    diverged: computed.diverged,
    deviceStatus: toDeviceStatusDto(computed.status, computed.since),
    device: context.device ? toDeviceSummary(context.device) : null,
    workState: context.workState ? toWorkStateDto(context.workState) : null,
    activeShift: activeShiftRow ? toShiftSummary(activeShiftRow) : null,
    activeBreak: activeBreakRow ? toBreakSessionDto(activeBreakRow) : null,
    breakAllowance: breakAllowance
      ? {
          breaksTaken: breakAllowance.breaksTaken,
          breaksRemaining: breakAllowance.breaksRemaining,
          minutesUsed: breakAllowance.minutesUsed,
          minutesRemaining: breakAllowance.minutesRemaining,
          nextEligibleAt: breakAllowance.nextEligibleAt?.toISOString() ?? null,
          canStartNow: breakAllowance.canStartNow,
        }
      : null,
    activeOverrides: activeOverrides.map((o) => toOverrideDto(o, now)),
    timeline: timelineRows.map((e) =>
      toActivityEventDto(e, summary, e.actorUserId ? (actorById.get(e.actorUserId) ?? null) : null),
    ),
  };
}

/**
 * `GET /api/employees/:id/shifts` (`schedule:read`). The employee is checked here (tenant scope, 404);
 * the listing itself is the shifts domain's, so the DTO and the default window match `GET /api/shifts`.
 */
export async function listEmployeeShifts(
  ctx: ManagerContext,
  employeeId: string,
  query: EmployeeShiftsQuery,
): Promise<ListShiftsResponse> {
  await requireEmployee(ctx, employeeId);
  const from = parseInstant(query.from);
  const to = parseInstant(query.to);
  if (from && to && to.getTime() <= from.getTime()) {
    throw new AppError("VALIDATION_ERROR", "to must be after from", {
      details: { source: "query", formErrors: [], fieldErrors: { to: ["to must be after from"] } },
    });
  }
  return listShiftsForEmployee(ctx.organisation.id, employeeId, query);
}

interface ActivityCursor {
  t: string;
  id: string;
}

function encodeCursor(row: ActivityEventRow): string {
  const cursor: ActivityCursor = { t: row.occurredAt.toISOString(), id: row.id };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): ActivityCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<ActivityCursor>;
    if (
      typeof parsed.t === "string" &&
      !Number.isNaN(Date.parse(parsed.t)) &&
      typeof parsed.id === "string"
    ) {
      return { t: parsed.t, id: parsed.id };
    }
  } catch {
    // fall through
  }
  throw new AppError("VALIDATION_ERROR", "Invalid cursor", {
    details: { source: "query", formErrors: [], fieldErrors: { cursor: ["Invalid cursor"] } },
  });
}

/** `GET /api/employees/:id/activity` (`employees:read`). Cursor-paginated, newest first. */
export async function listEmployeeActivity(
  ctx: ManagerContext,
  employeeId: string,
  query: EmployeeActivityQuery,
): Promise<ListActivityResponse> {
  const row = await requireEmployee(ctx, employeeId);
  const cursor = decodeCursor(query.cursor);
  const from = parseInstant(query.from);
  const to = parseInstant(query.to);
  const and: Prisma.ActivityEventWhereInput[] = [];
  if (query.type && query.type.length > 0) and.push({ type: { in: query.type } });
  if (from) and.push({ occurredAt: { gte: from } });
  if (to) and.push({ occurredAt: { lte: to } });
  if (cursor) {
    const at = new Date(cursor.t);
    and.push({ OR: [{ occurredAt: { lt: at } }, { occurredAt: at, id: { lt: cursor.id } }] });
  }
  const rows = await prisma.activityEvent.findMany({
    where: {
      organisationId: ctx.organisation.id,
      employeeId,
      ...(and.length > 0 ? { AND: and } : {}),
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
  });
  const page = rows.slice(0, query.limit);
  const nextCursor = rows.length > query.limit ? encodeCursor(page[page.length - 1]!) : null;
  const actors = await findUsersByIds(
    uniqueIds(page.map((e) => e.actorUserId).filter((id): id is string => id !== null)),
  );
  const actorById = new Map(actors.map((u) => [u.id, u]));
  const summary = toEmployeeSummary(row);
  return {
    items: page.map((e) =>
      toActivityEventDto(e, summary, e.actorUserId ? (actorById.get(e.actorUserId) ?? null) : null),
    ),
    nextCursor,
  };
}
