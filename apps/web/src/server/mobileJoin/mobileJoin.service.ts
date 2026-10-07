import { prisma } from "@clockoff/db";
import { AppError, isAppError } from "@clockoff/shared/errors";
import {
  isValidJoinCodeFormat,
  normaliseInviteCode,
  normaliseJoinCode,
} from "@clockoff/shared/joinCode";
import type {
  JoinConfirmInput,
  JoinConfirmResponse,
  JoinLookupInput,
  JoinLookupResponse,
  MobileLogoutInput,
  MobileRefreshInput,
  MobileRefreshResponse,
  MobileTokens,
} from "@clockoff/validation/mobile";
import type { OkResponse } from "@clockoff/validation/primitives";
import { hashToken } from "@/lib/tokens";
import { publishActivity, recordActivity } from "@/server/activity/recordActivity";
import { audit } from "@/server/audit/audit";
import { revokeEmployeeAccess } from "@/server/employees/employeeAccess";
import { toMobileEmployee, toMobileOrganisation } from "@/server/employees/employees.mappers";
import {
  findEmployeeIdsByName,
  findEmployeeInOrganisation,
  findJoinCandidates,
  lockEmployeeRow,
  type JoinCandidateRow,
} from "@/server/employees/employees.repository";
import { recomputeEmployeeInviteStatusDetailed } from "@/server/employees/inviteStatus";
import {
  findLiveInviteByCode,
  type InviteRow,
} from "@/server/employeeInvites/employeeInvites.repository";
import { publishEvent } from "@/server/events";
import {
  issueMobileTokens,
  revokeDeviceTokens,
  revokeRefreshTokenFamily,
  rotateRefreshToken,
  type IssuedMobileTokens,
} from "@/server/mobileAuth";
import { readOrganisationSettings } from "@/server/organisations";
import { enforceRateLimit } from "@/server/rateLimit";
import type { DeviceContext } from "@/server/tenancy/context";
import {
  findActiveJoinCode,
  findRefreshTokenByHash,
  retireOtherDevices,
  type ActiveJoinCodeRow,
} from "./mobileJoin.repository";

/**
 * Mobile join (§5 `/api/mobile/v1/join/*`) and the device auth lifecycle.
 *
 * Join is public: the company join code identifies the organisation, the typed name (plus the per-employee
 * invite code when names collide, or always when the organisation requires it) identifies the employee.
 * `lookup` and `confirm` run the SAME matching so a phone can only confirm what a lookup would have shown.
 * Rules:
 * - Unknown or revoked company code → INVALID_COMPANY_CODE (404). Unknown / used / expired invite code →
 *   INVALID_INVITE_CODE (400).
 * - Only ACTIVE, non-archived employees match; an employee already linked to a phone with an active device
 *   never matches by name (NONE). A link whose devices were all deactivated (lost phone) may be re-linked:
 *   "deactivate device" means "the phone must join again".
 * - Confirm is one transaction with the employee row locked (`FOR UPDATE`): any other active device of the
 *   employee is retired (one phone per person), a MobileUser + Device are created, the EmployeeUserLink is
 *   created or re-pointed (one row per employee), live invites become ACCEPTED, the EmployeeWorkState row is
 *   ensured, EMPLOYEE_JOINED is recorded, `inviteStatus` is re-derived and tokens are issued.
 * - Besides the handler's per-IP limit, join attempts are limited per company code (20 / 15 min) so one
 *   leaked poster cannot be used to enumerate names from many addresses.
 *
 * Privacy (§12): the device fields stored are the generic model family and version strings only.
 */

export const JOIN_COMPANY_CODE_RATE_LIMIT = {
  key: "mobile:join:company",
  limit: 20,
  windowSeconds: 15 * 60,
} as const;

type JoinOrganisation = ActiveJoinCodeRow["organisation"];

interface NameInput {
  firstName: string;
  lastName: string;
}

type EmployeeMatch =
  | { kind: "SINGLE"; employee: JoinCandidateRow; invite: InviteRow | null }
  | { kind: "NONE" }
  | { kind: "AMBIGUOUS" };

function invalidCompanyCode(): AppError {
  return new AppError(
    "INVALID_COMPANY_CODE",
    "We don't recognise that company code. Check it with your manager.",
  );
}

function invalidInviteCode(): AppError {
  return new AppError(
    "INVALID_INVITE_CODE",
    "That invite code is not valid or has expired. Ask your manager for a new one.",
  );
}

/** Collapse whitespace and normalise Unicode so "jane  smith" and "Jane Smith" compare equal. */
function normaliseName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function namesMatch(a: NameInput, b: NameInput): boolean {
  return (
    normaliseName(a.firstName).toLowerCase() === normaliseName(b.firstName).toLowerCase() &&
    normaliseName(a.lastName).toLowerCase() === normaliseName(b.lastName).toLowerCase()
  );
}

/** Linked to a phone that is still in use. A link whose devices are all deactivated can be re-linked. */
function isLinked(candidate: JoinCandidateRow): boolean {
  return (
    candidate.userLink !== null &&
    candidate.userLink.unlinkedAt === null &&
    candidate.devices.length > 0
  );
}

function canonicalCompanyCode(raw: string): string {
  const normalised = normaliseJoinCode(raw);
  return isValidJoinCodeFormat(normalised) ? normalised : raw.toUpperCase().replace(/\s+/g, "");
}

/** Company code → organisation. Rate limited per code; unknown and revoked codes are indistinguishable. */
async function resolveOrganisation(rawCode: string): Promise<JoinOrganisation> {
  const code = canonicalCompanyCode(rawCode);
  if (!/^[A-Z]{3,8}-\d{4}$/.test(code)) throw invalidCompanyCode();
  await enforceRateLimit(JOIN_COMPANY_CODE_RATE_LIMIT, code);
  const row = await findActiveJoinCode(code);
  if (!row) throw invalidCompanyCode();
  return row.organisation;
}

/** Everyone the typed details could mean, linked employees included (confirm needs to tell those apart). */
interface JoinCandidates {
  candidates: JoinCandidateRow[];
  /** The live invite the code identified, when one was given. */
  invite: InviteRow | null;
  /** The organisation insists on invite codes and none was given. */
  inviteCodeRequired: boolean;
}

async function findCandidates(
  organisation: JoinOrganisation,
  input: NameInput & { inviteCode?: string | undefined },
  now: Date,
): Promise<JoinCandidates> {
  if (input.inviteCode !== undefined) {
    const invite = await findLiveInviteByCode(
      organisation.id,
      normaliseInviteCode(input.inviteCode),
      now,
    );
    if (!invite) throw invalidInviteCode();
    const target = invite.employee;
    if (target.deletedAt || target.employmentStatus !== "ACTIVE") throw invalidInviteCode();
    if (!namesMatch(input, target)) return { candidates: [], invite, inviteCodeRequired: false };
    const candidates = await findJoinCandidates(organisation.id, [target.id]);
    return { candidates, invite, inviteCodeRequired: false };
  }

  // The organisation may insist on invite codes: tell the app to ask for one (same signal as a name clash).
  if (readOrganisationSettings(organisation.settings).requireInviteCodeToJoin) {
    return { candidates: [], invite: null, inviteCodeRequired: true };
  }

  const ids = await findEmployeeIdsByName(
    organisation.id,
    normaliseName(input.firstName),
    normaliseName(input.lastName),
  );
  const candidates = await findJoinCandidates(organisation.id, ids);
  return { candidates, invite: null, inviteCodeRequired: false };
}

/** What a lookup shows: employees already joined from a phone do not match by name. */
function classifyMatch(found: JoinCandidates): EmployeeMatch {
  if (found.inviteCodeRequired) return { kind: "AMBIGUOUS" };
  const open = found.candidates.filter((c) => !isLinked(c));
  if (open.length === 0) return { kind: "NONE" };
  if (open.length > 1) return { kind: "AMBIGUOUS" };
  return { kind: "SINGLE", employee: open[0]!, invite: found.invite };
}

function toTokensDto(tokens: IssuedMobileTokens): MobileTokens {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt.toISOString(),
  };
}

// ── Lookup ──────────────────────────────────────────────────────────────────

/** `POST /api/mobile/v1/join/lookup` (public, rate limited). */
export async function lookupJoin(input: JoinLookupInput): Promise<JoinLookupResponse> {
  const organisation = await resolveOrganisation(input.companyCode);
  const match = classifyMatch(await findCandidates(organisation, input, new Date()));
  return {
    organisation: { name: organisation.name },
    match: match.kind,
    employeePreview:
      match.kind === "SINGLE"
        ? {
            id: match.employee.id,
            firstName: match.employee.firstName,
            lastName: match.employee.lastName,
            jobTitle: match.employee.jobTitle,
            locationName: match.employee.primaryLocation?.name ?? null,
          }
        : null,
  };
}

// ── Confirm ─────────────────────────────────────────────────────────────────

/** `POST /api/mobile/v1/join/confirm` (public, rate limited) → 201 with tokens. */
export async function confirmJoin(input: JoinConfirmInput): Promise<JoinConfirmResponse> {
  const now = new Date();
  const organisation = await resolveOrganisation(input.companyCode);
  const found = await findCandidates(organisation, input, now);
  // The phone names an employee who already joined from a phone: say so, rather than "not found".
  const claimed = found.candidates.find((c) => c.id === input.employeeId);
  if (claimed && isLinked(claimed)) {
    throw new AppError(
      "EMPLOYEE_ALREADY_LINKED",
      "This employee has already joined from another phone. Leave the workplace on that phone or ask your manager to deactivate it.",
    );
  }
  const match = classifyMatch(found);
  if (match.kind === "AMBIGUOUS") {
    throw new AppError(
      "AMBIGUOUS_MATCH",
      "Enter the invite code from your manager to confirm which employee you are.",
    );
  }
  if (match.kind === "NONE" || match.employee.id !== input.employeeId) {
    throw new AppError(
      "EMPLOYEE_NOT_FOUND",
      "We could not find you in this workplace. Ask your manager to add or invite you.",
    );
  }
  const organisationId = organisation.id;
  const employeeId = match.employee.id;

  const outcome = await prisma.$transaction(async (tx) => {
    if (!(await lockEmployeeRow(tx, organisationId, employeeId))) {
      throw new AppError("EMPLOYEE_NOT_FOUND", "Employee not found");
    }
    // Re-read under the lock: a concurrent confirm or deactivation may have changed the row.
    const [fresh] = await findJoinCandidates(organisationId, [employeeId], tx);
    if (!fresh || fresh.employmentStatus !== "ACTIVE") {
      throw new AppError("EMPLOYEE_INACTIVE", "This employee is no longer active");
    }
    if (isLinked(fresh)) {
      throw new AppError(
        "EMPLOYEE_ALREADY_LINKED",
        "This employee has already joined from another phone. Leave the workplace on that phone or ask your manager to deactivate it.",
      );
    }
    const retiredDevices = await retireOtherDevices(tx, organisationId, employeeId, now);
    const mobileUser = await tx.mobileUser.create({
      data: { firstName: fresh.firstName, lastName: fresh.lastName },
    });
    const device = await tx.device.create({
      data: {
        mobileUserId: mobileUser.id,
        employeeId,
        organisationId,
        platform: input.device.platform,
        appVersion: input.device.appVersion,
        osVersion: input.device.osVersion,
        deviceModel: input.device.model,
        lastSeenAt: now,
      },
    });
    await tx.employeeUserLink.upsert({
      where: { employeeId },
      create: { employeeId, mobileUserId: mobileUser.id },
      update: { mobileUserId: mobileUser.id, linkedAt: now, unlinkedAt: null },
    });
    const accepted = await tx.employeeInvite.updateMany({
      where: { organisationId, employeeId, status: { in: ["PENDING", "SENT"] } },
      data: { status: "ACCEPTED", acceptedAt: now },
    });
    await tx.employeeWorkState.upsert({
      where: { employeeId },
      create: { employeeId },
      update: {},
    });
    const { event } = await recordActivity(
      {
        organisationId,
        employeeId,
        deviceId: device.id,
        actorType: "EMPLOYEE_DEVICE",
        type: "EMPLOYEE_JOINED",
        occurredAt: now,
        metadata: {
          deviceId: device.id,
          platform: device.platform,
          viaInviteCode: match.invite !== null,
          ...(match.invite ? { inviteId: match.invite.id } : {}),
          acceptedInvites: accepted.count,
          retiredDevices,
        },
      },
      { db: tx, publish: false },
    );
    const status = await recomputeEmployeeInviteStatusDetailed(employeeId, {
      db: tx,
      now,
      publish: false,
    });
    const tokens = await issueMobileTokens(device, { db: tx });
    const employee = await findEmployeeInOrganisation(organisationId, employeeId, tx);
    if (!employee) throw new AppError("EMPLOYEE_NOT_FOUND", "Employee not found");
    return { device, employee, event, status, tokens };
  });

  publishActivity(outcome.event);
  publishEvent({
    type: "device.status.changed",
    organisationId,
    employeeId,
    payload: {
      employeeId,
      deviceId: outcome.device.id,
      inviteStatus: outcome.status.inviteStatus,
      previousInviteStatus: outcome.status.previous,
    },
  });
  return {
    ...toTokensDto(outcome.tokens),
    deviceId: outcome.device.id,
    employee: toMobileEmployee(outcome.employee),
    organisation: toMobileOrganisation(organisation),
  };
}

// ── Auth lifecycle ──────────────────────────────────────────────────────────

/**
 * `POST /api/mobile/v1/auth/refresh` (public, rate limited). An unknown token is INVALID_TOKEN (401);
 * TOKEN_EXPIRED / TOKEN_REUSED / DEVICE_INACTIVE come straight from the rotation.
 */
export async function refreshMobileTokens(
  input: MobileRefreshInput,
): Promise<MobileRefreshResponse> {
  try {
    const rotated = await rotateRefreshToken(input.refreshToken);
    return toTokensDto(rotated);
  } catch (err) {
    if (isAppError(err) && err.code === "UNAUTHENTICATED") {
      throw new AppError("INVALID_TOKEN", "Invalid refresh token", { status: 401 });
    }
    throw err;
  }
}

/**
 * `POST /api/mobile/v1/auth/logout` (mobile). Revokes the presented refresh token's family when it
 * belongs to this device, otherwise every refresh token of the device. The device stays linked.
 */
export async function logoutDevice(ctx: DeviceContext, input: MobileLogoutInput): Promise<void> {
  if (input.refreshToken) {
    const row = await findRefreshTokenByHash(hashToken(input.refreshToken));
    if (row && row.deviceId === ctx.device.id) {
      await revokeRefreshTokenFamily(row.familyId);
      return;
    }
  }
  await revokeDeviceTokens(ctx.device.id);
}

/**
 * `POST /api/mobile/v1/leave-workplace` (mobile). Unlinks the employee, deactivates this device (push
 * token forgotten), revokes its tokens, ends a running break and re-derives `inviteStatus` (INVITED when a
 * live invite remains, else NOT_INVITED). Audited without an acting user; no activity event (the manager
 * sees the lifecycle change on the employee).
 */
export async function leaveWorkplace(ctx: DeviceContext): Promise<OkResponse> {
  const now = new Date();
  const organisationId = ctx.organisation.id;
  const employeeId = ctx.employee.id;
  const outcome = await prisma.$transaction(async (tx) => {
    const access = await revokeEmployeeAccess(tx, {
      organisationId,
      employeeId,
      deviceIds: [ctx.device.id],
      revokeInvites: false,
      actor: { type: "EMPLOYEE_DEVICE", deviceId: ctx.device.id },
      breakEndReason: "EMPLOYEE_ENDED",
      now,
    });
    const status = await recomputeEmployeeInviteStatusDetailed(employeeId, {
      db: tx,
      now,
      publish: false,
    });
    await audit(
      { organisation: { id: organisationId }, user: null, ip: ctx.ip, userAgent: ctx.userAgent },
      {
        action: "employee.left_workplace",
        entityType: "Employee",
        entityId: employeeId,
        before: { inviteStatus: status.previous },
        after: {
          inviteStatus: status.inviteStatus,
          deviceId: ctx.device.id,
          deactivatedDevices: access.deactivatedDevices,
          revokedTokens: access.revokedTokens,
          endedBreaks: access.endedBreakEvents.length,
        },
      },
      tx,
    );
    return { access, status };
  });
  for (const event of outcome.access.endedBreakEvents) publishActivity(event);
  publishEvent({
    type: "device.status.changed",
    organisationId,
    employeeId,
    payload: {
      employeeId,
      deviceId: ctx.device.id,
      inviteStatus: outcome.status.inviteStatus,
      previousInviteStatus: outcome.status.previous,
      left: true,
    },
  });
  return { ok: true };
}
