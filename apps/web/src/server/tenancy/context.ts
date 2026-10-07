import {
  prisma,
  type Device,
  type Employee,
  type MobileUser,
  type Organisation,
  type OrganisationMembership,
  type Session,
  type User,
} from "@clockoff/db";
import { AppError } from "@clockoff/shared/errors";
import { permissionsForRole, type Permission } from "@clockoff/shared/permissions";
import { ORG_COOKIE, SESSION_COOKIE } from "@/lib/cookies";
import { env } from "@/lib/env";
import { getBearerToken, getClientIp, getCookie, getRequestId, getUserAgent } from "@/lib/request";
import { resolveSession } from "@/server/auth/sessions";
import { assertDeviceUsable } from "@/server/mobileAuth/deviceUsable";
import { verifyMobileAccessToken } from "@/server/mobileAuth/tokens";

export { assertDeviceUsable };

/**
 * Request contexts. Services receive one of these — never a raw request — and the organisation id
 * ALWAYS comes from the verified membership (manager) or the verified device row (mobile), never from
 * client input.
 */

export interface RequestMeta {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
}

/** An authenticated manager, regardless of organisation (auth routes, organisation creation). */
export interface UserContext extends RequestMeta {
  kind: "user";
  user: User;
  session: Session;
  /** The session expiry was extended by this request; `createHandler` re-issues the cookies. */
  sessionSlid: boolean;
}

/** An authenticated manager acting inside one organisation they belong to. */
export interface ManagerContext extends Omit<UserContext, "kind"> {
  kind: "manager";
  organisation: Organisation;
  membership: OrganisationMembership;
  permissions: ReadonlySet<Permission>;
}

/** A verified employee device (mobile JWT). */
export interface DeviceContext extends RequestMeta {
  kind: "device";
  device: Device;
  employee: Employee;
  organisation: Organisation;
  mobileUser: MobileUser;
}

/** A trusted scheduler call (`CRON_SECRET`). */
export interface CronContext extends RequestMeta {
  kind: "cron";
}

export type AnyContext = UserContext | ManagerContext | DeviceContext | CronContext;

export function getRequestMeta(req: Request): RequestMeta {
  return { requestId: getRequestId(req), ip: getClientIp(req), userAgent: getUserAgent(req) };
}

export async function getCurrentUserContext(req: Request): Promise<UserContext> {
  const meta = getRequestMeta(req);
  const token = getCookie(req, SESSION_COOKIE);
  if (!token) throw new AppError("UNAUTHENTICATED", "Sign in required");
  const resolved = await resolveSession(token, { ip: meta.ip, userAgent: meta.userAgent });
  if (!resolved) throw new AppError("UNAUTHENTICATED", "Session is invalid or has expired");
  return {
    kind: "user",
    ...meta,
    user: resolved.user,
    session: resolved.session,
    sessionSlid: resolved.slid,
  };
}

export interface OrganisationSelection {
  organisation: Organisation;
  membership: OrganisationMembership;
}

/**
 * Pick the organisation for a user: the one named by `requestedOrganisationId` when the user is a
 * member of it, otherwise the user's earliest membership. Null when the user has no organisation.
 * A forged or stale `wm_org` cookie therefore degrades to the default organisation, never to
 * another tenant's data.
 */
export async function resolveOrganisationSelection(
  userId: string,
  requestedOrganisationId: string | undefined,
): Promise<OrganisationSelection | null> {
  // The id usually comes from the `wm_org` cookie, i.e. client input: anything that is not a UUID is
  // ignored here (querying a uuid column with it would make Postgres raise and the request 500).
  if (requestedOrganisationId && isUuid(requestedOrganisationId)) {
    const membership = await prisma.organisationMembership.findFirst({
      where: { userId, organisationId: requestedOrganisationId, organisation: { deletedAt: null } },
      include: { organisation: true },
    });
    if (membership) return { organisation: membership.organisation, membership };
  }
  const fallback = await prisma.organisationMembership.findFirst({
    where: { userId, organisation: { deletedAt: null } },
    include: { organisation: true },
    orderBy: { createdAt: "asc" },
  });
  return fallback ? { organisation: fallback.organisation, membership: fallback } : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shape check for ids that arrive outside a Zod schema (cookies, token claims). */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export interface ManagerContextOptions {
  /** Defaults to `REQUIRE_EMAIL_VERIFICATION`. */
  requireVerifiedEmail?: boolean;
}

export async function getCurrentManagerContext(
  req: Request,
  options: ManagerContextOptions = {},
): Promise<ManagerContext> {
  const userCtx = await getCurrentUserContext(req);
  return elevateToManagerContext(userCtx, getCookie(req, ORG_COOKIE), options);
}

/** Turn a user context into a manager context (shared by the handler wrapper and tests). */
export async function elevateToManagerContext(
  userCtx: UserContext,
  requestedOrganisationId: string | undefined,
  options: ManagerContextOptions = {},
): Promise<ManagerContext> {
  const requireVerified = options.requireVerifiedEmail ?? env().REQUIRE_EMAIL_VERIFICATION;
  if (requireVerified && !userCtx.user.emailVerifiedAt) {
    throw new AppError("EMAIL_NOT_VERIFIED", "Verify your email address to continue");
  }
  const selection = await resolveOrganisationSelection(userCtx.user.id, requestedOrganisationId);
  if (!selection) throw new AppError("NO_ORGANISATION", "Create or join an organisation first");
  const { kind: _kind, ...rest } = userCtx;
  return {
    kind: "manager",
    ...rest,
    organisation: selection.organisation,
    membership: selection.membership,
    permissions: permissionsForRole(selection.membership.role),
  };
}

export function requirePermission(ctx: ManagerContext, permission: Permission): void {
  if (!ctx.permissions.has(permission)) {
    throw new AppError("FORBIDDEN", `Missing permission: ${permission}`, {
      details: { permission },
    });
  }
}

export function hasPermission(ctx: ManagerContext, permission: Permission): boolean {
  return ctx.permissions.has(permission);
}

export async function getCurrentDeviceContext(req: Request): Promise<DeviceContext> {
  const meta = getRequestMeta(req);
  const token = getBearerToken(req);
  if (!token) throw new AppError("UNAUTHENTICATED", "Bearer token required");
  const claims = await verifyMobileAccessToken(token);

  const device = await prisma.device.findUnique({
    where: { id: claims.dev },
    include: { employee: true, organisation: true, mobileUser: true },
  });
  if (
    !device ||
    device.mobileUserId !== claims.sub ||
    device.employeeId !== claims.emp ||
    device.organisationId !== claims.org
  ) {
    throw new AppError("UNAUTHENTICATED", "Token does not match a known device");
  }
  assertDeviceUsable(device);
  const { employee, organisation, mobileUser, ...deviceRow } = device;
  return { kind: "device", ...meta, device: deviceRow, employee, organisation, mobileUser };
}
