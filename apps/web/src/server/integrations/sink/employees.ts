import { Prisma } from "@clockoff/db";
import {
  countPlandayNames,
  decideEmployeeAction,
  decideEmployeeStatusAction,
  decideImportAction,
  decideReactivation,
  employeeDecisionInputs,
  employeeNameKey,
  hashDecisionInputs,
  indexEmployeeCandidates,
  isEmployeeInScope,
  mappedLocationIds,
  mappedTeamIds,
  matchExternalEmployee,
  matchFromPendingFields,
  pendingMatchFields,
  plandayEmployeeExternalId,
  resolveEmployeeTargets,
  selectAbsentEmployeeRechecks,
  type EmployeeCandidate,
  type EmployeeMappingConfig,
  type EmployeeMapRow,
  type EmployeeMatch,
  type EmployeeResolution,
  type EmployeeSelection,
  type EmployeeStatusEvidence,
  type EmployeeTargets,
  type ExistingEmployee,
  type PendingMatchFields,
} from "@clockoff/integrations";
import type { PendingExternalEmployeeReason } from "@clockoff/shared/enums";
import { AppError } from "@clockoff/shared/errors";
import { remainingCapacity, UNLIMITED } from "@clockoff/shared/plans";
import type { ExternalEmployee } from "@clockoff/shared/providers/workforceProvider";
import { plandayOnboardingStateSchema } from "@clockoff/validation/planday";
import {
  deactivateManagedEmployee,
  importExternalEmployee,
  importExternalEmployees,
  linkExternalEmployee,
  reactivateManagedEmployee,
  updateManagedEmployee,
  type ImportExternalEmployeeInput,
  type ManagedEmployeeFields,
  type ManagedEmployeeMemberships,
} from "@/server/employees/employees.integration";
import { DATABASE_PHASE_BATCH_SIZE } from "../runs/constants";
import type { DatabasePhaseStepResult, SinkContext } from "./context";
import {
  findMapRows,
  recordMapRows,
  setUpstreamRemoved,
  type MapRow,
} from "./entityMaps.repository";

/**
 * Employees (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §6.5): staging for the wizard (DIRECTORY's EMPLOYEES,
 * MATCH_EMPLOYEES), the step 5 import (IMPORT_EMPLOYEES's APPLY_EMPLOYEES) and the SYNC phases (EMPLOYEES,
 * DEACTIVATED_EMPLOYEES, ABSENT_EMPLOYEES, REACTIVATIONS). Every decision is the pure function of
 * `core/employeeDecisions.ts`; this module loads the batch's state in a few queries and performs the writes the
 * decisions ask for through `employees.integration.ts`.
 *
 * Data minimisation: out-of-scope people are counted and never written anywhere (no pending row, no warning, no
 * log); a pending row exists only while a person waits for a manager; emails are stored only while
 * `importEmails` is on (during the wizard the pending row keeps Planday's email until step 5 decides, D-042).
 */

type Tx = Prisma.TransactionClient;

// ── Shared loading ───────────────────────────────────────────────────────────

function employeeConfig(ctx: SinkContext): EmployeeMappingConfig {
  return {
    includedDepartmentIds: ctx.config.includedDepartmentIds,
    excludedEmployeeIds: ctx.config.excludedEmployeeIds,
    departmentMappings: ctx.config.departmentMappings,
    groupMappings: ctx.config.groupMappings,
    autoIncludeNewEmployees: ctx.config.autoIncludeNewEmployees,
    importEmails: ctx.config.importEmails,
  };
}

/** Every live employee of the organisation as the matcher sees it, with this integration's EMPLOYEE map rows. */
async function loadCandidates(tx: Tx, ctx: SinkContext): Promise<EmployeeCandidate[]> {
  const [employees, maps] = await Promise.all([
    tx.employee.findMany({
      where: { organisationId: ctx.organisationId, deletedAt: null },
      select: { id: true, firstName: true, lastName: true, email: true, externalEmployeeId: true },
    }),
    tx.externalEntityMap.findMany({
      where: { integrationId: ctx.integrationId, entityType: "EMPLOYEE" },
      select: { externalId: true, internalId: true },
    }),
  ]);
  const mapped = new Map(maps.map((m) => [m.internalId, m.externalId] as const));
  return employees.map((e) => ({ ...e, mappedExternalId: mapped.get(e.id) ?? null }));
}

/** The ClockOff employees (managed fields and memberships) for the decisions. Archived ones are left out. */
async function loadExistingEmployees(
  tx: Tx,
  organisationId: string,
  ids: readonly string[],
): Promise<Map<string, ExistingEmployee & { managedByIntegrationId: string | null }>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await tx.employee.findMany({
    where: { organisationId, id: { in: unique }, deletedAt: null },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      externalEmployeeId: true,
      primaryLocationId: true,
      departmentId: true,
      employmentStatus: true,
      managedByIntegrationId: true,
      locations: { select: { locationId: true } },
      teams: { select: { teamId: true } },
    },
  });
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        firstName: r.firstName,
        lastName: r.lastName,
        email: r.email,
        externalEmployeeId: r.externalEmployeeId,
        primaryLocationId: r.primaryLocationId,
        departmentId: r.departmentId,
        employmentStatus: r.employmentStatus,
        managedByIntegrationId: r.managedByIntegrationId,
        locationIds: r.locations.map((l) => l.locationId),
        teamIds: r.teams.map((t) => t.teamId),
      },
    ]),
  );
}

/** Employees the plan can still take (Infinity when unlimited). */
async function capacityRemaining(tx: Tx, ctx: SinkContext): Promise<number> {
  const active = await tx.employee.count({
    where: { organisationId: ctx.organisationId, deletedAt: null, employmentStatus: "ACTIVE" },
  });
  const remaining = remainingCapacity(ctx.plan, "employees", active);
  return remaining === UNLIMITED ? Number.POSITIVE_INFINITY : remaining;
}

function toMapShape(row: MapRow): EmployeeMapRow {
  return {
    internalId: row.internalId,
    lastHash: row.lastHash,
    upstreamRemovedAt: row.upstreamRemovedAt,
    upstreamMissingSince: row.upstreamMissingSince,
    reviewDismissedAt: row.reviewDismissedAt,
  };
}

/** The writer's managed fields: email only with `importEmails` and when Planday has one (never erased). */
function managedFields(
  external: Pick<ExternalEmployee, "firstName" | "lastName" | "email">,
  targets: EmployeeTargets,
  importEmails: boolean,
): ManagedEmployeeFields {
  const email = external.email?.trim();
  return {
    firstName: external.firstName.trim(),
    lastName: external.lastName.trim(),
    primaryLocationId: targets.primaryLocationId,
    ...(importEmails && email ? { email } : {}),
    ...(targets.departmentId !== null ? { departmentId: targets.departmentId } : {}),
  };
}

function managedMemberships(
  config: Pick<
    EmployeeMappingConfig,
    "departmentMappings" | "groupMappings" | "includedDepartmentIds"
  >,
  targets: EmployeeTargets,
): ManagedEmployeeMemberships {
  return {
    mappedLocationIds: mappedLocationIds(config.departmentMappings, config.includedDepartmentIds),
    locationIds: targets.locationIds,
    mappedTeamIds: mappedTeamIds(config.groupMappings),
    teamIds: targets.teamIds,
  };
}

// ── Pending rows ─────────────────────────────────────────────────────────────

interface PendingRowInput {
  externalId: string;
  firstName: string;
  lastName: string;
  /** Null when Planday has none, or when `importEmails` is off after onboarding. */
  workEmail: string | null;
  hasEmail: boolean;
  externalDepartmentIds: readonly string[];
  primaryExternalDepartmentId: string | null;
  externalGroupIds: readonly string[];
  reason: PendingExternalEmployeeReason;
  match: PendingMatchFields;
}

/**
 * Upserts pending rows in one statement. `keepMatch` (wizard staging) keeps the stored match columns and reason,
 * which MATCH_EMPLOYEES recomputes over the complete staged set. Returns how many rows were new.
 */
async function upsertPendingRows(
  tx: Tx,
  ctx: SinkContext,
  rows: readonly PendingRowInput[],
  options: { keepMatch: boolean },
): Promise<number> {
  if (rows.length === 0) return 0;
  const values = Prisma.join(
    rows.map(
      (r) => Prisma.sql`(${ctx.organisationId}::uuid, ${ctx.integrationId}::uuid,
        ${ctx.provider}::"IntegrationProvider", ${r.externalId}, ${r.firstName}, ${r.lastName},
        ${r.workEmail}::citext, ${r.hasEmail}, ${[...r.externalDepartmentIds]}::text[],
        ${r.primaryExternalDepartmentId}, ${[...r.externalGroupIds]}::text[],
        ${r.reason}::"PendingExternalEmployeeReason", ${r.match.matchedEmployeeId}::uuid,
        ${r.match.matchSignal}, ${[...r.match.candidateEmployeeIds]}::uuid[],
        ${ctx.now}::timestamptz, ${ctx.now}::timestamptz, now())`,
    ),
  );
  const matchUpdate = options.keepMatch
    ? Prisma.empty
    : Prisma.sql`, reason = EXCLUDED.reason, matched_employee_id = EXCLUDED.matched_employee_id,
        match_signal = EXCLUDED.match_signal, candidate_employee_ids = EXCLUDED.candidate_employee_ids`;
  const result = await tx.$queryRaw<Array<{ inserted: boolean }>>`
    INSERT INTO pending_external_employees
      (organisation_id, integration_id, provider, external_id, first_name, last_name, work_email, has_email,
       external_department_ids, primary_external_department_id, external_group_ids, reason,
       matched_employee_id, match_signal, candidate_employee_ids, first_seen_at, last_seen_at, updated_at)
    VALUES ${values}
    ON CONFLICT (integration_id, external_id) DO UPDATE SET
      first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, work_email = EXCLUDED.work_email,
      has_email = EXCLUDED.has_email, external_department_ids = EXCLUDED.external_department_ids,
      primary_external_department_id = EXCLUDED.primary_external_department_id,
      external_group_ids = EXCLUDED.external_group_ids, last_seen_at = EXCLUDED.last_seen_at,
      updated_at = now() ${matchUpdate}
    RETURNING (xmax = 0) AS inserted`;
  return result.filter((r) => r.inserted).length;
}

async function deletePendingRows(
  tx: Tx,
  ctx: SinkContext,
  externalIds: readonly string[],
  options: { reasons?: readonly PendingExternalEmployeeReason[]; exceptMissing?: boolean } = {},
): Promise<void> {
  const ids = [...new Set(externalIds)];
  if (ids.length === 0) return;
  await tx.pendingExternalEmployee.deleteMany({
    where: {
      integrationId: ctx.integrationId,
      externalId: { in: ids },
      ...(options.reasons ? { reason: { in: [...options.reasons] } } : {}),
      ...(options.exceptMissing ? { reason: { not: "MISSING_IN_PLANDAY" } } : {}),
    },
  });
}

function pendingRowFor(
  external: ExternalEmployee,
  reason: PendingExternalEmployeeReason,
  match: PendingMatchFields,
  keepEmail: boolean,
): PendingRowInput {
  const email = external.email?.trim() ? external.email.trim() : null;
  const departments = [...new Set(external.externalLocationIds ?? [])];
  return {
    externalId: external.externalId,
    firstName: external.firstName.trim(),
    lastName: external.lastName.trim(),
    workEmail: keepEmail ? email : null,
    hasEmail: email !== null,
    externalDepartmentIds: departments,
    primaryExternalDepartmentId: external.primaryExternalLocationId ?? null,
    externalGroupIds: [...new Set(external.externalTeamIds ?? [])],
    reason,
    match,
  };
}

const NO_MATCH: PendingMatchFields = {
  matchedEmployeeId: null,
  matchSignal: null,
  candidateEmployeeIds: [],
};

// ── DIRECTORY: EMPLOYEES (staging) ───────────────────────────────────────────

/** Stages one page of the wizard's directory: in-scope people become `PendingExternalEmployee(ONBOARDING)`. */
export async function stageEmployees(
  tx: Tx,
  ctx: SinkContext,
  records: readonly ExternalEmployee[],
): Promise<void> {
  const config = employeeConfig(ctx);
  const stage: PendingRowInput[] = [];
  const drop: string[] = [];
  for (const external of records) {
    const decision = decideEmployeeAction({
      external,
      match: { kind: "NONE" },
      mapRow: null,
      employee: null,
      config,
      phase: "DIRECTORY",
      portalId: ctx.portalId,
    });
    if (decision.action === "STAGE") {
      // The wizard shows Planday's email until step 5 decides whether emails are imported (D-042).
      stage.push(pendingRowFor(external, "ONBOARDING", NO_MATCH, true));
    } else if (decision.action === "OUT_OF_SCOPE" || decision.action === "IGNORE_DISMISSED") {
      if (decision.action === "OUT_OF_SCOPE") ctx.tally.exclude("outOfScope");
      drop.push(external.externalId);
    }
  }
  await deletePendingRows(tx, ctx, drop);
  await upsertPendingRows(tx, ctx, stage, { keepMatch: true });
}

/** DIRECTORY's FINALISE: staged people the run no longer saw (gone from Planday, or out of scope) are purged. */
export async function purgeStaleStagedEmployees(tx: Tx, ctx: SinkContext): Promise<void> {
  await tx.pendingExternalEmployee.deleteMany({
    where: {
      integrationId: ctx.integrationId,
      reason: "ONBOARDING",
      lastSeenAt: { lt: new Date(ctx.state.startedAt) },
    },
  });
}

// ── DIRECTORY: MATCH_EMPLOYEES (database only) ──────────────────────────────

function namesakeKey(ctx: SinkContext, key: string): string {
  return ctx.hasher(`planday-namesake:${key}`).slice(0, 32);
}

/**
 * Entering MATCH_EMPLOYEES: name counts over the complete staged set, kept as hashed keys of the names more than one
 * staged person has (never a name in the run's cursor).
 */
export async function prepareEmployeeMatching(tx: Tx, ctx: SinkContext): Promise<void> {
  const rows = await tx.pendingExternalEmployee.findMany({
    where: { integrationId: ctx.integrationId, reason: "ONBOARDING" },
    select: { firstName: true, lastName: true },
  });
  const counts = countPlandayNames(rows);
  const namesakes: Record<string, number> = {};
  for (const [key, count] of Object.entries(counts)) {
    if (count > 1) namesakes[namesakeKey(ctx, key)] = count;
  }
  ctx.state.namesakes = namesakes;
  ctx.state.matchPass = "MATCH";
}

/**
 * One batch of MATCH_EMPLOYEES (§6.5, wizard): rules 1 to 6 over the staged rows with the complete set's name counts,
 * then a second pass that turns matches two staged people share into AMBIGUOUS (`resolveDuplicateMatches` over the
 * complete set), so a link can never fold two people into one employee.
 */
export async function matchEmployeesStep(
  tx: Tx,
  ctx: SinkContext,
  cursor: Readonly<Record<string, unknown>>,
): Promise<DatabasePhaseStepResult> {
  if (ctx.state.matchPass === "DEDUPE") {
    await tx.$executeRaw`
      UPDATE pending_external_employees p
         SET candidate_employee_ids = ARRAY[p.matched_employee_id], matched_employee_id = NULL,
             match_signal = NULL, updated_at = now()
       WHERE p.integration_id = ${ctx.integrationId}::uuid AND p.reason = 'ONBOARDING'
         AND p.matched_employee_id IN (
           SELECT matched_employee_id FROM pending_external_employees
            WHERE integration_id = ${ctx.integrationId}::uuid AND reason = 'ONBOARDING'
              AND matched_employee_id IS NOT NULL
            GROUP BY matched_employee_id HAVING count(*) > 1)`;
    return { done: true, cursor: {} };
  }
  const afterId = typeof cursor.afterId === "string" ? cursor.afterId : null;
  const rows = await tx.pendingExternalEmployee.findMany({
    where: {
      integrationId: ctx.integrationId,
      reason: "ONBOARDING",
      ...(afterId ? { id: { gt: afterId } } : {}),
    },
    orderBy: { id: "asc" },
    take: DATABASE_PHASE_BATCH_SIZE,
    select: { id: true, externalId: true, firstName: true, lastName: true, workEmail: true },
  });
  if (rows.length > 0) {
    const index = indexEmployeeCandidates(await loadCandidates(tx, ctx));
    const namesakes = ctx.state.namesakes ?? {};
    const updates = rows.map((row) => {
      const key = employeeNameKey(row.firstName, row.lastName);
      const count = namesakes[namesakeKey(ctx, key)] ?? 1;
      const match = matchExternalEmployee(
        {
          externalId: row.externalId,
          firstName: row.firstName,
          lastName: row.lastName,
          email: row.workEmail,
        },
        index,
        { [key]: count },
        { portalId: ctx.portalId, mode: "WIZARD" },
      );
      return { id: row.id, fields: pendingMatchFields(match) };
    });
    const values = Prisma.join(
      updates.map(
        (u) =>
          Prisma.sql`(${u.id}::uuid, ${u.fields.matchedEmployeeId}::uuid, ${u.fields.matchSignal}::text,
            ${[...u.fields.candidateEmployeeIds]}::uuid[])`,
      ),
    );
    await tx.$executeRaw`
      UPDATE pending_external_employees p
         SET matched_employee_id = v.matched, match_signal = v.signal, candidate_employee_ids = v.candidates,
             updated_at = now()
        FROM (VALUES ${values}) AS v(id, matched, signal, candidates)
       WHERE p.id = v.id`;
  }
  if (rows.length < DATABASE_PHASE_BATCH_SIZE) {
    ctx.state.matchPass = "DEDUPE";
    return { done: false, cursor: {} };
  }
  return { done: false, cursor: { afterId: rows[rows.length - 1]!.id } };
}

// ── IMPORT_EMPLOYEES: APPLY_EMPLOYEES (database only) ───────────────────────

interface StepFiveChoices {
  sessionId: string;
  selection: EmployeeSelection;
  resolutions: Map<string, EmployeeResolution>;
  importEmails: boolean;
}

async function loadStepFiveChoices(tx: Tx, ctx: SinkContext): Promise<StepFiveChoices> {
  const session = await tx.integrationOnboardingSession.findFirst({
    where: {
      integrationId: ctx.integrationId,
      organisationId: ctx.organisationId,
      status: "ACTIVE",
    },
    select: { id: true, state: true },
  });
  const state = session ? plandayOnboardingStateSchema.safeParse(session.state) : null;
  const employees = state?.success ? state.data.employees : undefined;
  if (!session || !employees) {
    throw new AppError(
      "INTEGRATION_ONBOARDING_INCOMPLETE",
      "The employee selection (wizard step 5) has not been saved",
    );
  }
  return {
    sessionId: session.id,
    selection: employees.selection,
    resolutions: new Map(
      employees.resolutions.map((r) => [
        r.externalId,
        r.action === "LINK" ? { action: "LINK", employeeId: r.employeeId } : { action: r.action },
      ]),
    ),
    importEmails: employees.importEmails,
  };
}

function externalFromPending(row: {
  externalId: string;
  firstName: string;
  lastName: string;
  workEmail: string | null;
  externalDepartmentIds: string[];
  primaryExternalDepartmentId: string | null;
  externalGroupIds: string[];
}): ExternalEmployee {
  return {
    externalId: row.externalId,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.workEmail,
    externalLocationIds: row.externalDepartmentIds,
    externalTeamIds: row.externalGroupIds,
    primaryExternalLocationId: row.primaryExternalDepartmentId,
    active: true,
  };
}

/**
 * One batch of APPLY_EMPLOYEES (§6.5 "IMPORT_EMPLOYEES"): the staged rows with the manager's step 5 choices. Selected
 * new people are imported, matched or manager-linked ones linked, unticked or excluded ids appended to
 * `excludedEmployeeIds`; each resolved pending row is deleted in the same transaction. What the session imported is
 * recorded in its `employeesImport` (for release, §9.3).
 */
export async function applyEmployeesImportStep(
  tx: Tx,
  ctx: SinkContext,
  cursor: Readonly<Record<string, unknown>>,
): Promise<DatabasePhaseStepResult> {
  const choices = await loadStepFiveChoices(tx, ctx);
  const config: EmployeeMappingConfig = {
    ...employeeConfig(ctx),
    importEmails: choices.importEmails,
  };
  const afterId = typeof cursor.afterId === "string" ? cursor.afterId : null;
  const rows = await tx.pendingExternalEmployee.findMany({
    where: {
      integrationId: ctx.integrationId,
      reason: { not: "MISSING_IN_PLANDAY" },
      ...(afterId ? { id: { gt: afterId } } : {}),
    },
    orderBy: { id: "asc" },
    take: DATABASE_PHASE_BATCH_SIZE,
  });
  const done = rows.length < DATABASE_PHASE_BATCH_SIZE;
  const next = done ? {} : { afterId: rows[rows.length - 1]!.id };
  if (rows.length === 0) return { done, cursor: next };

  const actor = { organisationId: ctx.organisationId, integrationId: ctx.integrationId };
  const mapRows = await findMapRows(
    tx,
    ctx.integrationId,
    ["EMPLOYEE"],
    rows.map((r) => r.externalId),
  );
  const mappedEmployees = await loadExistingEmployees(
    tx,
    ctx.organisationId,
    [...mapRows.values()].map((m) => m.internalId),
  );
  const linkedTargets = new Set(
    (
      await tx.externalEntityMap.findMany({
        where: { integrationId: ctx.integrationId, entityType: "EMPLOYEE" },
        select: { internalId: true },
      })
    ).map((m) => m.internalId),
  );
  let capacity = await capacityRemaining(tx, ctx);
  const excluded: string[] = [];
  const included: string[] = [];
  const resolved: string[] = [];
  const createdIds: string[] = [];
  const linkedIds: string[] = [];
  const imports: ImportExternalEmployeeInput[] = [];
  const hashes: Array<{ id: string; lastHash: string | null }> = [];
  const pendingReasons: Array<{ id: string; reason: "PLAN_LIMIT" | "AMBIGUOUS_MATCH" }> = [];

  for (const row of rows) {
    const external = externalFromPending(row);
    const targets = resolveEmployeeTargets(external, config);
    const hash = hashDecisionInputs(ctx.hasher, employeeDecisionInputs(external, targets, config));
    const mapRow = mapRows.get(row.externalId) ?? null;
    const mappedEmployee = mapRow ? (mappedEmployees.get(mapRow.internalId) ?? null) : null;
    const decision = decideImportAction({
      externalId: row.externalId,
      match: matchFromPendingFields(row),
      selection: choices.selection,
      resolution: choices.resolutions.get(row.externalId) ?? null,
      mapped: mappedEmployee !== null,
      capacityRemaining: capacity,
    });
    const fields = managedFields(external, targets, config.importEmails);
    const memberships = managedMemberships(config, targets);
    switch (decision.action) {
      case "EXCLUDE":
        excluded.push(row.externalId);
        resolved.push(row.id);
        break;
      case "ALREADY_LINKED":
        if (mappedEmployee && mappedEmployee.managedByIntegrationId === ctx.integrationId) {
          await updateManagedEmployee(tx, actor, {
            employeeId: mappedEmployee.id,
            fields,
            memberships,
          });
          if (mapRow) hashes.push({ id: mapRow.id, lastHash: hash });
          ctx.tally.count("employees", "updated");
        }
        included.push(row.externalId);
        resolved.push(row.id);
        break;
      case "IMPORT":
        imports.push({
          externalId: row.externalId,
          externalEmployeeId: plandayEmployeeExternalId(ctx.portalId, row.externalId),
          fields: { ...fields, email: config.importEmails ? (fields.email ?? null) : null },
          memberships,
          lastHash: hash,
        });
        capacity -= 1;
        included.push(row.externalId);
        resolved.push(row.id);
        break;
      case "LINK":
        if (linkedTargets.has(decision.employeeId)) {
          // Another Planday person is already linked to this employee: never fold two people into one.
          pendingReasons.push({ id: row.id, reason: "AMBIGUOUS_MATCH" });
          ctx.tally.warn(
            "EMPLOYEE_ALREADY_LINKED",
            "A Planday employee was not linked: the chosen ClockOff employee is already linked to another Planday employee",
            row.externalId,
          );
          break;
        }
        await linkExternalEmployee(
          tx,
          actor,
          {
            employeeId: decision.employeeId,
            externalId: row.externalId,
            externalEmployeeId: plandayEmployeeExternalId(ctx.portalId, row.externalId),
            fields,
            memberships,
            lastHash: hash,
          },
          ctx.now,
        );
        linkedTargets.add(decision.employeeId);
        linkedIds.push(decision.employeeId);
        ctx.tally.count("employees", "updated");
        included.push(row.externalId);
        resolved.push(row.id);
        break;
      case "PENDING":
        pendingReasons.push({ id: row.id, reason: decision.reason });
        if (decision.reason === "PLAN_LIMIT") {
          ctx.tally.warn(
            "PLAN_LIMIT",
            "A selected Planday employee was not imported: the plan's employee limit is reached",
            row.externalId,
          );
        }
        break;
    }
  }

  if (imports.length > 0) {
    const { employeeIds } = await importExternalEmployees(tx, actor, imports, ctx.now);
    createdIds.push(...employeeIds);
    ctx.tally.count("employees", "created", employeeIds.length);
  }
  await recordMapRows(tx, { hashed: hashes }, ctx.now);
  if (resolved.length > 0) {
    await tx.pendingExternalEmployee.deleteMany({ where: { id: { in: resolved } } });
  }
  for (const { id, reason } of pendingReasons) {
    await tx.pendingExternalEmployee.update({ where: { id }, data: { reason } });
  }
  await updateExcludedEmployees(tx, ctx, { add: excluded, remove: included });
  if (createdIds.length > 0 || linkedIds.length > 0) {
    await recordSessionImports(tx, choices.sessionId, { createdIds, linkedIds });
  }
  return { done, cursor: next };
}

/** `excludedEmployeeIds`: unticked and excluded ids appended, ids selected again removed (one statement). */
async function updateExcludedEmployees(
  tx: Tx,
  ctx: SinkContext,
  change: { add: readonly string[]; remove: readonly string[] },
): Promise<void> {
  if (change.add.length === 0 && change.remove.length === 0) return;
  await tx.$executeRaw`
    UPDATE integration_mapping_configs
       SET excluded_employee_ids = ARRAY(
             SELECT DISTINCT id FROM unnest(excluded_employee_ids || ${[...change.add]}::text[]) AS id
              WHERE id <> ALL(${[...change.remove]}::text[]) ORDER BY id),
           updated_at = now()
     WHERE integration_id = ${ctx.integrationId}::uuid`;
}

/** Appends to the session's `employeesImport` (§9.3), read-modify-write under the row lock. */
async function recordSessionImports(
  tx: Tx,
  sessionId: string,
  imported: { createdIds: readonly string[]; linkedIds: readonly string[] },
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ state: Prisma.JsonValue }>>`
    SELECT state FROM integration_onboarding_sessions WHERE id = ${sessionId}::uuid FOR UPDATE`;
  const parsed = plandayOnboardingStateSchema.safeParse(rows[0]?.state ?? {});
  if (!parsed.success) throw new Error("The onboarding session state is invalid");
  const previous = parsed.data.employeesImport ?? { createdIds: [], linkedIds: [] };
  const state = {
    ...parsed.data,
    employeesImport: {
      createdIds: [...new Set([...previous.createdIds, ...imported.createdIds])],
      linkedIds: [...new Set([...previous.linkedIds, ...imported.linkedIds])],
    },
  };
  await tx.integrationOnboardingSession.update({
    where: { id: sessionId },
    data: { state: state as unknown as Prisma.InputJsonValue },
  });
}

// ── SYNC: EMPLOYEES ──────────────────────────────────────────────────────────

/**
 * Employees of this page's map rows that a manager archived (`deletedAt` set): `loadExistingEmployees` leaves them
 * out, so without this they would be matched afresh and imported again. One query, only when a map row's employee
 * was not loaded.
 */
async function archivedMappedEmployees(
  tx: Tx,
  ctx: SinkContext,
  mapRows: ReadonlyMap<string, MapRow>,
  loaded: ReadonlyMap<string, unknown>,
): Promise<Set<string>> {
  const missing = [...mapRows.values()].map((m) => m.internalId).filter((id) => !loaded.has(id));
  if (missing.length === 0) return new Set();
  const rows = await tx.employee.findMany({
    where: { organisationId: ctx.organisationId, id: { in: missing }, deletedAt: { not: null } },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

/** ClockOff employees another Planday record linked (or created) earlier in this run (§6.5). */
async function claimedInRun(tx: Tx, ctx: SinkContext): Promise<Set<string>> {
  const rows = await tx.$queryRaw<Array<{ internal_id: string }>>`
    SELECT m.internal_id::text AS internal_id
      FROM external_entity_maps m
      JOIN integration_sync_runs r ON r.id = ${ctx.run.id}::uuid
     WHERE m.integration_id = ${ctx.integrationId}::uuid AND m.entity_type = 'EMPLOYEE'
       AND m.created_at >= COALESCE(r.first_claimed_at, r.created_at)`;
  return new Set(rows.map((r) => r.internal_id));
}

/**
 * One EMPLOYEES page of a SYNC (§6.5 decision table): mapped people get their managed fields (or nothing), new
 * in-scope people are imported, linked or queued for a manager, out-of-scope people are counted and dropped. People
 * the sync deactivated who are on the active list again are queued for REACTIVATIONS (ids only).
 */
export async function applyEmployees(
  tx: Tx,
  ctx: SinkContext,
  records: readonly ExternalEmployee[],
): Promise<void> {
  if (records.length === 0) return;
  const config = employeeConfig(ctx);
  const actor = { organisationId: ctx.organisationId, integrationId: ctx.integrationId };
  const mapRows = await findMapRows(
    tx,
    ctx.integrationId,
    ["EMPLOYEE"],
    records.map((r) => r.externalId),
  );
  let candidates = await loadCandidates(tx, ctx);
  let index = indexEmployeeCandidates(candidates);
  const claimed = await claimedInRun(tx, ctx);
  // A name is never matched from one page alone (§6.5): the page's in-scope people plus every Planday person
  // already waiting in the queue (namesakes the wizard or an earlier page found).
  const inScope = records.filter((r) => isEmployeeInScope(r, config));
  const queued = await tx.pendingExternalEmployee.findMany({
    where: { integrationId: ctx.integrationId, reason: { not: "MISSING_IN_PLANDAY" } },
    select: { externalId: true, firstName: true, lastName: true },
  });
  const pageIds = new Set(inScope.map((r) => r.externalId));
  const nameCounts = countPlandayNames([
    ...inScope,
    ...queued.filter((row) => !pageIds.has(row.externalId)),
  ]);

  // Rules 1 to 3 per page; then load the employees the decisions read (mapped and matched ones).
  const matches = new Map<string, EmployeeMatch>();
  for (const external of records) {
    matches.set(
      external.externalId,
      matchExternalEmployee(external, index, nameCounts, {
        portalId: ctx.portalId,
        mode: "SYNC",
        claimedEmployeeIds: claimed,
      }),
    );
  }
  const referenced = [
    ...[...mapRows.values()].map((m) => m.internalId),
    ...[...matches.values()].flatMap((m) =>
      m.kind === "MAPPED" || m.kind === "MATCHED" ? [m.employeeId] : [],
    ),
  ];
  const employees = await loadExistingEmployees(tx, ctx.organisationId, referenced);
  const archived = await archivedMappedEmployees(tx, ctx, mapRows, employees);
  let capacity = await capacityRemaining(tx, ctx);

  const touch: string[] = [];
  const hashes: Array<{ id: string; lastHash: string | null }> = [];
  const clearMissing: MapRow[] = [];
  const drop: string[] = [];
  const pending: PendingRowInput[] = [];
  const resolvedPending: string[] = [];

  for (const external of records) {
    const mapRow = mapRows.get(external.externalId) ?? null;
    const mapped = mapRow ? (employees.get(mapRow.internalId) ?? null) : null;
    if (mapRow && !mapped && archived.has(mapRow.internalId)) {
      // A manager archived (removed) this Planday employee in ClockOff. Importing them again would undo that and move
      // their shifts to a duplicate; their shifts resolve as not mapped (OUT_OF_SCOPE, §6.6) instead. Counted as
      // skipped without a warning: the archive is the manager's deliberate, audited choice, and a warning on every
      // run would leave every SYNC "Finished with warnings" for as long as Planday keeps the person.
      touch.push(mapRow.id);
      ctx.tally.count("employees", "skipped");
      continue;
    }
    // An earlier record of this page may have linked or created the candidate (a shared email): match again.
    const match: EmployeeMatch = mapped
      ? { kind: "MAPPED", employeeId: mapped.id }
      : matchExternalEmployee(external, index, nameCounts, {
          portalId: ctx.portalId,
          mode: "SYNC",
          claimedEmployeeIds: claimed,
        });
    const employee =
      mapped ?? (match.kind === "MATCHED" ? (employees.get(match.employeeId) ?? null) : null);
    const targets = resolveEmployeeTargets(external, config);
    const hash = hashDecisionInputs(ctx.hasher, employeeDecisionInputs(external, targets, config));
    const decision = decideEmployeeAction({
      external,
      match,
      mapRow: mapRow && mapped ? toMapShape(mapRow) : null,
      employee,
      config,
      phase: "SYNC",
      portalId: ctx.portalId,
      hash,
      capacityRemaining: capacity,
    });
    if (decision.clearMissing && mapRow) clearMissing.push(mapRow);
    if (decision.warning === "EMPLOYEE_OUT_OF_SCOPE") {
      ctx.tally.warn(
        "EMPLOYEE_OUT_OF_SCOPE",
        "A linked Planday employee is no longer in an included department; kept as they are",
        external.externalId,
      );
    }
    const fields = managedFields(external, targets, config.importEmails);
    const memberships = managedMemberships(config, targets);

    switch (decision.action) {
      case "OUT_OF_SCOPE":
        ctx.tally.exclude("outOfScope");
        drop.push(external.externalId);
        break;
      case "IGNORE_DISMISSED":
        drop.push(external.externalId);
        break;
      case "STAGE":
        break;
      case "UNCHANGED":
      case "KEEP_OUT_OF_SCOPE":
        if (mapRow) touch.push(mapRow.id);
        ctx.tally.count("employees", "skipped");
        break;
      case "REHASH_ONLY":
        if (mapRow) hashes.push({ id: mapRow.id, lastHash: hash });
        ctx.tally.count("employees", "skipped");
        break;
      case "UPDATE":
        await updateManagedEmployee(tx, actor, {
          employeeId: mapped!.id,
          fields,
          memberships,
        });
        if (mapRow) hashes.push({ id: mapRow.id, lastHash: hash });
        ctx.tally.count("employees", "updated");
        break;
      case "QUEUE_REACTIVATION":
        if (decision.update && mapped) {
          await updateManagedEmployee(tx, actor, { employeeId: mapped.id, fields, memberships });
        }
        if (mapRow) hashes.push({ id: mapRow.id, lastHash: hash });
        if (!ctx.state.reactivate.includes(external.externalId)) {
          ctx.state.reactivate.push(external.externalId);
        }
        break;
      case "IMPORT": {
        const { employeeId } = await importExternalEmployee(
          tx,
          actor,
          {
            externalId: external.externalId,
            externalEmployeeId: decision.create.externalEmployeeId,
            fields: { ...fields, email: decision.create.email },
            memberships,
            lastHash: hash,
          },
          ctx.now,
        );
        capacity -= 1;
        claimed.add(employeeId);
        candidates = [
          ...candidates,
          {
            id: employeeId,
            firstName: decision.create.firstName,
            lastName: decision.create.lastName,
            email: external.email ?? null,
            externalEmployeeId: decision.create.externalEmployeeId,
            mappedExternalId: external.externalId,
          },
        ];
        index = indexEmployeeCandidates(candidates);
        resolvedPending.push(external.externalId);
        ctx.tally.count("employees", "created");
        break;
      }
      case "LINK": {
        await linkExternalEmployee(
          tx,
          actor,
          {
            employeeId: decision.employeeId,
            externalId: external.externalId,
            externalEmployeeId: plandayEmployeeExternalId(ctx.portalId, external.externalId),
            fields,
            memberships,
            lastHash: hash,
          },
          ctx.now,
        );
        claimed.add(decision.employeeId);
        candidates = candidates.map((c) =>
          c.id === decision.employeeId ? { ...c, mappedExternalId: external.externalId } : c,
        );
        index = indexEmployeeCandidates(candidates);
        resolvedPending.push(external.externalId);
        ctx.tally.count("employees", "updated");
        break;
      }
      case "PENDING":
        pending.push(pendingRowFor(external, decision.reason, decision.match, config.importEmails));
        break;
    }
  }

  await deletePendingRows(tx, ctx, [...drop, ...resolvedPending], { exceptMissing: true });
  if (clearMissing.length > 0) {
    await tx.externalEntityMap.updateMany({
      where: { id: { in: clearMissing.map((m) => m.id) } },
      data: { upstreamMissingSince: null, reviewDismissedAt: null },
    });
    await deletePendingRows(
      tx,
      ctx,
      clearMissing.map((m) => m.externalId),
      { reasons: ["MISSING_IN_PLANDAY"] },
    );
  }
  ctx.state.newPending += await upsertPendingRows(tx, ctx, pending, { keepMatch: false });
  await recordMapRows(tx, { touched: touch, hashed: hashes }, ctx.now);
}

// ── SYNC: DEACTIVATED_EMPLOYEES and ABSENT_EMPLOYEES ─────────────────────────

/**
 * One EMPLOYEE_STATUS batch (§6.5): positive evidence deactivates (D-045); a future dismissal changes nothing (one
 * DEACTIVATION_SCHEDULED warning per run); a by-id read without evidence flags the person missing (devices
 * untouched). Every id goes into the run's lists, so ABSENT_EMPLOYEES never re-checks it and REACTIVATIONS never
 * undoes a deactivation of the same run.
 */
export async function applyEmployeeStatus(
  tx: Tx,
  ctx: SinkContext,
  phase: "DEACTIVATED_EMPLOYEES" | "ABSENT_EMPLOYEES",
  records: ReadonlyArray<{ externalId: string; status: EmployeeStatusEvidence }>,
): Promise<void> {
  if (records.length === 0) return;
  const state = ctx.state;
  const mapRows = await findMapRows(
    tx,
    ctx.integrationId,
    ["EMPLOYEE"],
    records.map((r) => r.externalId),
  );
  // The run's lists (kept in the cursor until the run ends) hold mapped ids only: their readers (ABSENT_EMPLOYEES'
  // selection, REACTIVATIONS) only ever look up mapped people, and an unmapped Planday id is not persisted (§6.5).
  for (const record of records) {
    if (!mapRows.has(record.externalId)) continue;
    if (phase === "DEACTIVATED_EMPLOYEES" && !state.listed.includes(record.externalId)) {
      state.listed.push(record.externalId);
    }
    if (record.status === "DEACTIVATED" && !state.listedDeactivated.includes(record.externalId)) {
      state.listedDeactivated.push(record.externalId);
    }
  }
  const employees = await loadExistingEmployees(
    tx,
    ctx.organisationId,
    [...mapRows.values()].map((m) => m.internalId),
  );
  const dropPending: string[] = [];
  /** Map rows re-checked without positive evidence. */
  const missingSince: string[] = [];
  const deactivated: string[] = [];
  for (const record of records) {
    const mapRow = mapRows.get(record.externalId) ?? null;
    const employee = mapRow ? (employees.get(mapRow.internalId) ?? null) : null;
    const decision = decideEmployeeStatusAction({
      phase,
      status: record.status,
      mapRow: mapRow && employee ? toMapShape(mapRow) : null,
      employee,
    });
    switch (decision.action) {
      case "IGNORE":
        if (decision.dropPending) dropPending.push(record.externalId);
        break;
      case "UNCHANGED":
        if (decision.warning === "DEACTIVATION_SCHEDULED" && !state.scheduledDeactivationWarned) {
          state.scheduledDeactivationWarned = true;
          ctx.tally.warn(
            "DEACTIVATION_SCHEDULED",
            "A Planday employee has a dismissal date in the future; they stay active until it has passed",
          );
        }
        break;
      case "DEACTIVATE": {
        const result = await deactivateManagedEmployee(tx, {
          organisationId: ctx.organisationId,
          employeeId: employee!.id,
          integrationId: ctx.integrationId,
          now: ctx.now,
          reason: decision.reason,
        });
        ctx.effects.employeeWrites.push(result);
        if (result.changed) ctx.tally.count("employees", "cancelled");
        if (mapRow) deactivated.push(mapRow.id);
        break;
      }
      case "MARK_MISSING":
        // Every re-check is stamped (the rotation below); `upstream_missing_since` is set only when null.
        if (mapRow) missingSince.push(mapRow.id);
        ctx.tally.warn(
          "EMPLOYEE_NOT_VISIBLE",
          "A linked Planday employee can no longer be read; their devices and access are unchanged",
          record.externalId,
        );
        break;
    }
  }
  await deletePendingRows(tx, ctx, dropPending, { exceptMissing: true });
  if (missingSince.length > 0) {
    // `updated_at` doubles as "re-checked at": ABSENT_EMPLOYEES picks the least recently re-checked people first,
    // so more than 20 invisible people are all re-checked in turn (§6.5 "the rest wait for the next run").
    await tx.$executeRaw`
      UPDATE external_entity_maps
         SET upstream_missing_since = COALESCE(upstream_missing_since, ${ctx.now}::timestamptz),
             updated_at = now()
       WHERE id = ANY(${missingSince}::uuid[])`;
  }
  if (deactivated.length > 0) {
    await tx.externalEntityMap.updateMany({
      where: { id: { in: deactivated } },
      data: { upstreamMissingSince: null },
    });
  }
}

/**
 * Entering ABSENT_EMPLOYEES: mapped employees active in ClockOff that this run's EMPLOYEES phase did not see and the
 * deactivated list did not name, at most 20 (the rest wait for the next run). People not flagged missing yet come
 * first, then the least recently re-checked (a re-check without evidence stamps `updated_at`), so nobody waits
 * forever behind the same 20.
 */
export async function selectAbsentEmployees(tx: Tx, ctx: SinkContext): Promise<string[]> {
  const rows = await tx.$queryRaw<
    Array<{ external_id: string; employment_status: "ACTIVE" | "INACTIVE" }>
  >`
    SELECT m.external_id, e.employment_status::text AS employment_status
      FROM external_entity_maps m
      JOIN employees e ON e.id = m.internal_id AND e.organisation_id = ${ctx.organisationId}::uuid
     WHERE m.integration_id = ${ctx.integrationId}::uuid AND m.entity_type = 'EMPLOYEE'
       AND e.deleted_at IS NULL
       AND m.last_seen_at < ${new Date(ctx.state.startedAt)}::timestamptz
     ORDER BY m.upstream_missing_since IS NOT NULL, m.updated_at, m.last_seen_at, m.external_id`;
  return selectAbsentEmployeeRechecks({
    mapped: rows.map((r) => ({ externalId: r.external_id, employmentStatus: r.employment_status })),
    seenExternalIds: [],
    listedDeactivatedIds: ctx.state.listed,
  });
}

// ── SYNC: REACTIVATIONS (database only) ──────────────────────────────────────

/** One batch of REACTIVATIONS (§6.5): after both deactivation phases of the same run. */
export async function reactivationsStep(
  tx: Tx,
  ctx: SinkContext,
  cursor: Readonly<Record<string, unknown>>,
): Promise<DatabasePhaseStepResult> {
  const ids = ctx.state.reactivate;
  const offset = typeof cursor.offset === "number" ? cursor.offset : 0;
  const batch = ids.slice(offset, offset + DATABASE_PHASE_BATCH_SIZE);
  const nextOffset = offset + batch.length;
  const done = nextOffset >= ids.length;
  if (batch.length === 0) return { done: true, cursor: {} };
  const mapRows = await findMapRows(tx, ctx.integrationId, ["EMPLOYEE"], batch);
  const employees = await loadExistingEmployees(
    tx,
    ctx.organisationId,
    [...mapRows.values()].map((m) => m.internalId),
  );
  const listed = new Set(ctx.state.listedDeactivated);
  let capacity = await capacityRemaining(tx, ctx);
  const clear: string[] = [];
  for (const externalId of batch) {
    const mapRow = mapRows.get(externalId) ?? null;
    const employee = mapRow ? (employees.get(mapRow.internalId) ?? null) : null;
    const decision = decideReactivation({
      mapRow: mapRow && employee ? { upstreamRemovedAt: mapRow.upstreamRemovedAt } : null,
      employee,
      listedDeactivated: listed.has(externalId),
    });
    switch (decision.action) {
      case "REACTIVATE": {
        if (capacity <= 0) {
          ctx.tally.warn(
            "PLAN_LIMIT",
            "A Planday employee was not reactivated: the plan's employee limit is reached",
            externalId,
          );
          break;
        }
        const result = await reactivateManagedEmployee(tx, {
          organisationId: ctx.organisationId,
          employeeId: employee!.id,
          integrationId: ctx.integrationId,
          now: ctx.now,
        });
        ctx.effects.employeeWrites.push(result);
        if (result.changed) {
          capacity -= 1;
          ctx.tally.count("employees", "updated");
        }
        break;
      }
      case "CLEAR_REMOVED":
        if (mapRow) clear.push(mapRow.id);
        break;
      case "KEEP_INACTIVE":
        ctx.tally.warn(
          decision.warning,
          "A Planday employee is active in Planday but was deactivated in ClockOff; left inactive",
          externalId,
        );
        break;
      case "SKIP":
        break;
    }
  }
  await setUpstreamRemoved(tx, clear, null);
  return { done, cursor: done ? {} : { offset: nextOffset } };
}

// ── FINALISE helpers ─────────────────────────────────────────────────────────

/** Employees waiting for a manager after the run (wizard rows excluded). */
export async function countPendingEmployees(tx: Tx, ctx: SinkContext): Promise<number> {
  return tx.pendingExternalEmployee.count({
    where: { integrationId: ctx.integrationId, reason: { not: "ONBOARDING" } },
  });
}
