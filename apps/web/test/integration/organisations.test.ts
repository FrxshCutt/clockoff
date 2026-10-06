import { prisma } from "@workmode/db";
import { describe, expect, it } from "vitest";
import { GET as meRoute } from "@/app/api/auth/me/route";
import { POST as switchOrgRoute } from "@/app/api/auth/switch-organisation/route";
import { GET as previewInviteRoute } from "@/app/api/invites/manager/[token]/route";
import {
  DELETE as memberDelete,
  PATCH as memberPatch,
} from "@/app/api/organisations/current/members/[membershipId]/route";
import { POST as acceptRoute } from "@/app/api/organisations/current/members/accept/route";
import { POST as resendRoute } from "@/app/api/organisations/current/members/invite/route";
import { DELETE as revokeInviteRoute } from "@/app/api/organisations/current/members/invites/[inviteId]/route";
import {
  GET as listMembersRoute,
  POST as inviteRoute,
} from "@/app/api/organisations/current/members/route";
import { POST as dismissRoute } from "@/app/api/organisations/current/onboarding/dismiss/route";
import { GET as onboardingRoute } from "@/app/api/organisations/current/onboarding/route";
import {
  GET as currentOrgGet,
  PATCH as currentOrgPatch,
} from "@/app/api/organisations/current/route";
import { GET as listOrgsRoute, POST as createOrgRoute } from "@/app/api/organisations/route";
import { ORG_COOKIE, SESSION_COOKIE } from "@/lib/cookies";
import { resetEnvCache } from "@/lib/env";
import {
  CookieJar,
  addMember,
  callRoute,
  createTestDevice,
  createTestOrg,
  createTestUser,
  lastEmailToken,
  loginAs,
  testEmails,
  uniqueEmail,
  type ErrorBody,
} from "../helpers";

interface OrgBody {
  organisation: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
    dateFormat: string;
    settings: Record<string, unknown>;
    onboardingDismissedAt: string | null;
  };
}

describe("create organisation", () => {
  it("creates the organisation, OWNER membership, first location and an ACTIVE WORD-#### join code", async () => {
    const { user } = await createTestUser();
    const jar = await loginAs(user);
    const res = await callRoute<OrgBody & { joinCode: { code: string; status: string } }>(
      createOrgRoute,
      {
        method: "POST",
        path: "/api/organisations",
        jar,
        body: {
          name: "Harpenden Coffee Co.",
          timezone: "Europe/London",
          firstLocationName: "High Street",
        },
      },
    );
    expect(res.status).toBe(201);
    const orgId = res.body.organisation.id;
    expect(res.body.organisation).toMatchObject({
      name: "Harpenden Coffee Co.",
      timezone: "Europe/London",
      dateFormat: "DMY",
      settings: { weekStartsOn: "MONDAY", timeFormat: "H24", requireInviteCodeToJoin: false },
      onboardingDismissedAt: null,
    });
    expect(res.body.organisation.slug).toMatch(/^harpenden-coffee-co(-[a-z0-9]+)?$/);
    expect(res.body.joinCode.code).toMatch(/^[A-Z]{4,5}-\d{4}$/);
    expect(jar.get(ORG_COOKIE)).toBe(orgId);

    const membership = await prisma.organisationMembership.findUniqueOrThrow({
      where: { userId_organisationId: { userId: user.id, organisationId: orgId } },
    });
    expect(membership.role).toBe("OWNER");
    const codes = await prisma.companyJoinCode.findMany({ where: { organisationId: orgId } });
    expect(codes).toHaveLength(1);
    expect(codes[0]).toMatchObject({ status: "ACTIVE", createdById: user.id });
    expect(
      await prisma.location.count({ where: { organisationId: orgId, name: "High Street" } }),
    ).toBe(1);
    const org = await prisma.organisation.findUniqueOrThrow({ where: { id: orgId } });
    expect(org.onboardingState).toMatchObject({ createCompany: true });
    const auditRow = await prisma.auditLog.findFirst({
      where: { organisationId: orgId, action: "organisation.created" },
    });
    expect(auditRow?.actorUserId).toBe(user.id);

    const me = await callRoute<{
      organisations: Array<{ id: string; role: string }>;
      currentOrganisationId: string;
    }>(meRoute, { path: "/api/auth/me", jar });
    expect(me.body.organisations).toEqual([expect.objectContaining({ id: orgId, role: "OWNER" })]);
    expect(me.body.currentOrganisationId).toBe(orgId);

    const list = await callRoute<{ organisations: Array<{ id: string; role: string }> }>(
      listOrgsRoute,
      {
        path: "/api/organisations",
        jar,
      },
    );
    expect(list.body.organisations.map((o) => o.id)).toEqual([orgId]);
  });

  it("gives organisations with the same name distinct slugs", async () => {
    const a = await createTestOrg({ name: "Same Name Cafe" });
    const b = await createTestOrg({ name: "Same Name Cafe" });
    expect(a.organisation.slug).not.toBe(b.organisation.slug);
    expect(b.organisation.slug.startsWith("same-name-cafe")).toBe(true);
  });

  it("rejects an invalid timezone", async () => {
    const { user } = await createTestUser();
    const jar = await loginAs(user);
    const res = await callRoute<ErrorBody>(createOrgRoute, {
      method: "POST",
      path: "/api/organisations",
      jar,
      body: { name: "Bad TZ", timezone: "Mars/Olympus" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("requires a verified email when REQUIRE_EMAIL_VERIFICATION is on", async () => {
    process.env.REQUIRE_EMAIL_VERIFICATION = "true";
    resetEnvCache();
    const { user } = await createTestUser({ verified: false });
    const jar = await loginAs(user);
    const body = { name: "Unverified Co", timezone: "Europe/London" };
    const blocked = await callRoute<ErrorBody>(createOrgRoute, {
      method: "POST",
      path: "/api/organisations",
      jar,
      body,
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("EMAIL_NOT_VERIFIED");
    expect(await prisma.organisationMembership.count({ where: { userId: user.id } })).toBe(0);

    await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    const created = await callRoute(createOrgRoute, {
      method: "POST",
      path: "/api/organisations",
      jar,
      body,
    });
    expect(created.status).toBe(201);
  });

  it("org-scoped routes return NO_ORGANISATION before the manager has one", async () => {
    const { user } = await createTestUser();
    const jar = await loginAs(user);
    const res = await callRoute<ErrorBody>(currentOrgGet, {
      path: "/api/organisations/current",
      jar,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("NO_ORGANISATION");
  });
});

describe("current organisation", () => {
  it("GET returns the organisation and the caller's permissions; PATCH updates and audits", async () => {
    const org = await createTestOrg();
    const jar = await loginAs(org.owner, { organisationId: org.organisation.id });

    const get = await callRoute<
      OrgBody & {
        membership: { role: string; permissions: string[] };
        joinCode: { code: string } | null;
      }
    >(currentOrgGet, { path: "/api/organisations/current", jar });
    expect(get.status).toBe(200);
    expect(get.body.joinCode?.code).toBe(org.joinCode.code);
    expect(get.body.organisation.id).toBe(org.organisation.id);
    expect(get.body.membership.role).toBe("OWNER");
    expect(get.body.membership.permissions).toContain("org:manage");

    const patch = await callRoute<OrgBody>(currentOrgPatch, {
      method: "PATCH",
      path: "/api/organisations/current",
      jar,
      body: {
        name: "Renamed Ltd",
        timezone: "America/New_York",
        dateFormat: "MDY",
        settings: { timeFormat: "H12" },
      },
    });
    expect(patch.status).toBe(200);
    expect(patch.body.organisation).toMatchObject({
      name: "Renamed Ltd",
      timezone: "America/New_York",
      dateFormat: "MDY",
      settings: { timeFormat: "H12", weekStartsOn: "MONDAY", requireInviteCodeToJoin: false },
    });
    const auditRow = await prisma.auditLog.findFirstOrThrow({
      where: { organisationId: org.organisation.id, action: "organisation.updated" },
    });
    expect(auditRow.actorUserId).toBe(org.owner.id);
    expect(auditRow.ip).toBe(null);
    expect(auditRow.before).toMatchObject({ timezone: "Europe/London" });
    expect(auditRow.after).toMatchObject({ timezone: "America/New_York", name: "Renamed Ltd" });
  });

  it("onboarding is computed from real data and can be dismissed", async () => {
    const org = await createTestOrg();
    const jar = await loginAs(org.owner, { organisationId: org.organisation.id });
    type Onboarding = {
      items: Array<{ key: string; done: boolean }>;
      completedCount: number;
      dismissedAt: string | null;
    };

    const initial = await callRoute<Onboarding>(onboardingRoute, {
      path: "/api/organisations/current/onboarding",
      jar,
    });
    expect(initial.status).toBe(200);
    const done = (body: Onboarding) => body.items.filter((i) => i.done).map((i) => i.key);
    expect(done(initial.body)).toEqual(["createCompany"]);
    expect(initial.body.dismissedAt).toBeNull();

    await createTestDevice(org.organisation.id); // creates an employee + an active device
    const after = await callRoute<Onboarding>(onboardingRoute, {
      path: "/api/organisations/current/onboarding",
      jar,
    });
    expect(done(after.body)).toEqual(["createCompany", "addEmployees", "employeesConnect"]);

    const dismissed = await callRoute<Onboarding>(dismissRoute, {
      method: "POST",
      path: "/api/organisations/current/onboarding/dismiss",
      jar,
    });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.dismissedAt).not.toBeNull();
    const org2 = await callRoute<OrgBody>(currentOrgGet, {
      path: "/api/organisations/current",
      jar,
    });
    expect(org2.body.organisation.onboardingDismissedAt).toBe(dismissed.body.dismissedAt);
  });
});

describe("manager invites and roles", () => {
  it("invite → preview → accept as a new user → MANAGER permissions apply", async () => {
    const org = await createTestOrg({ name: "Invite Co" });
    const ownerJar = await loginAs(org.owner, { organisationId: org.organisation.id });
    const email = uniqueEmail("invitee");

    const invite = await callRoute<{ invite: { id: string; status: string; role: string } }>(
      inviteRoute,
      {
        method: "POST",
        path: "/api/organisations/current/members",
        jar: ownerJar,
        body: { email, role: "MANAGER" },
      },
    );
    expect(invite.status).toBe(201);
    expect(invite.body.invite).toMatchObject({ status: "PENDING", role: "MANAGER" });
    expect(JSON.stringify(invite.body)).not.toMatch(/token/i);
    const token = lastEmailToken(email, "/accept-invite");
    expect(testEmails().last(email)?.text).toContain("Invite Co");

    const preview = await callRoute<{
      email: string;
      requiresAccount: boolean;
      status: string;
      organisation: { name: string };
    }>(previewInviteRoute, { path: `/api/invites/manager/${token}`, params: { token } });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      email,
      requiresAccount: true,
      status: "PENDING",
      organisation: { name: "Invite Co" },
    });

    const missingFields = await callRoute<ErrorBody>(acceptRoute, {
      method: "POST",
      path: "/api/organisations/current/members/accept",
      body: { token },
    });
    expect(missingFields.status).toBe(400);
    expect(missingFields.body.error.code).toBe("VALIDATION_ERROR");

    const jar = new CookieJar();
    const accepted = await callRoute<{
      organisation: { id: string };
      role: string;
      createdAccount: boolean;
    }>(acceptRoute, {
      method: "POST",
      path: "/api/organisations/current/members/accept",
      jar,
      body: { token, name: "New Manager", password: "Invited-pass-123" },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({
      organisation: { id: org.organisation.id },
      role: "MANAGER",
      createdAccount: true,
    });
    expect(jar.get(ORG_COOKIE)).toBe(org.organisation.id);
    const newUser = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(newUser.emailVerifiedAt).not.toBeNull();

    // The new manager can read but not manage the organisation or invite others.
    expect(
      (await callRoute(currentOrgGet, { path: "/api/organisations/current", jar })).status,
    ).toBe(200);
    const patch = await callRoute<ErrorBody>(currentOrgPatch, {
      method: "PATCH",
      path: "/api/organisations/current",
      jar,
      body: { name: "Hijacked" },
    });
    expect(patch.status).toBe(403);
    expect(patch.body.error.code).toBe("FORBIDDEN");
    const inviteAttempt = await callRoute<ErrorBody>(inviteRoute, {
      method: "POST",
      path: "/api/organisations/current/members",
      jar,
      body: { email: uniqueEmail("x"), role: "MANAGER" },
    });
    expect(inviteAttempt.status).toBe(403);

    // The token is single-use.
    const reuse = await callRoute<ErrorBody>(acceptRoute, {
      method: "POST",
      path: "/api/organisations/current/members/accept",
      body: { token, name: "Again", password: "Invited-pass-123" },
    });
    expect(reuse.body.error.code).toBe("INVITE_INVALID");

    const members = await callRoute<{
      members: Array<{ email: string; role: string; isCurrentUser: boolean }>;
      invites: Array<{ status: string }>;
    }>(listMembersRoute, { path: "/api/organisations/current/members", jar: ownerJar });
    expect(members.body.members.map((m) => m.role).sort()).toEqual(["MANAGER", "OWNER"]);
    expect(members.body.members.find((m) => m.isCurrentUser)?.role).toBe("OWNER");
    expect(members.body.invites[0]?.status).toBe("ACCEPTED");
  });

  it("an existing account must prove ownership (session or password) to accept", async () => {
    const org = await createTestOrg();
    const ownerJar = await loginAs(org.owner, { organisationId: org.organisation.id });
    const existing = await createTestUser();
    await callRoute(inviteRoute, {
      method: "POST",
      path: "/api/organisations/current/members",
      jar: ownerJar,
      body: { email: existing.user.email, role: "ADMIN" },
    });
    const token = lastEmailToken(existing.user.email, "/accept-invite");

    const anonymous = await callRoute<ErrorBody>(acceptRoute, {
      method: "POST",
      path: "/api/organisations/current/members/accept",
      body: { token },
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.details).toMatchObject({ requiresLogin: true });

    const wrongPassword = await callRoute<ErrorBody>(acceptRoute, {
      method: "POST",
      path: "/api/organisations/current/members/accept",
      body: { token, password: "not-the-password-1" },
    });
    expect(wrongPassword.body.error.code).toBe("INVALID_CREDENTIALS");

    const jar = await loginAs(existing);
    const accepted = await callRoute<{ role: string; createdAccount: boolean }>(acceptRoute, {
      method: "POST",
      path: "/api/organisations/current/members/accept",
      jar,
      body: { token },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ role: "ADMIN", createdAccount: false });
    const membership = await prisma.organisationMembership.findUniqueOrThrow({
      where: {
        userId_organisationId: { userId: existing.user.id, organisationId: org.organisation.id },
      },
    });
    expect(membership.role).toBe("ADMIN");
  });

  it("cannot invite above your own role; revoke and resend rotate links", async () => {
    const org = await createTestOrg();
    const admin = await createTestUser();
    await addMember(org.organisation.id, admin.user, "ADMIN");
    const adminJar = await loginAs(admin, { organisationId: org.organisation.id });

    const ownerInvite = await callRoute<ErrorBody>(inviteRoute, {
      method: "POST",
      path: "/api/organisations/current/members",
      jar: adminJar,
      body: { email: uniqueEmail("boss"), role: "OWNER" },
    });
    expect(ownerInvite.status).toBe(403);

    const email = uniqueEmail("rotate");
    const created = await callRoute<{ invite: { id: string } }>(inviteRoute, {
      method: "POST",
      path: "/api/organisations/current/members",
      jar: adminJar,
      body: { email, role: "MANAGER" },
    });
    const firstToken = lastEmailToken(email, "/accept-invite");
    const resent = await callRoute<{ invite: { status: string } }>(resendRoute, {
      method: "POST",
      path: "/api/organisations/current/members/invite",
      jar: adminJar,
      body: { inviteId: created.body.invite.id },
    });
    expect(resent.status).toBe(200);
    const secondToken = lastEmailToken(email, "/accept-invite");
    expect(secondToken).not.toBe(firstToken);
    const oldPreview = await callRoute<ErrorBody>(previewInviteRoute, {
      path: `/api/invites/manager/${firstToken}`,
      params: { token: firstToken },
    });
    expect(oldPreview.status).toBe(404);

    const revoked = await callRoute<{ invite: { status: string } }>(revokeInviteRoute, {
      method: "DELETE",
      path: `/api/organisations/current/members/invites/${created.body.invite.id}`,
      jar: adminJar,
      params: { inviteId: created.body.invite.id },
    });
    expect(revoked.body.invite.status).toBe("REVOKED");
    const accept = await callRoute<ErrorBody>(acceptRoute, {
      method: "POST",
      path: "/api/organisations/current/members/accept",
      body: { token: secondToken, name: "Late", password: "Invited-pass-123" },
    });
    expect(accept.body.error.code).toBe("INVITE_INVALID");
  });

  it("expired invites cannot be accepted", async () => {
    const org = await createTestOrg();
    const ownerJar = await loginAs(org.owner, { organisationId: org.organisation.id });
    const email = uniqueEmail("late");
    await callRoute(inviteRoute, {
      method: "POST",
      path: "/api/organisations/current/members",
      jar: ownerJar,
      body: { email, role: "MANAGER" },
    });
    const token = lastEmailToken(email, "/accept-invite");
    await prisma.managerInvite.updateMany({
      where: { email },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await callRoute<ErrorBody>(acceptRoute, {
      method: "POST",
      path: "/api/organisations/current/members/accept",
      body: { token, name: "Late", password: "Invited-pass-123" },
    });
    expect(res.body.error.code).toBe("INVITE_EXPIRED");
  });
});

describe("last-owner protection", () => {
  it("cannot demote or remove the last OWNER; can once another owner exists", async () => {
    const org = await createTestOrg();
    const ownerJar = await loginAs(org.owner, { organisationId: org.organisation.id });

    const demote = await callRoute<ErrorBody>(memberPatch, {
      method: "PATCH",
      path: `/api/organisations/current/members/${org.membership.id}`,
      jar: ownerJar,
      params: { membershipId: org.membership.id },
      body: { role: "ADMIN" },
    });
    expect(demote.status).toBe(409);
    expect(demote.body.error.code).toBe("LAST_OWNER");

    const leave = await callRoute<ErrorBody>(memberDelete, {
      method: "DELETE",
      path: `/api/organisations/current/members/${org.membership.id}`,
      jar: ownerJar,
      params: { membershipId: org.membership.id },
    });
    expect(leave.status).toBe(409);
    expect(leave.body.error.code).toBe("LAST_OWNER");

    // An ADMIN cannot touch an OWNER or grant OWNER.
    const admin = await createTestUser();
    const adminMembership = await addMember(org.organisation.id, admin.user, "ADMIN");
    const adminJar = await loginAs(admin, { organisationId: org.organisation.id });
    const adminDemotesOwner = await callRoute<ErrorBody>(memberPatch, {
      method: "PATCH",
      path: `/api/organisations/current/members/${org.membership.id}`,
      jar: adminJar,
      params: { membershipId: org.membership.id },
      body: { role: "MANAGER" },
    });
    expect(adminDemotesOwner.status).toBe(403);
    const adminSelfPromote = await callRoute<ErrorBody>(memberPatch, {
      method: "PATCH",
      path: `/api/organisations/current/members/${adminMembership.id}`,
      jar: adminJar,
      params: { membershipId: adminMembership.id },
      body: { role: "OWNER" },
    });
    expect(adminSelfPromote.status).toBe(403);

    // The owner promotes the admin; now the original owner may step down.
    const promote = await callRoute<{ member: { role: string } }>(memberPatch, {
      method: "PATCH",
      path: `/api/organisations/current/members/${adminMembership.id}`,
      jar: ownerJar,
      params: { membershipId: adminMembership.id },
      body: { role: "OWNER" },
    });
    expect(promote.body.member.role).toBe("OWNER");
    const stepDown = await callRoute<{ member: { role: string } }>(memberPatch, {
      method: "PATCH",
      path: `/api/organisations/current/members/${org.membership.id}`,
      jar: ownerJar,
      params: { membershipId: org.membership.id },
      body: { role: "ADMIN" },
    });
    expect(stepDown.status).toBe(200);
    expect(stepDown.body.member.role).toBe("ADMIN");

    const audits = await prisma.auditLog.count({
      where: { organisationId: org.organisation.id, action: "member.role_changed" },
    });
    expect(audits).toBe(2);
  });

  it("concurrent demotions of two owners leave exactly one owner", async () => {
    const org = await createTestOrg();
    const second = await createTestUser();
    const secondMembership = await addMember(org.organisation.id, second.user, "OWNER");
    const jarA = await loginAs(org.owner, { organisationId: org.organisation.id });
    const jarB = await loginAs(second, { organisationId: org.organisation.id });
    const [a, b] = await Promise.all([
      callRoute(memberPatch, {
        method: "PATCH",
        path: "/x",
        jar: jarA,
        params: { membershipId: org.membership.id },
        body: { role: "ADMIN" },
      }),
      callRoute(memberPatch, {
        method: "PATCH",
        path: "/x",
        jar: jarB,
        params: { membershipId: secondMembership.id },
        body: { role: "ADMIN" },
      }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(
      await prisma.organisationMembership.count({
        where: { organisationId: org.organisation.id, role: "OWNER" },
      }),
    ).toBe(1);
  });

  it("a member can leave; removing others needs members:invite", async () => {
    const org = await createTestOrg();
    const manager = await createTestUser();
    const managerMembership = await addMember(org.organisation.id, manager.user, "MANAGER");
    const other = await createTestUser();
    const otherMembership = await addMember(org.organisation.id, other.user, "MANAGER");
    const managerJar = await loginAs(manager, { organisationId: org.organisation.id });

    const removeOther = await callRoute<ErrorBody>(memberDelete, {
      method: "DELETE",
      path: "/x",
      jar: managerJar,
      params: { membershipId: otherMembership.id },
    });
    expect(removeOther.status).toBe(403);

    const leave = await callRoute<{ ok: boolean; removedSelf: boolean }>(memberDelete, {
      method: "DELETE",
      path: "/x",
      jar: managerJar,
      params: { membershipId: managerMembership.id },
    });
    expect(leave.body).toEqual({ ok: true, removedSelf: true });
    const afterLeave = await callRoute<ErrorBody>(currentOrgGet, {
      path: "/api/organisations/current",
      jar: managerJar,
    });
    expect(afterLeave.body.error.code).toBe("NO_ORGANISATION");
  });
});

describe("organisation switching and cross-tenant access", () => {
  it("a member of org B cannot select or read org A", async () => {
    const orgA = await createTestOrg({ name: "Org A" });
    const orgB = await createTestOrg({ name: "Org B" });
    const jarB = await loginAs(orgB.owner, { organisationId: orgB.organisation.id });

    const switched = await callRoute<ErrorBody>(switchOrgRoute, {
      method: "POST",
      path: "/api/auth/switch-organisation",
      jar: jarB,
      body: { organisationId: orgA.organisation.id },
    });
    expect(switched.status).toBe(404);
    expect(switched.body.error.code).toBe("NOT_FOUND");
    expect(jarB.get(ORG_COOKIE)).toBe(orgB.organisation.id);

    // Forging the selection cookie degrades to the caller's own organisation, never org A.
    const forged = jarB.clone();
    forged.set(ORG_COOKIE, orgA.organisation.id);
    const get = await callRoute<OrgBody>(currentOrgGet, {
      path: "/api/organisations/current",
      jar: forged,
    });
    expect(get.status).toBe(200);
    expect(get.body.organisation.id).toBe(orgB.organisation.id);
    const patch = await callRoute<OrgBody>(currentOrgPatch, {
      method: "PATCH",
      path: "/api/organisations/current",
      jar: forged,
      body: { name: "Org B renamed" },
    });
    expect(patch.body.organisation.id).toBe(orgB.organisation.id);
    const a = await prisma.organisation.findUniqueOrThrow({ where: { id: orgA.organisation.id } });
    expect(a.name).toBe("Org A");
  });

  it("a manager in two organisations can switch between them", async () => {
    const orgA = await createTestOrg({ name: "First" });
    const orgB = await createTestOrg({ name: "Second" });
    await addMember(orgB.organisation.id, orgA.owner, "MANAGER");
    const jar = await loginAs(orgA.owner, { organisationId: orgA.organisation.id });

    const switched = await callRoute(switchOrgRoute, {
      method: "POST",
      path: "/api/auth/switch-organisation",
      jar,
      body: { organisationId: orgB.organisation.id },
    });
    expect(switched.status).toBe(200);
    expect(jar.get(ORG_COOKIE)).toBe(orgB.organisation.id);
    const get = await callRoute<OrgBody & { membership: { role: string } }>(currentOrgGet, {
      path: "/api/organisations/current",
      jar,
    });
    expect(get.body.organisation.id).toBe(orgB.organisation.id);
    expect(get.body.membership.role).toBe("MANAGER");
    expect(jar.get(SESSION_COOKIE)).toBeTruthy();
  });
});
