import { Prisma, prisma, type IntegrationProvider, type IntegrationStatus } from "@clockoff/db";
import { AppError } from "@clockoff/shared/errors";
import { PROVIDERS } from "@clockoff/shared/providers/registry";
import type {
  CreateDepartmentInput,
  Department,
  ListDepartmentsResponse,
  UpdateDepartmentInput,
} from "@clockoff/validation/locationsTeams";
import { env } from "@/lib/env";
import { audit } from "@/server/audit/audit";
import type { ManagerContext } from "@/server/tenancy/context";
import {
  departmentInclude,
  findDepartmentByName,
  findDepartmentInOrganisation,
  findDepartments,
  type Db,
  type DepartmentRow,
} from "./departments.repository";

/**
 * Departments (§5 locations & teams): a flat label on employees. Names are unique per organisation
 * (case-insensitive → CONFLICT). Deleting a department leaves its employees without one (the foreign key
 * is SetNull). Every mutation is audited.
 *
 * A department an integration maps a provider department to (plan §6.3, target "ClockOff department") cannot
 * be deleted while it is a mapping target of a connected, switched-on integration: CONFLICT with
 * `details.reason = "INTEGRATION_MAPPING_TARGET"` (choose another target in the integration's settings first).
 * Departments are never managed by a sync, so renaming stays allowed.
 */

export function toDepartmentDto(row: DepartmentRow): Department {
  return {
    id: row.id,
    name: row.name,
    employeeCount: row._count.employees,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function nameConflict(): AppError {
  return new AppError("CONFLICT", "A department with this name already exists", {
    details: { field: "name" },
  });
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

async function loadDepartmentOrThrow(
  organisationId: string,
  id: string,
  db?: Db,
): Promise<DepartmentRow> {
  const row = await findDepartmentInOrganisation(organisationId, id, db);
  if (!row) throw new AppError("NOT_FOUND", "Department not found");
  return row;
}

/** `GET /api/departments` */
export async function listDepartments(ctx: ManagerContext): Promise<ListDepartmentsResponse> {
  const rows = await findDepartments(ctx.organisation.id);
  return { departments: rows.map(toDepartmentDto) };
}

/** `GET /api/departments/:id` */
export async function getDepartment(ctx: ManagerContext, id: string): Promise<Department> {
  return toDepartmentDto(await loadDepartmentOrThrow(ctx.organisation.id, id));
}

/** `POST /api/departments` */
export async function createDepartment(
  ctx: ManagerContext,
  input: CreateDepartmentInput,
): Promise<Department> {
  const organisationId = ctx.organisation.id;
  if (await findDepartmentByName(organisationId, input.name)) throw nameConflict();
  try {
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.department.create({
        data: { organisationId, name: input.name },
        include: departmentInclude,
      });
      await audit(
        ctx,
        {
          action: "department.created",
          entityType: "Department",
          entityId: row.id,
          after: { name: row.name },
        },
        tx,
      );
      return row;
    });
    return toDepartmentDto(created);
  } catch (err) {
    if (isUniqueViolation(err)) throw nameConflict();
    throw err;
  }
}

/** `PATCH /api/departments/:id` (rename) */
export async function updateDepartment(
  ctx: ManagerContext,
  id: string,
  input: UpdateDepartmentInput,
): Promise<Department> {
  const organisationId = ctx.organisation.id;
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const before = await loadDepartmentOrThrow(organisationId, id, tx);
      if (before.name === input.name) return before;
      if (await findDepartmentByName(organisationId, input.name, { excludeId: id, db: tx }))
        throw nameConflict();
      const after = await tx.department.update({
        where: { id },
        data: { name: input.name },
        include: departmentInclude,
      });
      await audit(
        ctx,
        {
          action: "department.updated",
          entityType: "Department",
          entityId: id,
          before: { name: before.name },
          after: { name: after.name },
        },
        tx,
      );
      return after;
    });
    return toDepartmentDto(updated);
  } catch (err) {
    if (isUniqueViolation(err)) throw nameConflict();
    throw err;
  }
}

/** True when `mappings` (an `IntegrationMappingConfig.departmentMappings` value) targets `departmentId`. */
function mappingsTarget(mappings: Prisma.JsonValue, departmentId: string): boolean {
  if (typeof mappings !== "object" || mappings === null || Array.isArray(mappings)) return false;
  return Object.values(mappings).some(
    (mapping) =>
      typeof mapping === "object" &&
      mapping !== null &&
      !Array.isArray(mapping) &&
      mapping.target === "DEPARTMENT" &&
      mapping.departmentId === departmentId,
  );
}

/**
 * Whether an integration's mapping can still be acted on: it is connected (not DISCONNECTED or NOT_CONNECTED) and
 * its provider is switched on (`PLANDAY_ENABLED`; the kill switch hides the settings that would change the target).
 */
function mappingActionable(integration: {
  provider: IntegrationProvider;
  status: IntegrationStatus;
}): boolean {
  if (integration.status === "DISCONNECTED" || integration.status === "NOT_CONNECTED") return false;
  return integration.provider === "PLANDAY" ? env().PLANDAY_ENABLED : false;
}

/**
 * Refuses to delete a department an integration maps to (its mapping config or a `DEPARTMENT` map row) while that
 * integration is connected and switched on: the sync writes `Employee.departmentId` from it, and the manager can
 * choose another target in the integration's settings. After a disconnect (or with the provider switched off) the
 * delete goes ahead, since those settings cannot be reached; the mapping config and map rows are kept for a
 * reconnect (§5.8), and the sync then reports the missing target (`DEPARTMENT_TARGET_MISSING`) until a new one is
 * chosen.
 */
async function assertNotMappingTarget(
  tx: Prisma.TransactionClient,
  organisationId: string,
  departmentId: string,
): Promise<void> {
  const integrationSelect = { select: { provider: true, status: true } } as const;
  const [configs, mapRows] = await Promise.all([
    tx.integrationMappingConfig.findMany({
      where: { organisationId },
      select: { departmentMappings: true, integration: integrationSelect },
    }),
    tx.externalEntityMap.findMany({
      where: { organisationId, entityType: "DEPARTMENT", internalId: departmentId },
      select: { integration: integrationSelect },
    }),
  ]);
  const provider: IntegrationProvider | undefined =
    configs.find(
      (c) => mappingsTarget(c.departmentMappings, departmentId) && mappingActionable(c.integration),
    )?.integration.provider ??
    mapRows.find((m) => mappingActionable(m.integration))?.integration.provider;
  if (!provider) return;
  const name = PROVIDERS[provider].displayName;
  throw new AppError(
    "CONFLICT",
    `${name} employees are synced into this department. Choose another target in the ${name} settings before deleting it.`,
    { details: { reason: "INTEGRATION_MAPPING_TARGET", provider } },
  );
}

/**
 * `DELETE /api/departments/:id`: employees in it are left without a department. Refused while an integration
 * maps to it.
 */
export async function deleteDepartment(ctx: ManagerContext, id: string): Promise<void> {
  const organisationId = ctx.organisation.id;
  await prisma.$transaction(async (tx) => {
    const before = await loadDepartmentOrThrow(organisationId, id, tx);
    await assertNotMappingTarget(tx, organisationId, id);
    const detached = await tx.employee.count({ where: { organisationId, departmentId: id } });
    await tx.department.delete({ where: { id } });
    await audit(
      ctx,
      {
        action: "department.deleted",
        entityType: "Department",
        entityId: id,
        before: { name: before.name },
        after: { employeesDetached: detached },
      },
      tx,
    );
  });
}
