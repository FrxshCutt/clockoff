import { prisma, type Prisma } from "@clockoff/db";

/** Department rows, scoped by the organisation id from the caller's verified membership. */

export type Db = Prisma.TransactionClient | typeof prisma;

export const departmentInclude = {
  _count: { select: { employees: { where: { deletedAt: null } } } },
} satisfies Prisma.DepartmentInclude;
export type DepartmentRow = Prisma.DepartmentGetPayload<{ include: typeof departmentInclude }>;

export async function findDepartments(
  organisationId: string,
  db: Db = prisma,
): Promise<DepartmentRow[]> {
  return db.department.findMany({
    where: { organisationId },
    include: departmentInclude,
    orderBy: [{ name: "asc" }, { createdAt: "asc" }],
  });
}

export async function findDepartmentInOrganisation(
  organisationId: string,
  departmentId: string,
  db: Db = prisma,
): Promise<DepartmentRow | null> {
  return db.department.findFirst({
    where: { id: departmentId, organisationId },
    include: departmentInclude,
  });
}

/** Case-insensitive name match (the unique index is case-sensitive; the API is stricter). */
export async function findDepartmentByName(
  organisationId: string,
  name: string,
  options: { excludeId?: string; db?: Db } = {},
): Promise<{ id: string } | null> {
  const db = options.db ?? prisma;
  return db.department.findFirst({
    where: {
      organisationId,
      name: { equals: name, mode: "insensitive" },
      ...(options.excludeId ? { id: { not: options.excludeId } } : {}),
    },
    select: { id: true },
  });
}
