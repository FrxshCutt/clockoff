import { Prisma, prisma } from "@clockoff/db";
import { AppError } from "@clockoff/shared/errors";
import type {
  CreateDepartmentInput,
  Department,
  ListDepartmentsResponse,
  UpdateDepartmentInput,
} from "@clockoff/validation/locationsTeams";
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

/** `DELETE /api/departments/:id`: employees in it are left without a department. */
export async function deleteDepartment(ctx: ManagerContext, id: string): Promise<void> {
  const organisationId = ctx.organisation.id;
  await prisma.$transaction(async (tx) => {
    const before = await loadDepartmentOrThrow(organisationId, id, tx);
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
