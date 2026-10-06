import { randomUUID } from "node:crypto";
import {
  prisma,
  type CompanyJoinCode,
  type Device,
  type Employee,
  type MobileUser,
  type Organisation,
  type OrganisationMembership,
  type Role,
  type User,
} from "@workmode/db";
import { CSRF_COOKIE, ORG_COOKIE, SESSION_COOKIE } from "@/lib/cookies";
import { createCsrfToken } from "@/lib/crypto";
import { hashPassword } from "@/lib/password";
import { createSession } from "@/server/auth/sessions";
import { createOrganisation } from "@/server/organisations";
import { CookieJar } from "./http";

/**
 * Test data factories. They write through the real services where a service exists (organisation
 * creation) so fixtures have the same shape as production data (OWNER membership, join code, …).
 */

export const DEFAULT_TEST_PASSWORD = "Correct-horse-42";

export function uniqueEmail(prefix = "manager"): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@example.test`;
}

export interface TestUser {
  user: User;
  /** Plain-text password (for login tests). */
  password: string;
}

export async function createTestUser(
  options: { email?: string; name?: string; password?: string; verified?: boolean } = {},
): Promise<TestUser> {
  const password = options.password ?? DEFAULT_TEST_PASSWORD;
  const user = await prisma.user.create({
    data: {
      email: options.email ?? uniqueEmail(),
      name: options.name ?? "Test Manager",
      passwordHash: await hashPassword(password),
      emailVerifiedAt: options.verified === false ? null : new Date(),
    },
  });
  return { user, password };
}

export interface TestOrg {
  organisation: Organisation;
  owner: User;
  ownerPassword: string;
  membership: OrganisationMembership;
  joinCode: CompanyJoinCode;
}

/** Create an organisation through the real service (OWNER membership + ACTIVE join code). */
export async function createTestOrg(
  options: {
    owner?: User | TestUser;
    name?: string;
    timezone?: string;
    firstLocationName?: string;
  } = {},
): Promise<TestOrg> {
  let owner: User;
  let ownerPassword = DEFAULT_TEST_PASSWORD;
  if (!options.owner) {
    const created = await createTestUser();
    owner = created.user;
    ownerPassword = created.password;
  } else if ("user" in options.owner) {
    owner = options.owner.user;
    ownerPassword = options.owner.password;
  } else {
    owner = options.owner;
  }
  const created = await createOrganisation(
    { user: owner },
    {
      name: options.name ?? `Test Org ${randomUUID().slice(0, 6)}`,
      timezone: options.timezone ?? "Europe/London",
      ...(options.firstLocationName ? { firstLocationName: options.firstLocationName } : {}),
    },
  );
  return {
    organisation: created.organisation,
    owner,
    ownerPassword,
    membership: created.membership,
    joinCode: created.joinCode,
  };
}

/** Add an existing user to an organisation with `role`. */
export async function addMember(
  organisationId: string,
  user: User,
  role: Role,
): Promise<OrganisationMembership> {
  return prisma.organisationMembership.create({ data: { organisationId, userId: user.id, role } });
}

/**
 * Sign `user` in without going through the login route (no argon2, no rate limits): a real session row
 * plus a signed CSRF token, returned as a cookie jar. Pass `organisationId` to pre-select a tenant.
 */
export async function loginAs(
  user: User | TestUser,
  options: { organisationId?: string } = {},
): Promise<CookieJar> {
  const u = "user" in user ? user.user : user;
  const { token } = await createSession(u.id, { ip: "127.0.0.1", userAgent: "vitest" });
  const jar = new CookieJar({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: createCsrfToken() });
  if (options.organisationId) jar.set(ORG_COOKIE, options.organisationId);
  return jar;
}

export interface TestDevice {
  mobileUser: MobileUser;
  employee: Employee;
  device: Device;
}

/** An employee with a linked mobile user and an active device in `organisationId`. */
export async function createTestDevice(
  organisationId: string,
  options: { isActive?: boolean } = {},
): Promise<TestDevice> {
  const employee = await prisma.employee.create({
    data: { organisationId, firstName: "Test", lastName: `Employee ${randomUUID().slice(0, 4)}` },
  });
  const mobileUser = await prisma.mobileUser.create({
    data: { firstName: "Test", lastName: "Employee" },
  });
  await prisma.employeeUserLink.create({
    data: { employeeId: employee.id, mobileUserId: mobileUser.id },
  });
  const device = await prisma.device.create({
    data: {
      organisationId,
      employeeId: employee.id,
      mobileUserId: mobileUser.id,
      isActive: options.isActive ?? true,
    },
  });
  return { mobileUser, employee, device };
}
