import { Prisma } from "@workmode/db";
import { resolveBreakBehaviour, type BreakBehaviour } from "@workmode/shared/breaks/breakRules";
import { AppError } from "@workmode/shared/errors";
import {
  overrideTypeAcceptsPayload,
  resolveOverrideWindow,
  type CreateOverrideInput,
  type ListOverridesResponse,
  type Override,
  type OverrideQuery,
  type OverridePayload,
  type RevokeOverrideInput,
} from "@workmode/validation/overrides";
import { recordActivity } from "@/server/activity/recordActivity";
import { audit } from "@/server/audit/audit";
import { toOverrideDto } from "@/server/employees/employees.mappers";
import { ensureOrganisationBridged } from "@/server/realtime/pushBridge";
import { requirePermission, type ManagerContext } from "@/server/tenancy/context";
import { publishOverrideEvent } from "@/server/workState/workStateJob";
import { recomputeEmployeeWorkState } from "@/server/workState/workState.service";
import {
  createOverrideRow,
  findActiveEmployee,
  findBreakPolicyInOrganisation,
  findOverrideInOrganisation,
  findOverrides,
  findShiftInProgress,
  revokeOverrideRow,
  type OverrideRow,
} from "./overrides.repository";

/**
 * Manager overrides (§11). Rules enforced here, on top of `createOverrideSchema`:
 *   - `overrides:create` for every mutation (route); EMERGENCY_POLICY_OVERRIDE additionally needs
 *     `org:manage` (OWNER / ADMIN) and is always organisation-wide (`employeeId` must be absent);
 *   - duration cap by role via `resolveOverrideWindow` (OWNER 7 days, others 24 h → OVERRIDE_TOO_LONG);
 *   - the employee must belong to the organisation (EMPLOYEE_NOT_FOUND, 404) and be ACTIVE (EMPLOYEE_INACTIVE);
 *   - TEMPORARY_EXCEPTION: a referenced break policy must belong to the organisation (NOT_FOUND) and its
 *     `resolveBreakBehaviour` is merged into the STORED payload, because the pure state machine never
 *     resolves a `breakPolicyId` itself (it would default to RELAX_ALL);
 *   - END_WORK_MODE_EARLY without an explicit window expires at the end of the shift in progress.
 * Every mutation is audited; creation records OVERRIDE_CREATED (actor MANAGER); revocation is audit-only
 * (OVERRIDE_REVOKED is not an ActivityEventType). Both publish `OVERRIDE_*` + `override.changed` bus
 * events, which the push bridge turns into a silent sync push; devices honour overrides through
 * `activeOverrides` in `GET /sync`.
 */

interface OverrideCursor {
  c: string;
  id: string;
}

export function encodeOverrideCursor(row: Pick<OverrideRow, "createdAt" | "id">): string {
  const cursor: OverrideCursor = { c: row.createdAt.toISOString(), id: row.id };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeOverrideCursor(value: string | undefined): OverrideCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<OverrideCursor>;
    if (typeof parsed.c === "string" && !Number.isNaN(Date.parse(parsed.c)) && typeof parsed.id === "string") {
      return { c: parsed.c, id: parsed.id };
    }
  } catch {
    // fall through
  }
  throw new AppError("VALIDATION_ERROR", "Invalid cursor", {
    details: { source: "query", formErrors: [], fieldErrors: { cursor: ["Invalid cursor"] } },
  });
}

function validationError(field: string, message: string): AppError {
  return new AppError("VALIDATION_ERROR", "Invalid body", {
    details: { source: "body", formErrors: [], fieldErrors: { [field]: [message] } },
  });
}

/**
 * The payload to store for a new override: `{}` for the lifting types; for TEMPORARY_EXCEPTION the
 * normalised behaviour (`resolveBreakBehaviour`) — from the referenced break policy when `breakPolicyId`
 * is given (kept in the payload for display), from the explicit fields otherwise, RELAX_ALL by default.
 */
export async function resolveStoredPayload(
  organisationId: string,
  input: CreateOverrideInput,
): Promise<OverridePayload> {
  if (!overrideTypeAcceptsPayload(input.type)) return {};
  const payload = input.payload ?? {};
  let behaviour: BreakBehaviour;
  if (payload.breakPolicyId !== undefined) {
    const policy = await findBreakPolicyInOrganisation(organisationId, payload.breakPolicyId);
    if (!policy) throw new AppError("NOT_FOUND", "Break policy not found");
    behaviour = resolveBreakBehaviour(policy);
    return { ...behaviour, breakPolicyId: policy.id };
  }
  behaviour = resolveBreakBehaviour({
    restrictionBehaviour: payload.restrictionBehaviour ?? "RELAX_ALL",
    relaxedCategories: payload.relaxedCategories ?? [],
  });
  return { ...behaviour };
}

export async function listOverrides(
  ctx: ManagerContext,
  query: OverrideQuery,
  now: Date = new Date(),
): Promise<ListOverridesResponse> {
  const cursor = decodeOverrideCursor(query.cursor);
  const rows = await findOverrides(
    ctx.organisation.id,
    {
      employeeId: query.employeeId,
      types: query.type,
      statuses: query.status,
      after: cursor ? { createdAt: new Date(cursor.c), id: cursor.id } : undefined,
    },
    now,
    query.limit + 1,
  );
  const page = rows.slice(0, query.limit);
  return {
    items: page.map((row) => toOverrideDto(row, now)),
    nextCursor: rows.length > query.limit ? encodeOverrideCursor(page[page.length - 1]!) : null,
  };
}

export async function getOverride(ctx: ManagerContext, id: string, now: Date = new Date()): Promise<Override> {
  const row = await findOverrideInOrganisation(ctx.organisation.id, id);
  if (!row) throw new AppError("NOT_FOUND", "Override not found");
  return toOverrideDto(row, now);
}

export async function createOverride(
  ctx: ManagerContext,
  input: CreateOverrideInput,
  now: Date = new Date(),
): Promise<Override> {
  const organisationId = ctx.organisation.id;

  if (input.type === "EMERGENCY_POLICY_OVERRIDE") {
    requirePermission(ctx, "org:manage");
    if (input.employeeId !== undefined) {
      throw validationError("employeeId", "EMERGENCY_POLICY_OVERRIDE is organisation-wide; omit employeeId");
    }
  }

  let employee: Awaited<ReturnType<typeof findActiveEmployee>> = null;
  if (input.employeeId !== undefined) {
    employee = await findActiveEmployee(organisationId, input.employeeId);
    if (!employee) throw new AppError("EMPLOYEE_NOT_FOUND", "Employee not found");
    if (employee.employmentStatus !== "ACTIVE") {
      throw new AppError("EMPLOYEE_INACTIVE", "This employee is deactivated");
    }
  }

  // END_WORK_MODE_EARLY: lift restrictions for the rest of the shift in progress unless told otherwise.
  let windowInput: Pick<CreateOverrideInput, "expiresAt" | "durationMinutes"> = input;
  if (
    input.type === "END_WORK_MODE_EARLY" &&
    input.expiresAt === undefined &&
    input.durationMinutes === undefined &&
    employee
  ) {
    const shift = await findShiftInProgress(organisationId, employee.id, now);
    if (shift) windowInput = { expiresAt: shift.endsAt.toISOString() };
  }
  const window = resolveOverrideWindow(windowInput, now, ctx.membership.role);
  if (!window.ok) {
    if (window.code === "OVERRIDE_TOO_LONG") throw new AppError("OVERRIDE_TOO_LONG", window.message);
    throw validationError("expiresAt", window.message);
  }

  const payload = await resolveStoredPayload(organisationId, input);
  const row = await createOverrideRow({
    organisationId,
    employeeId: employee?.id ?? null,
    type: input.type,
    reason: input.reason,
    createdById: ctx.user.id,
    startsAt: window.startsAt,
    expiresAt: window.expiresAt,
    payload: payload as Prisma.InputJsonValue,
  });
  const dto = toOverrideDto(row, now);

  await audit(ctx, {
    action: "override.created",
    entityType: "ManagerOverride",
    entityId: row.id,
    after: {
      type: dto.type,
      employeeId: row.employeeId,
      reason: dto.reason,
      startsAt: dto.startsAt,
      expiresAt: dto.expiresAt,
      payload: dto.payload,
    },
  });
  await recordActivity({
    organisationId,
    employeeId: row.employeeId,
    actorType: "MANAGER",
    actorUserId: ctx.user.id,
    type: "OVERRIDE_CREATED",
    occurredAt: now,
    metadata: {
      overrideId: row.id,
      type: row.type,
      startsAt: dto.startsAt,
      expiresAt: dto.expiresAt,
      durationMinutes: window.durationMinutes,
      orgWide: row.employeeId === null,
      ...(payload.restrictionBehaviour ? { restrictionBehaviour: payload.restrictionBehaviour } : {}),
      ...(payload.breakPolicyId ? { breakPolicyId: payload.breakPolicyId } : {}),
    },
  });

  ensureOrganisationBridged(organisationId);
  publishOverrideEvent("OVERRIDE_CREATED", row);
  // Organisation-wide overrides are picked up for every active employee by the next job tick.
  if (row.employeeId) await recomputeEmployeeWorkState({ organisationId, employeeId: row.employeeId, now });
  return dto;
}

export async function revokeOverride(
  ctx: ManagerContext,
  id: string,
  _input: RevokeOverrideInput,
  now: Date = new Date(),
): Promise<Override> {
  const organisationId = ctx.organisation.id;
  const row = await findOverrideInOrganisation(organisationId, id);
  if (!row) throw new AppError("NOT_FOUND", "Override not found");
  if (row.revokedAt !== null) return toOverrideDto(row, now); // idempotent
  if (row.expiresAt.getTime() <= now.getTime()) {
    throw new AppError("OVERRIDE_EXPIRED", "This override has already expired");
  }

  const revoked = await revokeOverrideRow(organisationId, row.id, now);
  const current = (await findOverrideInOrganisation(organisationId, row.id)) ?? row;
  if (!revoked) return toOverrideDto(current, now); // lost a race with a concurrent revoke

  await audit(ctx, {
    action: "override.revoked",
    entityType: "ManagerOverride",
    entityId: row.id,
    before: { revokedAt: null, expiresAt: row.expiresAt.toISOString() },
    after: { revokedAt: now.toISOString(), reason: _input.reason ?? null },
  });
  ensureOrganisationBridged(organisationId);
  publishOverrideEvent("OVERRIDE_REVOKED", current);
  if (current.employeeId) {
    await recomputeEmployeeWorkState({ organisationId, employeeId: current.employeeId, now });
  }
  return toOverrideDto(current, now);
}
