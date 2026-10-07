import { prisma } from "@clockoff/db";
import { expect } from "vitest";
import { POST as readRoute } from "@/app/api/notifications/[id]/read/route";
import { registerTenantIsolationCase } from "../../helpers/tenantIsolation";

/** Notifications: org A's owner cannot touch a notification addressed to org B's owner. */

registerTenantIsolationCase({
  name: "POST /api/notifications/:id/read of another tenant",
  build: async (_a, b) => {
    const notification = await prisma.notification.create({
      data: {
        organisationId: b.organisation.id,
        recipientType: "MANAGER_USER",
        recipientId: b.owner.id,
        type: "EMPLOYEE_JOINED",
        title: "B only",
        body: "Someone joined",
      },
    });
    return {
      handler: readRoute,
      method: "POST",
      path: `/api/notifications/${notification.id}/read`,
      params: { id: notification.id },
      body: {},
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (_a, b) => {
    const row = await prisma.notification.findFirstOrThrow({
      where: { organisationId: b.organisation.id },
    });
    expect(row.readAt).toBeNull();
  },
});
