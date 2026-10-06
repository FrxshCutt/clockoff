import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NOTIFICATION_PREFERENCE_DEFAULTS } from "@workmode/validation/notifications";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { CurrentOrganisation, MembersList } from "@/hooks/api-shapes";
import type { CurrentUser } from "@/hooks/use-current-user";
import type { Availability } from "@/hooks/use-settings";
import type { JoinCodeState } from "./use-join-code";
import { queryKeys } from "@/lib/query-client";
import { JoinCodeSettings } from "./join-code-settings";
import { MembersSettings } from "./members-settings";
import { NotificationSettings } from "./notification-settings";
import { OrganisationSettings } from "./organisation-settings";

/**
 * Server-render the settings tabs against a seeded query cache (no network, no DOM) to check they render the
 * right controls for each role. Mutations and dialogs are exercised in the browser, not here.
 */
const ORG_ID = "6f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a10";

function me(role: "OWNER" | "ADMIN" | "MANAGER"): CurrentUser {
  return {
    user: { id: "0b3c9a6e-8a55-4f0e-a3f8-7f3c1d2e4b5a", email: "ada@example.com", name: "Ada Lovelace", emailVerified: true, createdAt: "2026-10-01T09:00:00Z" },
    organisations: [{ id: ORG_ID, name: "Harbour Café", slug: "harbour-cafe", role, timezone: "Europe/London" }],
    currentOrganisationId: ORG_ID,
    csrfToken: "csrf",
  };
}

const ORGANISATION: CurrentOrganisation = {
  organisation: {
    id: ORG_ID,
    name: "Harbour Café",
    slug: "harbour-cafe",
    timezone: "Europe/London",
    dateFormat: "DMY",
    plan: "BUSINESS",
    billingStatus: "ACTIVE",
    settings: { weekStartsOn: "MONDAY", timeFormat: "H24", requireInviteCodeToJoin: false },
  },
  role: "OWNER",
  membershipId: "9d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  joinCode: "HARB42",
};

const MEMBERS: MembersList = {
  members: [
    { id: "m1", userId: "u1", name: "Ada Lovelace", email: "ada@example.com", role: "OWNER", joinedAt: "2026-10-01T09:00:00Z", lastLoginAt: null, isCurrentUser: true },
    { id: "m2", userId: "u2", name: "Grace Hopper", email: "grace@example.com", role: "MANAGER", joinedAt: "2026-10-02T09:00:00Z", lastLoginAt: "2026-10-05T09:00:00Z", isCurrentUser: false },
  ],
  pendingInvites: [
    { id: "i1", email: "new@example.com", role: "ADMIN", status: "PENDING", expiresAt: "2026-10-09T09:00:00Z" },
    { id: "i2", email: "late@example.com", role: "MANAGER", status: "EXPIRED", expiresAt: "2026-10-01T09:00:00Z" },
  ],
};

function render(node: ReactNode, role: "OWNER" | "ADMIN" | "MANAGER", seed: (client: QueryClient) => void = () => undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.currentUser, me(role));
  client.setQueryData(queryKeys.currentOrganisation, { ...ORGANISATION, role });
  seed(client);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("Settings → Organisation", () => {
  it("renders an editable form for owners, prefilled from the organisation", () => {
    const html = render(<OrganisationSettings />, "OWNER");
    expect(html).toContain('value="Harbour Café"');
    expect(html).toContain("Europe / London");
    expect(html).toContain("Save changes");
    expect(html).not.toContain("View only");
  });

  it("is read-only for managers", () => {
    const html = render(<OrganisationSettings />, "MANAGER");
    expect(html).toContain("View only");
    expect(html).not.toContain("Save changes");
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*value="Harbour Café"|<input[^>]*value="Harbour Café"[^>]*disabled=""/);
  });
});

const JOIN_CODES: JoinCodeState = {
  available: true,
  data: {
    current: {
      id: "c2",
      code: "HARB42",
      status: "ACTIVE",
      createdBy: { id: "u1", name: "Ada Lovelace" },
      createdAt: "2026-10-03T09:00:00Z",
      revokedAt: null,
    },
    history: [
      { id: "c1", code: "BREW-4821", status: "REVOKED", createdBy: null, createdAt: "2026-10-01T09:00:00Z", revokedAt: "2026-10-03T09:00:00Z" },
    ],
  },
};

describe("Settings → Join code", () => {
  it("shows the code with copy, regenerate, revoke and the history for owners", () => {
    const html = render(<JoinCodeSettings />, "OWNER", (client) => client.setQueryData(queryKeys.joinCode, JOIN_CODES));
    expect(html).toContain("HARB42");
    expect(html).toMatch(/<button[^>]*title="Copy join code"[^>]*>[\s\S]*?Copy</);
    expect(html).toContain("Regenerate");
    expect(html).toContain("Revoke");
    expect(html).toContain("BREW-4821");
    expect(html).toContain("Revoked");
    expect(html).toContain("by Ada Lovelace");
  });

  it("hides management actions from managers", () => {
    const html = render(<JoinCodeSettings />, "MANAGER", (client) => client.setQueryData(queryKeys.joinCode, JOIN_CODES));
    expect(html).toContain("HARB42");
    expect(html).not.toContain("Regenerate");
  });

  it("falls back to the organisation's active code while the history endpoint is unavailable", () => {
    const html = render(<JoinCodeSettings />, "OWNER", (client) =>
      client.setQueryData<JoinCodeState>(queryKeys.joinCode, { available: false, data: null }),
    );
    expect(html).toContain("HARB42");
    expect(html).toContain("Code history isn&#x27;t available yet");
  });
});

describe("Settings → Managers", () => {
  it("lists members and open invites, with actions only where allowed", () => {
    const html = render(<MembersSettings />, "OWNER", (client) => client.setQueryData(queryKeys.members, MEMBERS));
    expect(html).toContain("Grace Hopper");
    expect(html).toContain("Invite manager");
    expect(html).toContain('aria-label="Actions for Grace Hopper"');
    expect(html).not.toContain('aria-label="Actions for Ada Lovelace"');
    expect(html).toContain("new@example.com");
    expect(html).toContain("Resend to send a new link.");
  });

  it("is read-only for managers", () => {
    const html = render(<MembersSettings />, "MANAGER", (client) => client.setQueryData(queryKeys.members, MEMBERS));
    expect(html).toContain("Grace Hopper");
    expect(html).not.toContain("Invite manager");
    expect(html).not.toContain("Actions for");
    expect(html).not.toContain(">Resend<");
  });
});

describe("Settings → Notifications", () => {
  it("shows the defaults read-only while the endpoint is unavailable", () => {
    const html = render(<NotificationSettings />, "OWNER", (client) =>
      client.setQueryData<Availability<never>>(queryKeys.notificationPreferences, { available: false, data: null }),
    );
    expect(html).toContain("aren&#x27;t available yet");
    expect((html.match(/role="switch"/g) ?? []).length).toBe(Object.keys(NOTIFICATION_PREFERENCE_DEFAULTS).length * 2);
    expect(html).toMatch(/role="switch"[^>]*disabled=""/);
  });
});
