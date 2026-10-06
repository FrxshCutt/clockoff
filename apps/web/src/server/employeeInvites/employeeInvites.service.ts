import { Prisma, prisma, type EmployeeInvite as EmployeeInviteRow } from "@workmode/db";
import type { EmploymentStatus, InviteChannel } from "@workmode/shared/enums";
import { AppError } from "@workmode/shared/errors";
import { generateEmployeeInviteCode } from "@workmode/shared/joinCode";
import { CAN_SEE, CANNOT_SEE, EMPLOYEE_PRIVACY_SUMMARY } from "@workmode/shared/privacyStatements";
import type {
  CreateEmployeeInviteInput,
  CreateEmployeeInviteResponse,
  EmployeeInviteResponse,
  InviteInstructions,
  InviteInstructionsResponse,
  ResendEmployeeInviteInput,
} from "@workmode/validation/invites";
import { env } from "@/lib/env";
import { DAY_MS, expiresIn, generateToken } from "@/lib/tokens";
import { audit } from "@/server/audit/audit";
import type { EmailContent } from "@/server/email";
import { sendEmailSafely } from "@/server/email";
import { findEmployeeInOrganisation } from "@/server/employees/employees.repository";
import { effectiveInviteStatus, toEmployeeInviteDto } from "@/server/employees/employees.mappers";
import { recomputeEmployeeInviteStatus } from "@/server/employees/inviteStatus";
import { getActiveJoinCode } from "@/server/organisations";
import type { ManagerContext } from "@/server/tenancy/context";
import {
  countActiveDevices,
  findInviteInOrganisation,
  inviteCodeExists,
  revokeLiveInvitesForEmployee,
  unlinkWhenNoActiveDevice,
  type InviteRow,
} from "./employeeInvites.repository";

/**
 * Employee invites (§5). An invite is a per-employee 6-character code (no vowels, no 0/O/1/I) the
 * employee types in the iOS app together with the company join code. Rules:
 * - Creating an invite revokes any previous live one for the same employee (one active code per person).
 * - Only ACTIVE employees who are not joined from a phone still in use can be invited (EMPLOYEE_INACTIVE /
 *   EMPLOYEE_ALREADY_LINKED). "In use" = active link AND an active device, the join flow's own test: an
 *   employee whose only phone a manager deactivated is DEACTIVATED (§9) and would otherwise be stuck when
 *   the organisation requires invite codes, so inviting them ends the dead link and they read INVITED.
 * - Codes expire after 14 days; a resend extends the expiry (and may switch channel).
 * - LINK: the manager shares the instructions themselves — the invite is SENT immediately.
 * - EMAIL: the instructions are emailed to the employee's address; SENT once the provider accepted it,
 *   otherwise it stays PENDING so the manager can see it did not go out and resend.
 * - SMS: no SmsProvider exists in the MVP → 501 COMING_SOON, nothing is created.
 * - The random `tokenHash` column is filled (the schema requires it) but no raw token is ever handed out:
 *   joining is by code + name, never by link, so a forwarded email cannot impersonate anyone.
 */

export const EMPLOYEE_INVITE_TTL_MS = 14 * DAY_MS;
const MAX_CODE_ATTEMPTS = 8;

const DEFAULT_APP_STORE_URL_PATH = "/";

/** App Store link shown in instructions: `NEXT_PUBLIC_APP_STORE_URL`, else the web app itself. */
export function appStoreUrl(): string {
  const configured = process.env.NEXT_PUBLIC_APP_STORE_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "https:" || url.protocol === "http:") return url.toString();
    } catch {
      // fall through to the default
    }
  }
  return new URL(DEFAULT_APP_STORE_URL_PATH, env().APP_URL).toString();
}

/** The employee fields the invite rules read; both `EmployeeRow` and `InviteRow["employee"]` satisfy it. */
interface InviteEmployee {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  employmentStatus: EmploymentStatus;
  deletedAt: Date | null;
  userLink: { unlinkedAt: Date | null } | null;
  primaryLocation: { id: string; name: string; timezone: string | null } | null;
}

function hasActiveLink(employee: { userLink: { unlinkedAt: Date | null } | null }): boolean {
  return employee.userLink !== null && employee.userLink.unlinkedAt === null;
}

/** Joined from a phone that is still in use (same test as the join flow's `isLinked`). */
function isLinkedToActivePhone(employee: InviteEmployee, activeDevices: number): boolean {
  return hasActiveLink(employee) && activeDevices > 0;
}

/** Linked, but every device was deactivated (lost / retired phone): the link is dead and may be ended. */
function hasDeadLink(employee: InviteEmployee, activeDevices: number): boolean {
  return hasActiveLink(employee) && activeDevices === 0;
}

function assertInvitable(employee: InviteEmployee, activeDevices: number): void {
  if (employee.employmentStatus !== "ACTIVE") {
    throw new AppError("EMPLOYEE_INACTIVE", "Reactivate this employee before inviting them");
  }
  if (isLinkedToActivePhone(employee, activeDevices)) {
    throw new AppError(
      "EMPLOYEE_ALREADY_LINKED",
      "This employee has already joined from their phone",
    );
  }
}

/** Channel prerequisites: EMAIL needs an address, SMS needs a number and a provider (none yet). */
function assertChannelUsable(employee: InviteEmployee, channel: InviteChannel): void {
  switch (channel) {
    case "LINK":
      return;
    case "EMAIL":
      if (!employee.email) {
        throw new AppError("VALIDATION_ERROR", "Add an email address to invite by email", {
          details: {
            source: "body",
            formErrors: [],
            fieldErrors: { channel: ["This employee has no email address"] },
          },
        });
      }
      return;
    case "SMS":
      if (!employee.phone) {
        throw new AppError("VALIDATION_ERROR", "Add a phone number to invite by SMS", {
          details: {
            source: "body",
            formErrors: [],
            fieldErrors: { channel: ["This employee has no phone number"] },
          },
        });
      }
      throw new AppError(
        "COMING_SOON",
        "SMS invites are not available yet. Share the link or send an email instead.",
        { details: { channel: "SMS" } },
      );
    default: {
      const exhaustive: never = channel;
      throw new Error(`Unknown invite channel ${String(exhaustive)}`);
    }
  }
}

async function uniqueInviteCode(): Promise<string> {
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const code = generateEmployeeInviteCode();
    if (!(await inviteCodeExists(code))) return code;
  }
  throw new AppError("INTERNAL_ERROR", "Could not allocate an invite code");
}

function isCodeCollision(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") return false;
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  return Array.isArray(target) ? target.includes("code") : String(target ?? "").includes("code");
}

// ── Instructions & email ────────────────────────────────────────────────────

export interface BuildInstructionsInput {
  organisationName: string;
  employee: { id: string; firstName: string; lastName: string };
  inviteCode: string;
  expiresAt: Date;
  companyCode: string | null;
  appStoreUrl: string;
  /** For the expiry date in the copy. */
  timezone: string;
}

function formatExpiry(expiresAt: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: timezone }).format(
      expiresAt,
    );
  } catch {
    return expiresAt.toISOString().slice(0, 10);
  }
}

/** Pure: the step list, privacy bullets and ready-to-paste text a manager shares with an employee. */
export function buildInviteInstructions(input: BuildInstructionsInput): InviteInstructions {
  const fullName = `${input.employee.firstName} ${input.employee.lastName}`.trim();
  const companyCodeStep = input.companyCode
    ? `Enter the company code ${input.companyCode}.`
    : "Enter the company code your manager gives you (the current code has been revoked; ask your manager for the new one).";
  const steps = [
    `Download the Work Mode app: ${input.appStoreUrl}`,
    'Open the app and tap "Join my workplace".',
    companyCodeStep,
    `Enter your name exactly as your manager has it: ${fullName}.`,
    `If the app asks for an invite code, enter ${input.inviteCode}.`,
    "Allow Screen Time access and choose the apps to block during your shifts.",
  ];
  const canSee = CAN_SEE.map((s) => s.label);
  const cannotSee = CANNOT_SEE.map((s) => s.label);
  const expiry = formatExpiry(input.expiresAt, input.timezone);
  const copyText = [
    `Hi ${input.employee.firstName},`,
    "",
    `${input.organisationName} uses Work Mode to keep phones distraction-free during shifts. Here is how to set it up:`,
    "",
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    `Your invite code ${input.inviteCode} expires on ${expiry}.`,
    "",
    EMPLOYEE_PRIVACY_SUMMARY,
    "",
    "What your employer can see:",
    ...canSee.map((line) => `- ${line}`),
    "",
    "What your employer cannot see:",
    ...cannotSee.map((line) => `- ${line}`),
  ].join("\n");
  return {
    employee: { ...input.employee },
    companyCode: input.companyCode,
    inviteCode: input.inviteCode,
    expiresAt: input.expiresAt.toISOString(),
    appStoreUrl: input.appStoreUrl,
    steps,
    canSee,
    cannotSee,
    copyText,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Email body for an EMAIL-channel invite: the same instructions, no links that log anyone in. */
export function employeeInviteEmail(
  organisationName: string,
  instructions: InviteInstructions,
): EmailContent {
  const paragraphs = instructions.copyText
    .split("\n\n")
    .map((block) => `<p>${escapeHtml(block).replaceAll("\n", "<br>")}</p>`)
    .join("\n");
  return {
    subject: `Join ${organisationName} on Work Mode`,
    text: instructions.copyText,
    html: [
      `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">`,
      `<h2 style="margin:0 0 12px">${escapeHtml(`Join ${organisationName} on Work Mode`)}</h2>`,
      paragraphs,
      `</body></html>`,
    ].join("\n"),
  };
}

async function instructionsFor(
  ctx: ManagerContext,
  invite: Pick<EmployeeInviteRow, "code" | "expiresAt">,
  employee: InviteEmployee,
): Promise<InviteInstructions> {
  const activeCode = await getActiveJoinCode(ctx.organisation.id);
  return buildInviteInstructions({
    organisationName: ctx.organisation.name,
    employee: { id: employee.id, firstName: employee.firstName, lastName: employee.lastName },
    inviteCode: invite.code,
    expiresAt: invite.expiresAt,
    companyCode: activeCode?.code ?? null,
    appStoreUrl: appStoreUrl(),
    timezone: employee.primaryLocation?.timezone ?? ctx.organisation.timezone,
  });
}

/**
 * Deliver an invite after its row is committed. EMAIL marks the invite SENT once the provider accepted
 * the message; LINK is SENT already. Returns the (possibly updated) row.
 */
async function deliverInvite(
  ctx: ManagerContext,
  invite: EmployeeInviteRow,
  employee: InviteEmployee,
  instructions: InviteInstructions,
): Promise<EmployeeInviteRow> {
  if (invite.channel !== "EMAIL" || !employee.email) return invite;
  const sent = await sendEmailSafely({
    to: employee.email,
    ...employeeInviteEmail(ctx.organisation.name, instructions),
  });
  if (!sent) return invite;
  return prisma.employeeInvite.update({
    where: { id: invite.id },
    data: { status: "SENT", sentAt: new Date() },
  });
}

// ── Create ──────────────────────────────────────────────────────────────────

/** `POST /api/employees/:id/invites` (`employees:write`). */
export async function createEmployeeInvite(
  ctx: ManagerContext,
  employeeId: string,
  input: CreateEmployeeInviteInput,
): Promise<CreateEmployeeInviteResponse> {
  const organisationId = ctx.organisation.id;
  const employee = await findEmployeeInOrganisation(organisationId, employeeId);
  if (!employee) throw new AppError("EMPLOYEE_NOT_FOUND", "Employee not found");
  const activeDevices = await countActiveDevices(organisationId, employeeId);
  assertInvitable(employee, activeDevices);
  assertChannelUsable(employee, input.channel);
  const endDeadLink = hasDeadLink(employee, activeDevices);

  let created: EmployeeInviteRow | null = null;
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS && created === null; attempt++) {
    const code = await uniqueInviteCode();
    const now = new Date();
    try {
      created = await prisma.$transaction(async (tx) => {
        await revokeLiveInvitesForEmployee(tx, organisationId, employeeId, now);
        const unlinked = endDeadLink ? await unlinkWhenNoActiveDevice(tx, employeeId, now) : 0;
        const invite = await tx.employeeInvite.create({
          data: {
            organisationId,
            employeeId,
            code,
            tokenHash: generateToken(32).hash,
            channel: input.channel,
            status: input.channel === "LINK" ? "SENT" : "PENDING",
            sentAt: input.channel === "LINK" ? now : null,
            expiresAt: expiresIn(EMPLOYEE_INVITE_TTL_MS, now),
          },
        });
        await audit(
          ctx,
          {
            action: "employee.invite_created",
            entityType: "EmployeeInvite",
            entityId: invite.id,
            after: {
              employeeId,
              channel: invite.channel,
              expiresAt: invite.expiresAt,
              ...(unlinked > 0 ? { endedDeadLink: true } : {}),
            },
          },
          tx,
        );
        return invite;
      });
    } catch (err) {
      if (isCodeCollision(err)) continue; // draw another code
      throw err;
    }
  }
  if (!created) throw new AppError("INTERNAL_ERROR", "Could not allocate an invite code");

  const instructions = await instructionsFor(ctx, created, employee);
  const delivered = await deliverInvite(ctx, created, employee, instructions);
  await recomputeEmployeeInviteStatus(employeeId);
  return { invite: toEmployeeInviteDto(delivered), instructions };
}

// ── Resend / revoke / instructions ──────────────────────────────────────────

function loadInviteOrThrow(invite: InviteRow | null): InviteRow {
  // Another tenant's invite (or an unknown id) is indistinguishable from "no such invite": 404.
  if (!invite || invite.employee.deletedAt) {
    throw new AppError("INVITE_INVALID", "Invite not found", { status: 404 });
  }
  return invite;
}

/** `POST /api/invites/:id/resend` — fresh 14-day expiry, same code, optional channel switch. */
export async function resendEmployeeInvite(
  ctx: ManagerContext,
  inviteId: string,
  input: ResendEmployeeInviteInput,
): Promise<EmployeeInviteResponse> {
  const organisationId = ctx.organisation.id;
  const existing = loadInviteOrThrow(await findInviteInOrganisation(organisationId, inviteId));
  const now = new Date();
  const state = effectiveInviteStatus(existing, now);
  if (state === "ACCEPTED" || state === "REVOKED") {
    throw new AppError(
      "INVITE_INVALID",
      `This invite has been ${state.toLowerCase()} and cannot be re-sent`,
    );
  }
  const employee = existing.employee;
  const activeDevices = await countActiveDevices(organisationId, employee.id);
  assertInvitable(employee, activeDevices);
  const channel = input.channel ?? existing.channel;
  assertChannelUsable(employee, channel);
  const endDeadLink = hasDeadLink(employee, activeDevices);

  const updated = await prisma.$transaction(async (tx) => {
    const claimed = await tx.employeeInvite.updateMany({
      where: { id: existing.id, organisationId, status: { in: ["PENDING", "SENT"] } },
      data: {
        channel,
        status: channel === "LINK" ? "SENT" : "PENDING",
        sentAt: channel === "LINK" ? now : null,
        expiresAt: expiresIn(EMPLOYEE_INVITE_TTL_MS, now),
      },
    });
    if (claimed.count !== 1)
      throw new AppError("INVITE_INVALID", "This invite can no longer be re-sent");
    const unlinked = endDeadLink ? await unlinkWhenNoActiveDevice(tx, employee.id, now) : 0;
    await audit(
      ctx,
      {
        action: "employee.invite_resent",
        entityType: "EmployeeInvite",
        entityId: existing.id,
        before: { channel: existing.channel, expiresAt: existing.expiresAt },
        after: {
          channel,
          expiresAt: expiresIn(EMPLOYEE_INVITE_TTL_MS, now),
          ...(unlinked > 0 ? { endedDeadLink: true } : {}),
        },
      },
      tx,
    );
    return tx.employeeInvite.findUniqueOrThrow({ where: { id: existing.id } });
  });

  const instructions = await instructionsFor(ctx, updated, employee);
  const delivered = await deliverInvite(ctx, updated, employee, instructions);
  await recomputeEmployeeInviteStatus(existing.employeeId);
  return { invite: toEmployeeInviteDto(delivered) };
}

/** `POST /api/invites/:id/revoke` — idempotent for an already revoked invite. */
export async function revokeEmployeeInvite(
  ctx: ManagerContext,
  inviteId: string,
): Promise<EmployeeInviteResponse> {
  const organisationId = ctx.organisation.id;
  const existing = loadInviteOrThrow(await findInviteInOrganisation(organisationId, inviteId));
  if (existing.status === "ACCEPTED") {
    throw new AppError("INVITE_INVALID", "This invite has already been accepted");
  }
  if (existing.status === "REVOKED") return { invite: toEmployeeInviteDto(existing) };

  const now = new Date();
  const revoked = await prisma.$transaction(async (tx) => {
    const updated = await tx.employeeInvite.update({
      where: { id: existing.id },
      data: { status: "REVOKED", revokedAt: now },
    });
    await audit(
      ctx,
      {
        action: "employee.invite_revoked",
        entityType: "EmployeeInvite",
        entityId: existing.id,
        before: { employeeId: existing.employeeId, status: existing.status },
      },
      tx,
    );
    return updated;
  });
  await recomputeEmployeeInviteStatus(existing.employeeId);
  return { invite: toEmployeeInviteDto(revoked) };
}

/** `GET /api/invites/:id/instructions` (`employees:read`). Works for live and expired invites. */
export async function getInviteInstructions(
  ctx: ManagerContext,
  inviteId: string,
): Promise<InviteInstructionsResponse> {
  const existing = loadInviteOrThrow(await findInviteInOrganisation(ctx.organisation.id, inviteId));
  if (existing.status === "ACCEPTED" || existing.status === "REVOKED") {
    throw new AppError(
      "INVITE_INVALID",
      `This invite has been ${existing.status.toLowerCase()}; create a new one to share instructions`,
    );
  }
  const instructions = await instructionsFor(ctx, existing, existing.employee);
  return { instructions };
}
