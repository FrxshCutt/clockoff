import type { PrismaClient } from "@prisma/client";
import type { EmployeeSummary } from "./harpenden";

export interface CountedOrganisation {
  label: string;
  id: string;
}

export interface CountRow {
  table: string;
  counts: number[];
}

/** Row counts per demo organisation for every tenant-owned table (plus the tables reached through them). */
export async function collectCounts(
  prisma: PrismaClient,
  organisations: readonly CountedOrganisation[],
): Promise<CountRow[]> {
  const counters: Array<[string, (organisationId: string) => Promise<number>]> = [
    ["users (members)", (id) => prisma.organisationMembership.count({ where: { organisationId: id } })],
    ["company_join_codes", (id) => prisma.companyJoinCode.count({ where: { organisationId: id } })],
    ["locations", (id) => prisma.location.count({ where: { organisationId: id } })],
    ["departments", (id) => prisma.department.count({ where: { organisationId: id } })],
    ["teams", (id) => prisma.team.count({ where: { organisationId: id } })],
    ["policies", (id) => prisma.policy.count({ where: { organisationId: id } })],
    ["policy_versions", (id) => prisma.policyVersion.count({ where: { policy: { organisationId: id } } })],
    ["policy_assignments", (id) => prisma.policyAssignment.count({ where: { organisationId: id } })],
    ["break_policies", (id) => prisma.breakPolicy.count({ where: { organisationId: id } })],
    ["break_policy_assignments", (id) => prisma.breakPolicyAssignment.count({ where: { organisationId: id } })],
    ["employees", (id) => prisma.employee.count({ where: { organisationId: id } })],
    ["employee_teams", (id) => prisma.employeeTeam.count({ where: { employee: { organisationId: id } } })],
    ["employee_invites", (id) => prisma.employeeInvite.count({ where: { organisationId: id } })],
    ["employee_user_links", (id) => prisma.employeeUserLink.count({ where: { employee: { organisationId: id } } })],
    ["devices", (id) => prisma.device.count({ where: { organisationId: id } })],
    ["employee_work_states", (id) => prisma.employeeWorkState.count({ where: { employee: { organisationId: id } } })],
    ["shifts", (id) => prisma.shift.count({ where: { organisationId: id } })],
    ["shifts (COMPLETED)", (id) => prisma.shift.count({ where: { organisationId: id, status: "COMPLETED" } })],
    ["scheduled_breaks", (id) => prisma.scheduledBreak.count({ where: { shift: { organisationId: id } } })],
    ["break_sessions", (id) => prisma.breakSession.count({ where: { organisationId: id } })],
    ["shift_imports", (id) => prisma.shiftImport.count({ where: { organisationId: id } })],
    ["shift_import_rows", (id) => prisma.shiftImportRow.count({ where: { import: { organisationId: id } } })],
    ["integrations", (id) => prisma.integration.count({ where: { organisationId: id } })],
    ["manager_overrides", (id) => prisma.managerOverride.count({ where: { organisationId: id } })],
    ["activity_events", (id) => prisma.activityEvent.count({ where: { organisationId: id } })],
    ["notifications", (id) => prisma.notification.count({ where: { organisationId: id } })],
    ["audit_logs", (id) => prisma.auditLog.count({ where: { organisationId: id } })],
  ];
  const rows: CountRow[] = [];
  for (const [table, count] of counters) {
    rows.push({ table, counts: await Promise.all(organisations.map((o) => count(o.id))) });
  }
  return rows;
}

function pad(value: string, width: number, align: "left" | "right" = "left"): string {
  return align === "left" ? value.padEnd(width) : value.padStart(width);
}

export function formatCountTable(organisations: readonly CountedOrganisation[], rows: readonly CountRow[]): string {
  const first = Math.max("table".length, ...rows.map((r) => r.table.length));
  const widths = organisations.map((o, i) => Math.max(o.label.length, ...rows.map((r) => String(r.counts[i] ?? 0).length)));
  const line = (cells: string[]) => `  ${cells.join("  ")}`;
  const header = line([pad("table", first), ...organisations.map((o, i) => pad(o.label, widths[i] ?? 0, "right"))]);
  const rule = line([
    "-".repeat(first),
    ...organisations.map((_, i) => "-".repeat(widths[i] ?? 0)),
  ]);
  const body = rows.map((r) =>
    line([pad(r.table, first), ...r.counts.map((c, i) => pad(String(c), widths[i] ?? 0, "right"))]),
  );
  return [header, rule, ...body].join("\n");
}

export function formatEmployeeTable(employees: readonly EmployeeSummary[]): string {
  const columns: Array<[keyof EmployeeSummary, string]> = [
    ["name", "employee"],
    ["inviteStatus", "lifecycle"],
    ["badge", "badge"],
    ["state", "state"],
    ["expected", "expected"],
    ["workPolicy", "work policy"],
    ["breakPolicy", "break policy"],
  ];
  const widths = columns.map(([key, label]) => Math.max(label.length, ...employees.map((e) => e[key].length)));
  const line = (cells: string[]) => `  ${cells.join("  ")}`;
  const header = line(columns.map(([, label], i) => pad(label, widths[i] ?? 0)));
  const rule = line(columns.map((_, i) => "-".repeat(widths[i] ?? 0)));
  const body = employees.map((e) => line(columns.map(([key], i) => pad(e[key], widths[i] ?? 0))));
  return [header, rule, ...body].join("\n");
}
