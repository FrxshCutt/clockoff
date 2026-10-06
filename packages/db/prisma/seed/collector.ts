import type { Prisma } from "@prisma/client";

/**
 * Row buffers for one seed run. Builders push plain `createMany` inputs (ids are pre-assigned with
 * `stableId`, so rows can reference each other before anything is written) and `insertRows` writes them in
 * foreign-key order inside the caller's transaction.
 */
export interface SeedRows {
  users: Prisma.UserCreateManyInput[];
  organisations: Prisma.OrganisationCreateManyInput[];
  memberships: Prisma.OrganisationMembershipCreateManyInput[];
  joinCodes: Prisma.CompanyJoinCodeCreateManyInput[];
  locations: Prisma.LocationCreateManyInput[];
  departments: Prisma.DepartmentCreateManyInput[];
  teams: Prisma.TeamCreateManyInput[];
  policies: Prisma.PolicyCreateManyInput[];
  policyVersions: Prisma.PolicyVersionCreateManyInput[];
  /** `Policy.currentVersionId` is set after the versions exist (circular FK). */
  policyCurrentVersions: Array<{ policyId: string; versionId: string }>;
  policyAssignments: Prisma.PolicyAssignmentCreateManyInput[];
  breakPolicies: Prisma.BreakPolicyCreateManyInput[];
  breakPolicyAssignments: Prisma.BreakPolicyAssignmentCreateManyInput[];
  /** Organisation defaults are set after the policies exist (circular FK). */
  organisationDefaults: Array<{
    organisationId: string;
    defaultPolicyId: string | null;
    defaultBreakPolicyId: string | null;
  }>;
  employees: Prisma.EmployeeCreateManyInput[];
  employeeTeams: Prisma.EmployeeTeamCreateManyInput[];
  employeeLocations: Prisma.EmployeeLocationCreateManyInput[];
  employeeInvites: Prisma.EmployeeInviteCreateManyInput[];
  mobileUsers: Prisma.MobileUserCreateManyInput[];
  employeeUserLinks: Prisma.EmployeeUserLinkCreateManyInput[];
  devices: Prisma.DeviceCreateManyInput[];
  shifts: Prisma.ShiftCreateManyInput[];
  scheduledBreaks: Prisma.ScheduledBreakCreateManyInput[];
  breakSessions: Prisma.BreakSessionCreateManyInput[];
  employeeWorkStates: Prisma.EmployeeWorkStateCreateManyInput[];
  shiftImports: Prisma.ShiftImportCreateManyInput[];
  shiftImportRows: Prisma.ShiftImportRowCreateManyInput[];
  integrations: Prisma.IntegrationCreateManyInput[];
  overrides: Prisma.ManagerOverrideCreateManyInput[];
  activityEvents: Prisma.ActivityEventCreateManyInput[];
  notifications: Prisma.NotificationCreateManyInput[];
  auditLogs: Prisma.AuditLogCreateManyInput[];
}

export function emptyRows(): SeedRows {
  return {
    users: [],
    organisations: [],
    memberships: [],
    joinCodes: [],
    locations: [],
    departments: [],
    teams: [],
    policies: [],
    policyVersions: [],
    policyCurrentVersions: [],
    policyAssignments: [],
    breakPolicies: [],
    breakPolicyAssignments: [],
    organisationDefaults: [],
    employees: [],
    employeeTeams: [],
    employeeLocations: [],
    employeeInvites: [],
    mobileUsers: [],
    employeeUserLinks: [],
    devices: [],
    shifts: [],
    scheduledBreaks: [],
    breakSessions: [],
    employeeWorkStates: [],
    shiftImports: [],
    shiftImportRows: [],
    integrations: [],
    overrides: [],
    activityEvents: [],
    notifications: [],
    auditLogs: [],
  };
}

async function many<T>(data: readonly T[], run: (data: T[]) => Promise<unknown>): Promise<void> {
  if (data.length > 0) await run([...data]);
}

/** Writes every buffered row in dependency order. Call inside a transaction. */
export async function insertRows(tx: Prisma.TransactionClient, rows: SeedRows): Promise<void> {
  await many(rows.users, (data) => tx.user.createMany({ data }));
  await many(rows.organisations, (data) => tx.organisation.createMany({ data }));
  await many(rows.memberships, (data) => tx.organisationMembership.createMany({ data }));
  await many(rows.joinCodes, (data) => tx.companyJoinCode.createMany({ data }));
  await many(rows.locations, (data) => tx.location.createMany({ data }));
  await many(rows.departments, (data) => tx.department.createMany({ data }));
  await many(rows.teams, (data) => tx.team.createMany({ data }));

  await many(rows.policies, (data) => tx.policy.createMany({ data }));
  await many(rows.policyVersions, (data) => tx.policyVersion.createMany({ data }));
  for (const { policyId, versionId } of rows.policyCurrentVersions) {
    await tx.policy.update({ where: { id: policyId }, data: { currentVersionId: versionId } });
  }
  await many(rows.policyAssignments, (data) => tx.policyAssignment.createMany({ data }));
  await many(rows.breakPolicies, (data) => tx.breakPolicy.createMany({ data }));
  await many(rows.breakPolicyAssignments, (data) => tx.breakPolicyAssignment.createMany({ data }));
  for (const d of rows.organisationDefaults) {
    await tx.organisation.update({
      where: { id: d.organisationId },
      data: { defaultPolicyId: d.defaultPolicyId, defaultBreakPolicyId: d.defaultBreakPolicyId },
    });
  }

  await many(rows.employees, (data) => tx.employee.createMany({ data }));
  await many(rows.employeeTeams, (data) => tx.employeeTeam.createMany({ data }));
  await many(rows.employeeLocations, (data) => tx.employeeLocation.createMany({ data }));
  await many(rows.employeeInvites, (data) => tx.employeeInvite.createMany({ data }));
  await many(rows.mobileUsers, (data) => tx.mobileUser.createMany({ data }));
  await many(rows.employeeUserLinks, (data) => tx.employeeUserLink.createMany({ data }));
  await many(rows.devices, (data) => tx.device.createMany({ data }));

  // Recurrence children reference their anchor shift: write anchors first.
  await many(
    rows.shifts.filter((s) => !s.parentRecurrenceId),
    (data) => tx.shift.createMany({ data }),
  );
  await many(
    rows.shifts.filter((s) => Boolean(s.parentRecurrenceId)),
    (data) => tx.shift.createMany({ data }),
  );
  await many(rows.scheduledBreaks, (data) => tx.scheduledBreak.createMany({ data }));
  await many(rows.breakSessions, (data) => tx.breakSession.createMany({ data }));
  await many(rows.employeeWorkStates, (data) => tx.employeeWorkState.createMany({ data }));

  await many(rows.shiftImports, (data) => tx.shiftImport.createMany({ data }));
  await many(rows.shiftImportRows, (data) => tx.shiftImportRow.createMany({ data }));
  await many(rows.integrations, (data) => tx.integration.createMany({ data }));
  await many(rows.overrides, (data) => tx.managerOverride.createMany({ data }));
  await many(rows.activityEvents, (data) => tx.activityEvent.createMany({ data }));
  await many(rows.notifications, (data) => tx.notification.createMany({ data }));
  await many(rows.auditLogs, (data) => tx.auditLog.createMany({ data }));
}
