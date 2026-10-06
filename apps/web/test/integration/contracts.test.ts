import { currentUserSchema } from "@workmode/validation/auth";
import {
  acceptManagerInviteResponseSchema,
  listMembersResponseSchema,
  managerInvitePreviewResponseSchema,
  managerInviteResponseSchema,
  memberResponseSchema,
  onboardingResponseSchema,
  organisationResponseSchema,
} from "@workmode/validation/organisation";
import { describe, expect, it } from "vitest";
import { GET as meRoute } from "@/app/api/auth/me/route";
import { GET as previewInviteRoute } from "@/app/api/invites/manager/[token]/route";
import { PATCH as memberPatch } from "@/app/api/organisations/current/members/[membershipId]/route";
import { POST as acceptRoute } from "@/app/api/organisations/current/members/accept/route";
import {
  GET as listMembersRoute,
  POST as inviteRoute,
} from "@/app/api/organisations/current/members/route";
import { GET as onboardingRoute } from "@/app/api/organisations/current/onboarding/route";
import {
  GET as currentOrgGet,
  PATCH as currentOrgPatch,
} from "@/app/api/organisations/current/route";
import { POST as createOrgRoute } from "@/app/api/organisations/route";
import {
  CookieJar,
  addMember,
  callRoute,
  createTestOrg,
  createTestUser,
  lastEmailToken,
  loginAs,
  uniqueEmail,
} from "../helpers";

/**
 * Contract tests: responses of this module's endpoints parse with the shared `@workmode/validation`
 * schemas the dashboard and the iOS client are generated from.
 */
describe("response contracts", () => {
  it("auth + organisation + member endpoints match @workmode/validation", async () => {
    const { user } = await createTestUser();
    const jar = await loginAs(user);
    expect(
      currentUserSchema.parse((await callRoute(meRoute, { path: "/api/auth/me", jar })).body),
    ).toBeTruthy();

    const created = await callRoute(createOrgRoute, {
      method: "POST",
      path: "/api/organisations",
      jar,
      body: { name: "Contract Co", timezone: "Europe/London" },
    });
    expect(organisationResponseSchema.parse(created.body)).toBeTruthy();
    expect(
      organisationResponseSchema.parse((await callRoute(currentOrgGet, { path: "/x", jar })).body),
    ).toBeTruthy();
    expect(
      organisationResponseSchema.parse(
        (
          await callRoute(currentOrgPatch, {
            method: "PATCH",
            path: "/x",
            jar,
            body: { settings: { weekStartsOn: "SUNDAY" } },
          })
        ).body,
      ).organisation.settings.weekStartsOn,
    ).toBe("SUNDAY");
    expect(
      onboardingResponseSchema.parse((await callRoute(onboardingRoute, { path: "/x", jar })).body),
    ).toBeTruthy();

    const email = uniqueEmail("contract");
    const invite = await callRoute(inviteRoute, {
      method: "POST",
      path: "/x",
      jar,
      body: { email, role: "ADMIN" },
    });
    expect(managerInviteResponseSchema.parse(invite.body).invite.invitedBy?.id).toBe(user.id);
    const token = lastEmailToken(email, "/accept-invite");
    expect(
      managerInvitePreviewResponseSchema.parse(
        (await callRoute(previewInviteRoute, { path: "/x", params: { token } })).body,
      ),
    ).toBeTruthy();
    const accepted = await callRoute(acceptRoute, {
      method: "POST",
      path: "/x",
      jar: new CookieJar(),
      body: { token, name: "Contract Admin", password: "Contract-pass-1" },
    });
    expect(acceptManagerInviteResponseSchema.parse(accepted.body)).toBeTruthy();

    const members = listMembersResponseSchema.parse(
      (await callRoute(listMembersRoute, { path: "/x", jar })).body,
    );
    expect(members.members).toHaveLength(2);
    const admin = members.members.find((m) => !m.isCurrentUser)!;
    const patched = await callRoute(memberPatch, {
      method: "PATCH",
      path: "/x",
      jar,
      params: { membershipId: admin.id },
      body: { role: "MANAGER" },
    });
    expect(memberResponseSchema.parse(patched.body).member.role).toBe("MANAGER");
  });

  it("a second organisation shows up in /me with the right role", async () => {
    const org = await createTestOrg();
    const other = await createTestOrg();
    await addMember(other.organisation.id, org.owner, "MANAGER");
    const jar = await loginAs(org.owner);
    const me = currentUserSchema.parse(
      (await callRoute(meRoute, { path: "/api/auth/me", jar })).body,
    );
    expect(me.organisations.map((o) => o.role)).toEqual(["OWNER", "MANAGER"]);
    expect(me.currentOrganisationId).toBe(org.organisation.id);
  });
});
