import { prisma } from "@clockoff/db";
import { expect } from "vitest";
import { POST as switchOrgRoute } from "@/app/api/auth/switch-organisation/route";
import {
  DELETE as memberDelete,
  PATCH as memberPatch,
} from "@/app/api/organisations/current/members/[membershipId]/route";
import { POST as resendRoute } from "@/app/api/organisations/current/members/invite/route";
import { DELETE as revokeInviteRoute } from "@/app/api/organisations/current/members/invites/[inviteId]/route";
import { generateToken } from "@/lib/tokens";
import { registerTenantIsolationCase } from "../../helpers/tenantIsolation";

/** Organisation / member endpoints: org A's owner must never reach org B's rows. */

async function createInviteInOrg(organisationId: string, invitedById: string) {
  return prisma.managerInvite.create({
    data: {
      organisationId,
      email: `tenant-${generateToken(4).raw.toLowerCase()}@example.test`,
      role: "MANAGER",
      tokenHash: generateToken(32).hash,
      invitedById,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
}

registerTenantIsolationCase({
  name: "POST /api/auth/switch-organisation to another tenant",
  build: (_a, b) => ({
    handler: switchOrgRoute,
    method: "POST",
    path: "/api/auth/switch-organisation",
    body: { organisationId: b.organisation.id },
  }),
  expectCode: "NOT_FOUND",
});

registerTenantIsolationCase({
  name: "PATCH /api/organisations/current/members/:id of another tenant",
  build: (_a, b) => ({
    handler: memberPatch,
    method: "PATCH",
    path: `/api/organisations/current/members/${b.membership.id}`,
    params: { membershipId: b.membership.id },
    body: { role: "MANAGER" },
  }),
  expectCode: "NOT_FOUND",
  verify: async (_a, b) => {
    const row = await prisma.organisationMembership.findUniqueOrThrow({
      where: { id: b.membership.id },
    });
    expect(row.role).toBe("OWNER");
  },
});

registerTenantIsolationCase({
  name: "DELETE /api/organisations/current/members/:id of another tenant",
  build: (_a, b) => ({
    handler: memberDelete,
    method: "DELETE",
    path: `/api/organisations/current/members/${b.membership.id}`,
    params: { membershipId: b.membership.id },
  }),
  expectCode: "NOT_FOUND",
  verify: async (_a, b) => {
    expect(await prisma.organisationMembership.count({ where: { id: b.membership.id } })).toBe(1);
  },
});

registerTenantIsolationCase({
  name: "POST /api/organisations/current/members/invite (resend) of another tenant's invite",
  build: async (_a, b) => {
    const invite = await createInviteInOrg(b.organisation.id, b.owner.id);
    return {
      handler: resendRoute,
      method: "POST",
      path: "/api/organisations/current/members/invite",
      body: { inviteId: invite.id },
    };
  },
  expectCode: "NOT_FOUND",
});

registerTenantIsolationCase({
  name: "DELETE /api/organisations/current/members/invites/:id of another tenant",
  build: async (_a, b) => {
    const invite = await createInviteInOrg(b.organisation.id, b.owner.id);
    return {
      handler: revokeInviteRoute,
      method: "DELETE",
      path: `/api/organisations/current/members/invites/${invite.id}`,
      params: { inviteId: invite.id },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (_a, b) => {
    const open = await prisma.managerInvite.count({
      where: { organisationId: b.organisation.id, revokedAt: null },
    });
    expect(open).toBe(1);
  },
});
