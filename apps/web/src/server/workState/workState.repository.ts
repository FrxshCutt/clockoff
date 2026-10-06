import {
  Prisma,
  prisma,
  type BreakSession,
  type Device,
  type EmployeeWorkState,
  type EmploymentStatus,
  type InviteStatus,
  type ManagerOverride,
  type ScheduledBreak,
  type Shift,
} from "@workmode/db";

/**
 * Organisation-scoped loaders for Work Mode state evaluation. Every function takes the organisation id
 * explicitly; it always comes from a verified context (device row or membership), never from input.
 */

type Db = Prisma.TransactionClient | typeof prisma;

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface WorkStateEmployee {
  id: string;
  organisationId: string;
  firstName: string;
  lastName: string;
  jobTitle: string | null;
  inviteStatus: InviteStatus;
  employmentStatus: EmploymentStatus;
  primaryLocationId: string | null;
  primaryLocation: { id: string; name: string; timezone: string | null } | null;
  teams: Array<{ teamId: string }>;
}

export type WorkStateShift = Shift & {
  scheduledBreaks: ScheduledBreak[];
  location: { id: string; name: string } | null;
};

export interface ShiftWindow {
  from: Date;
  to: Date;
}

export interface WorkStateInputs {
  organisation: { id: string; timezone: string };
  employees: WorkStateEmployee[];
  /** SCHEDULED, not deleted, overlapping the window; ordered by startsAt. */
  shiftsByEmployee: Map<string, WorkStateShift[]>;
  /** Every session (any status) of the loaded shifts. */
  sessionsByShift: Map<string, BreakSession[]>;
  /** Not revoked, expiring after `now`: employee-specific for the loaded employees, or organisation-wide. */
  overrides: ManagerOverride[];
  /** The active device of each employee (most recently seen first). */
  devicesByEmployee: Map<string, Device>;
  workStatesByEmployee: Map<string, EmployeeWorkState>;
}

export function defaultShiftWindow(now: Date): ShiftWindow {
  return { from: new Date(now.getTime() - DAY_MS), to: new Date(now.getTime() + DAY_MS) };
}

const EMPLOYEE_SELECT = {
  id: true,
  organisationId: true,
  firstName: true,
  lastName: true,
  jobTitle: true,
  inviteStatus: true,
  employmentStatus: true,
  primaryLocationId: true,
  primaryLocation: { select: { id: true, name: true, timezone: true } },
  teams: { select: { teamId: true } },
} satisfies Prisma.EmployeeSelect;

export async function loadWorkStateInputs(
  params: {
    organisationId: string;
    employeeIds: readonly string[];
    now: Date;
    shiftWindow?: ShiftWindow;
  },
  db: Db = prisma,
): Promise<WorkStateInputs> {
  const { organisationId, now } = params;
  const employeeIds = [...new Set(params.employeeIds)];
  const window = params.shiftWindow ?? defaultShiftWindow(now);

  const organisation = await db.organisation.findUniqueOrThrow({
    where: { id: organisationId },
    select: { id: true, timezone: true },
  });
  if (employeeIds.length === 0) {
    return {
      organisation,
      employees: [],
      shiftsByEmployee: new Map(),
      sessionsByShift: new Map(),
      overrides: [],
      devicesByEmployee: new Map(),
      workStatesByEmployee: new Map(),
    };
  }

  const [employees, shifts, overrides, devices, workStates] = await Promise.all([
    db.employee.findMany({
      where: { organisationId, id: { in: employeeIds }, deletedAt: null },
      select: EMPLOYEE_SELECT,
    }),
    db.shift.findMany({
      where: {
        organisationId,
        employeeId: { in: employeeIds },
        status: "SCHEDULED",
        deletedAt: null,
        startsAt: { lt: window.to },
        endsAt: { gt: window.from },
      },
      include: { scheduledBreaks: true, location: { select: { id: true, name: true } } },
      orderBy: [{ startsAt: "asc" }, { endsAt: "asc" }, { id: "asc" }],
    }),
    db.managerOverride.findMany({
      where: {
        organisationId,
        revokedAt: null,
        expiresAt: { gt: now },
        OR: [{ employeeId: null }, { employeeId: { in: employeeIds } }],
      },
      orderBy: [{ startsAt: "asc" }],
    }),
    db.device.findMany({
      where: { organisationId, employeeId: { in: employeeIds }, isActive: true },
      orderBy: [{ lastSeenAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    }),
    db.employeeWorkState.findMany({ where: { employeeId: { in: employeeIds } } }),
  ]);

  const shiftIds = shifts.map((s) => s.id);
  const sessions =
    shiftIds.length > 0
      ? await db.breakSession.findMany({
          where: { organisationId, shiftId: { in: shiftIds } },
          orderBy: [{ startedAt: "asc" }],
        })
      : [];

  const shiftsByEmployee = new Map<string, WorkStateShift[]>();
  for (const shift of shifts) {
    const list = shiftsByEmployee.get(shift.employeeId);
    if (list) list.push(shift);
    else shiftsByEmployee.set(shift.employeeId, [shift]);
  }
  const sessionsByShift = new Map<string, BreakSession[]>();
  for (const session of sessions) {
    const list = sessionsByShift.get(session.shiftId);
    if (list) list.push(session);
    else sessionsByShift.set(session.shiftId, [session]);
  }
  const devicesByEmployee = new Map<string, Device>();
  for (const device of devices) {
    if (!devicesByEmployee.has(device.employeeId)) devicesByEmployee.set(device.employeeId, device);
  }
  const workStatesByEmployee = new Map<string, EmployeeWorkState>();
  for (const row of workStates) workStatesByEmployee.set(row.employeeId, row);

  return {
    organisation,
    employees,
    shiftsByEmployee,
    sessionsByShift,
    overrides,
    devicesByEmployee,
    workStatesByEmployee,
  };
}

/**
 * Employees the job must evaluate at `now`, grouped by organisation: ACTIVE employees with a SCHEDULED shift
 * overlapping [now − 1 day, now + 1 day], with an ACTIVE break session, covered by an active override
 * (employee-specific, or every active employee of an organisation under an org-wide override), or whose
 * stored state has not settled back to OFF_SHIFT yet.
 */
export async function findJobCandidates(
  now: Date,
  db: Db = prisma,
): Promise<Map<string, Set<string>>> {
  const window = defaultShiftWindow(now);
  const activeEmployee = { deletedAt: null, employmentStatus: "ACTIVE" as const };
  const [shiftRows, breakRows, overrideRows, stateRows] = await Promise.all([
    db.shift.findMany({
      where: {
        status: "SCHEDULED",
        deletedAt: null,
        startsAt: { lt: window.to },
        endsAt: { gt: window.from },
        employee: activeEmployee,
      },
      select: { organisationId: true, employeeId: true },
      distinct: ["employeeId"],
    }),
    db.breakSession.findMany({
      where: { status: "ACTIVE", employee: activeEmployee },
      select: { organisationId: true, employeeId: true },
      distinct: ["employeeId"],
    }),
    db.managerOverride.findMany({
      where: { revokedAt: null, expiresAt: { gt: now }, startsAt: { lte: now } },
      select: { organisationId: true, employeeId: true },
    }),
    db.employeeWorkState.findMany({
      where: {
        OR: [
          { state: { not: "OFF_SHIFT" } },
          { expectedState: { not: "OFF_SHIFT" } },
          { activeBreakSessionId: { not: null } },
        ],
        employee: activeEmployee,
      },
      select: { employeeId: true, employee: { select: { organisationId: true } } },
    }),
  ]);

  const result = new Map<string, Set<string>>();
  const add = (organisationId: string, employeeId: string) => {
    const set = result.get(organisationId);
    if (set) set.add(employeeId);
    else result.set(organisationId, new Set([employeeId]));
  };
  for (const row of shiftRows) add(row.organisationId, row.employeeId);
  for (const row of breakRows) add(row.organisationId, row.employeeId);
  for (const row of stateRows) add(row.employee.organisationId, row.employeeId);

  const orgWide = new Set<string>();
  for (const row of overrideRows) {
    if (row.employeeId) add(row.organisationId, row.employeeId);
    else orgWide.add(row.organisationId);
  }
  if (orgWide.size > 0) {
    const everyone = await db.employee.findMany({
      where: { organisationId: { in: [...orgWide] }, ...activeEmployee },
      select: { organisationId: true, id: true },
    });
    for (const row of everyone) add(row.organisationId, row.id);
  }
  return result;
}

/** Column values the evaluation writes (reported fields are owned by the device paths). */
export interface WorkStateWrite {
  state: EmployeeWorkState["state"];
  stateSince: Date;
  source: EmployeeWorkState["source"];
  activeShiftId: string | null;
  activeBreakSessionId: string | null;
  breaksTakenCount: number;
  breakMinutesUsed: number;
  expectedState: EmployeeWorkState["state"];
  expectedRestriction: EmployeeWorkState["expectedRestriction"];
  expectedComputedAt: Date;
  nextTransitionAt: Date | null;
  attentionReason: string | null;
  lastUpdatedAt: Date;
  reportedState?: EmployeeWorkState["state"] | null;
  reportedAt?: Date | null;
}

export interface UpsertWorkStateOptions {
  /**
   * When set, the update only succeeds if the stored `attentionReason` does not contain this marker — the
   * atomic "first tick of an episode" guard (`count === 1` means this call started it). A lost race falls back
   * to a plain update so the row still reflects the latest evaluation.
   */
  guardMarker?: string;
}

export async function upsertWorkState(
  employeeId: string,
  data: WorkStateWrite,
  options: UpsertWorkStateOptions = {},
  db: Db = prisma,
): Promise<{ row: EmployeeWorkState; wonGuard: boolean }> {
  const existing = await db.employeeWorkState.findUnique({ where: { employeeId } });
  if (!existing) {
    try {
      const row = await db.employeeWorkState.create({ data: { employeeId, ...data } });
      return { row, wonGuard: true };
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;
      // Created concurrently: fall through to the update path.
    }
  }
  if (options.guardMarker) {
    const guarded = await db.employeeWorkState.updateMany({
      where: {
        employeeId,
        OR: [
          { attentionReason: null },
          { attentionReason: { not: { contains: options.guardMarker } } },
        ],
      },
      data,
    });
    if (guarded.count === 1) {
      const row = await db.employeeWorkState.findUniqueOrThrow({ where: { employeeId } });
      return { row, wonGuard: true };
    }
  }
  const row = await db.employeeWorkState.update({ where: { employeeId }, data });
  return { row, wonGuard: false };
}
