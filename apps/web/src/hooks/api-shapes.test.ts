import { NOTIFICATION_PREFERENCE_DEFAULTS } from "@workmode/validation/notifications";
import { ORGANISATION_SETTINGS_DEFAULTS } from "@workmode/validation/organisation";
import { describe, expect, it } from "vitest";
import { ApiClientError } from "@/lib/api-client";
import {
  normalizeAcceptInvite,
  normalizeBilling,
  normalizeCurrentOrganisation,
  normalizeInvitePreview,
  normalizeJoinCode,
  normalizeMembers,
  normalizeNotificationPreferences,
  normalizeNotifications,
  normalizeOnboarding,
  parseResponse,
} from "./api-shapes";
import { z } from "zod";

const ORG_ID = "6f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a10";
const USER_ID = "0b3c9a6e-8a55-4f0e-a3f8-7f3c1d2e4b5a";
const MEMBERSHIP_ID = "9d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

function expectInvalidResponse(fn: () => unknown, endpoint: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).code).toBe("INVALID_RESPONSE");
    expect((error as ApiClientError).message).toContain(endpoint);
    return;
  }
  throw new Error("expected INVALID_RESPONSE");
}

describe("parseResponse", () => {
  it("returns parsed data or throws INVALID_RESPONSE naming the endpoint", () => {
    expect(parseResponse(z.object({ a: z.number() }), { a: 1 }, "GET /x")).toEqual({ a: 1 });
    expectInvalidResponse(
      () => parseResponse(z.object({ a: z.number() }), { a: "1" }, "GET /x"),
      "GET /x",
    );
  });
});

describe("normalizeCurrentOrganisation", () => {
  const organisation = {
    id: ORG_ID,
    name: "Harbour Café",
    slug: "harbour-cafe",
    timezone: "Europe/London",
    dateFormat: "DMY",
    plan: "BUSINESS",
    billingStatus: "ACTIVE",
    settings: { weekStartsOn: "SUNDAY", timeFormat: "H12", requireInviteCodeToJoin: true },
  };

  it("reads the full API shape (organisation, membership, join code)", () => {
    const result = normalizeCurrentOrganisation({
      organisation,
      membership: { id: MEMBERSHIP_ID, role: "ADMIN", permissions: ["org:manage"] },
      joinCode: { id: ORG_ID, code: "HARB-42", status: "ACTIVE" },
    });
    expect(result.role).toBe("ADMIN");
    expect(result.membershipId).toBe(MEMBERSHIP_ID);
    expect(result.joinCode).toBe("HARB-42");
    expect(result.organisation.settings).toEqual({
      weekStartsOn: "SUNDAY",
      timeFormat: "H12",
      requireInviteCodeToJoin: true,
    });
    expect(result.organisation.plan).toBe("BUSINESS");
  });

  it("tolerates the minimal contract shape and fills defaults", () => {
    const result = normalizeCurrentOrganisation({
      organisation: {
        id: ORG_ID,
        name: "Harbour",
        timezone: "UTC",
        dateFormat: "XYZ",
        plan: "GOLD",
        billingStatus: "TRIAL",
      },
      membership: { role: "OWNER" },
      joinCode: null,
    });
    expect(result.membershipId).toBeNull();
    expect(result.joinCode).toBeNull();
    expect(result.organisation.dateFormat).toBe("DMY");
    expect(result.organisation.plan).toBe("STARTER");
    expect(result.organisation.slug).toBe("");
    expect(result.organisation.settings).toEqual(ORGANISATION_SETTINGS_DEFAULTS);
  });

  it("rejects a body without an organisation", () => {
    expectInvalidResponse(
      () => normalizeCurrentOrganisation({ ok: true }),
      "/api/organisations/current",
    );
  });
});

describe("normalizeJoinCode", () => {
  it("accepts every known envelope", () => {
    expect(normalizeJoinCode({ current: { code: "A1" }, history: [] })).toBe("A1");
    expect(normalizeJoinCode({ current: null, history: [] })).toBeNull();
    expect(normalizeJoinCode({ joinCode: { code: "B2" } })).toBe("B2");
    expect(normalizeJoinCode({ code: "C3" })).toBe("C3");
  });
});

describe("normalizeMembers", () => {
  const member = {
    id: MEMBERSHIP_ID,
    userId: USER_ID,
    name: "Ada Lovelace",
    email: "ada@example.com",
    role: "OWNER",
    emailVerified: true,
    lastLoginAt: null,
    joinedAt: "2026-10-01T09:00:00.000Z",
    isCurrentUser: true,
  };
  const invite = (status: string) => ({
    id: `${status}-id`,
    email: `${status.toLowerCase()}@example.com`,
    role: "MANAGER",
    status,
    invitedBy: null,
    expiresAt: "2026-10-08T09:00:00.000Z",
    acceptedAt: null,
    revokedAt: null,
    createdAt: "2026-10-01T09:00:00.000Z",
  });

  it("reads `{ members, invites }` and keeps only invites that can still be acted on", () => {
    const result = normalizeMembers({
      members: [member],
      invites: [invite("PENDING"), invite("EXPIRED"), invite("ACCEPTED"), invite("REVOKED")],
    });
    expect(result.members).toEqual([
      {
        id: MEMBERSHIP_ID,
        userId: USER_ID,
        name: "Ada Lovelace",
        email: "ada@example.com",
        role: "OWNER",
        joinedAt: "2026-10-01T09:00:00.000Z",
        lastLoginAt: null,
        isCurrentUser: true,
      },
    ]);
    expect(result.pendingInvites.map((i) => i.status)).toEqual(["PENDING", "EXPIRED"]);
  });

  it("ignores invites in a state it doesn't know instead of failing the whole list", () => {
    const result = normalizeMembers({
      members: [member],
      invites: [invite("PENDING"), invite("ON_HOLD")],
    });
    expect(result.members).toHaveLength(1);
    expect(result.pendingInvites.map((i) => i.status)).toEqual(["PENDING"]);
  });

  it("reads the `{ items }` contract shape with createdAt", () => {
    const result = normalizeMembers({
      items: [
        {
          id: MEMBERSHIP_ID,
          userId: USER_ID,
          name: "Ada",
          email: "ada@example.com",
          role: "MANAGER",
          createdAt: "2026-10-01T09:00:00Z",
        },
      ],
    });
    expect(result.members[0]?.joinedAt).toBe("2026-10-01T09:00:00Z");
    expect(result.members[0]?.isCurrentUser).toBeNull();
    expect(result.pendingInvites).toEqual([]);
  });

  it("rejects unknown roles", () => {
    expectInvalidResponse(
      () => normalizeMembers({ members: [{ ...member, role: "SUPERUSER" }] }),
      "members",
    );
  });
});

describe("normalizeInvitePreview / normalizeAcceptInvite", () => {
  it("reads both preview shapes", () => {
    const common = {
      email: "new@example.com",
      role: "ADMIN",
      expiresAt: "2026-10-08T09:00:00Z",
      requiresAccount: true,
    };
    expect(
      normalizeInvitePreview({
        ...common,
        organisation: { name: "Harbour" },
        invitedByName: "Ada",
        status: "PENDING",
      }),
    ).toEqual({
      ...common,
      organisationName: "Harbour",
      invitedByName: "Ada",
      status: "PENDING",
    });
    expect(normalizeInvitePreview({ ...common, organisationName: "Harbour" })).toEqual({
      ...common,
      organisationName: "Harbour",
      invitedByName: null,
      status: null,
    });
  });

  it("types the invite state, leaving states this UI doesn't know to the API", () => {
    const base = {
      email: "new@example.com",
      role: "ADMIN",
      expiresAt: "2026-10-08T09:00:00Z",
      requiresAccount: false,
      organisation: { name: "H" },
    };
    for (const status of ["PENDING", "ACCEPTED", "EXPIRED", "REVOKED"] as const) {
      expect(normalizeInvitePreview({ ...base, status }).status).toBe(status);
    }
    expect(normalizeInvitePreview({ ...base, status: "SUSPENDED" }).status).toBeNull();
  });

  it("finds the organisation joined in any accept response", () => {
    expect(
      normalizeAcceptInvite({
        organisation: { id: ORG_ID, name: "Harbour" },
        role: "ADMIN",
        createdAccount: true,
        csrfToken: "t",
      }),
    ).toEqual({
      organisationId: ORG_ID,
    });
    expect(normalizeAcceptInvite({ ok: true, organisationId: ORG_ID })).toEqual({
      organisationId: ORG_ID,
    });
    expect(normalizeAcceptInvite({ ok: true })).toEqual({ organisationId: null });
  });
});

describe("normalizeOnboarding", () => {
  const items = [
    { key: "createCompany", label: "Create your company", done: true, href: "/settings" },
    { key: "createPolicy", label: "Create a Work Policy", done: false, href: "/policies/new" },
  ];

  it("never renders a link from the API that leaves the dashboard", () => {
    const hostile = [
      {
        key: "createPolicy",
        label: "Create a Work Policy",
        done: false,
        href: "https://evil.example/",
      },
      { key: "addEmployees", label: "Add employees", done: false, href: "//evil.example" },
      { key: "goLive", label: "Go live", done: false, href: "/dashboard" },
    ];
    expect(normalizeOnboarding({ items: hostile }).items.map((i) => i.href)).toEqual([
      "/overview",
      "/overview",
      "/dashboard",
    ]);
  });

  it("reads the API shape (allDone) and counts progress", () => {
    expect(
      normalizeOnboarding({
        items,
        completedCount: 1,
        totalCount: 2,
        allDone: false,
        dismissedAt: null,
      }),
    ).toEqual({
      items,
      completedCount: 1,
      totalCount: 2,
      complete: false,
      dismissedAt: null,
    });
  });

  it("reads the contract shape (complete) and derives completion when absent", () => {
    expect(
      normalizeOnboarding({ items, complete: true, dismissedAt: "2026-10-02T00:00:00Z" }).complete,
    ).toBe(true);
    expect(normalizeOnboarding({ items: items.map((i) => ({ ...i, done: true })) }).complete).toBe(
      true,
    );
  });
});

describe("normalizeNotifications", () => {
  it("defaults readAt to null and derives unreadCount when absent", () => {
    const feed = normalizeNotifications({
      items: [
        {
          id: "1",
          type: "EMPLOYEE_JOINED",
          title: "Joined",
          body: "Sam joined",
          createdAt: "2026-10-01T09:00:00Z",
        },
        {
          id: "2",
          type: "EMPLOYEE_JOINED",
          title: "Joined",
          body: "Kim joined",
          readAt: "2026-10-01T10:00:00Z",
          createdAt: "2026-10-01T09:00:00Z",
        },
      ],
    });
    expect(feed.items[0]?.readAt).toBeNull();
    expect(feed.unreadCount).toBe(1);
    expect(normalizeNotifications({ items: [], unreadCount: 4 }).unreadCount).toBe(4);
  });
});

describe("normalizeNotificationPreferences", () => {
  it("merges stored preferences over the defaults", () => {
    const prefs = normalizeNotificationPreferences({
      notificationPreferences: { EMPLOYEE_JOINED: { email: true } },
    });
    expect(prefs.EMPLOYEE_JOINED).toEqual({ inApp: true, email: true });
    expect(prefs.INTEGRATION_ERROR).toEqual(NOTIFICATION_PREFERENCE_DEFAULTS.INTEGRATION_ERROR);
  });
});

describe("normalizeBilling", () => {
  const base = {
    plan: "BUSINESS",
    planName: "Business",
    billingStatus: "TRIAL",
    limits: { employees: 50, locations: 5, integrations: "UNLIMITED" },
    usage: { employees: 12, locations: 1, integrations: 0 },
  };

  it("keeps only http(s) management URLs", () => {
    expect(
      normalizeBilling({ ...base, manageUrl: "https://billing.example.com/portal" }).manageUrl,
    ).toBe("https://billing.example.com/portal");
    expect(normalizeBilling({ ...base, manageUrl: "javascript:alert(1)" }).manageUrl).toBeNull();
    expect(normalizeBilling({ ...base, manageUrl: "not a url" }).manageUrl).toBeNull();
    expect(normalizeBilling(base)).toMatchObject({ manageUrl: null, trialEndsAt: null });
  });
});
