import type { Role } from "@workmode/shared/enums";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ComplianceEmployeeRow,
  ComplianceEmployeesResponse,
  ComplianceMetrics,
} from "@workmode/validation/compliance";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BillingOverview } from "@/components/billing/billing-overview";
import { JoinCodeQuickCopy } from "@/components/shell/join-code-quick-copy";
import { NotificationsBell } from "@/components/shell/notifications-bell";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { CurrentOrganisation, OnboardingChecklist as Checklist } from "@/hooks/api-shapes";
import type { NotificationsState } from "@/hooks/use-notifications";
import type { Availability } from "@/hooks/use-settings";
import { ApiClientError } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-client";
import { AWAITING_SETUP_PANEL_SIZE, AwaitingSetupPanel } from "./awaiting-setup-panel";
import { complianceKeys } from "./compliance-keys";
import { JoinCodeCard } from "./join-code-card";
import { OverviewMetrics } from "./metric-cards";
import { OnboardingChecklist } from "./onboarding-checklist";

/** Server-render the overview widgets, billing and top-bar widgets against a seeded cache. */
const ORGANISATION: CurrentOrganisation = {
  organisation: {
    id: "6f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a10",
    name: "Harbour Café",
    slug: "harbour-cafe",
    timezone: "Europe/London",
    dateFormat: "DMY",
    plan: "BUSINESS",
    billingStatus: "PAST_DUE",
    settings: { weekStartsOn: "MONDAY", timeFormat: "H24", requireInviteCodeToJoin: false },
  },
  role: "OWNER",
  membershipId: null,
  joinCode: "HARB42",
};

function render(node: ReactNode, seed: (client: QueryClient) => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  seed(client);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
}

/** `GET /api/auth/me` for a manager of ORGANISATION with the given role. */
const currentUser = (role: Role) => ({
  user: {
    id: "u",
    email: "a@example.com",
    name: "Ada",
    emailVerified: true,
    createdAt: "2026-10-01T00:00:00Z",
  },
  organisations: [
    {
      id: ORGANISATION.organisation.id,
      name: "Harbour Café",
      slug: "harbour-cafe",
      role,
      timezone: "Europe/London",
    },
  ],
  currentOrganisationId: ORGANISATION.organisation.id,
  csrfToken: "x",
});

const checklist = (overrides: Partial<Checklist> = {}): Checklist => ({
  items: [
    { key: "createCompany", label: "Create your company", done: true, href: "/settings" },
    { key: "createPolicy", label: "Create a Work Policy", done: false, href: "/policies/new" },
  ],
  completedCount: 1,
  totalCount: 2,
  complete: false,
  dismissedAt: null,
  ...overrides,
});

describe("OnboardingChecklist", () => {
  it("shows progress, the next step and links for each step", () => {
    const html = render(<OnboardingChecklist />, (c) => {
      c.setQueryData(queryKeys.onboarding, checklist());
      c.setQueryData(queryKeys.currentUser, currentUser("OWNER"));
    });
    expect(html).toContain("1 of 2 steps complete");
    expect(html).toContain("Next: Create a Work Policy");
    expect(html).toContain('href="/policies/new"');
    expect(html).toContain('aria-label="Setup 50% complete"');
    expect(html).toContain('aria-label="Dismiss setup checklist"');
  });

  it("only offers dismiss to roles that may dismiss (org:manage), and hides the all-done note from the rest", () => {
    const asManager = (data: Checklist) => (c: QueryClient) => {
      c.setQueryData(queryKeys.onboarding, data);
      c.setQueryData(queryKeys.currentUser, currentUser("MANAGER"));
    };
    const inProgress = render(<OnboardingChecklist />, asManager(checklist()));
    expect(inProgress).toContain("1 of 2 steps complete");
    expect(inProgress).not.toContain("Dismiss setup checklist");
    expect(render(<OnboardingChecklist />, asManager(checklist({ complete: true })))).toBe("");
  });

  it("turns into an all-done note with a dismiss action for owners once every step is complete", () => {
    const html = render(<OnboardingChecklist />, (c) => {
      c.setQueryData(queryKeys.onboarding, checklist({ complete: true, completedCount: 2 }));
      c.setQueryData(queryKeys.currentUser, currentUser("OWNER"));
    });
    expect(html).toContain("You&#x27;re all set");
    expect(html).toContain("Dismiss checklist");
  });

  it("stays out of the way when the endpoint is missing, but reports other failures with a retry", () => {
    const failWith = (error: ApiClientError) => (c: QueryClient) => {
      // Keep the seeded error on mount (otherwise the observer optimistically re-fetches and shows loading).
      c.setQueryDefaults(queryKeys.onboarding, { retryOnMount: false });
      c.getQueryCache().build(c, { queryKey: queryKeys.onboarding }).setState({
        status: "error",
        error,
        fetchStatus: "idle",
        errorUpdatedAt: 1,
        errorUpdateCount: 1,
      });
    };
    expect(
      render(
        <OnboardingChecklist />,
        failWith(new ApiClientError({ code: "NOT_FOUND", status: 404, message: "x" })),
      ),
    ).toBe("");
    const html = render(
      <OnboardingChecklist />,
      failWith(new ApiClientError({ code: "INTERNAL_ERROR", status: 500, message: "x" })),
    );
    expect(html).toContain("Couldn&#x27;t load your setup checklist");
    expect(html).toContain("Try again");
    expect(html).not.toContain("x</p>");
  });

  it("disappears once dismissed, whatever the role", () => {
    const dismissed = checklist({
      complete: true,
      completedCount: 2,
      dismissedAt: "2026-10-02T00:00:00Z",
    });
    expect(
      render(<OnboardingChecklist />, (c) => {
        c.setQueryData(queryKeys.onboarding, dismissed);
        c.setQueryData(queryKeys.currentUser, currentUser("OWNER"));
      }),
    ).toBe("");
    expect(
      render(<OnboardingChecklist />, (c) =>
        c.setQueryData(queryKeys.onboarding, checklist({ dismissedAt: "2026-10-02T00:00:00Z" })),
      ),
    ).toBe("");
  });
});

describe("OverviewMetrics", () => {
  const METRICS: ComplianceMetrics = {
    totalEmployees: 12,
    connected: 9,
    awaitingSetup: 3,
    missingPermissions: 0,
    workingNow: 5,
    workModeActive: 4,
    onBreak: 1,
    needsAttention: 2,
  };

  it("renders all eight cards as links to the rows behind each number", () => {
    const html = render(<OverviewMetrics metrics={METRICS} />, () => {});
    for (const key of Object.keys(METRICS)) expect(html).toContain(`data-metric="${key}"`);
    expect(html).toContain('href="/employees"');
    expect(html).toContain('href="/employees?filter=connected"');
    expect(html).toContain('href="/activity?tab=compliance&amp;filter=NEEDS_ATTENTION"');
    expect(html).toContain('href="/activity?tab=compliance&amp;filter=WORK_MODE_ACTIVE"');
    expect(html).toContain('data-metric="needsAttention" data-tone="danger"');
    expect(html).toContain('data-metric="connected" data-tone="success"');
    // Zero is nothing to act on, so it is never coloured.
    expect(html).toContain('data-metric="missingPermissions" data-tone="neutral"');
    expect(html).toContain('aria-label="Compliance at a glance"');
  });

  it("shows skeletons while loading", () => {
    const html = render(<OverviewMetrics metrics={undefined} isLoading />, () => {});
    expect((html.match(/aria-busy="true"/g) ?? []).length).toBe(8);
    expect(html).not.toContain("data-metric=");
  });
});

describe("AwaitingSetupPanel", () => {
  const PANEL_KEY = complianceKeys.employees({
    filter: "AWAITING_SETUP",
    search: "",
    page: 1,
    pageSize: AWAITING_SETUP_PANEL_SIZE,
    locationId: null,
    teamId: null,
  });

  const row = (
    id: string,
    firstName: string,
    lastName: string,
    inviteStatus: ComplianceEmployeeRow["employee"]["inviteStatus"],
    overrides: Partial<Omit<ComplianceEmployeeRow, "employee">> = {},
  ): ComplianceEmployeeRow => ({
    employee: { id, firstName, lastName, jobTitle: null, primaryLocation: null, inviteStatus },
    deviceStatus: null,
    permissionState: null,
    selectionState: null,
    expectedState: null,
    reportedState: null,
    activeShift: null,
    lastSyncAt: null,
    attentionReason: null,
    ...overrides,
  });

  const page = (
    items: ComplianceEmployeeRow[],
    total = items.length,
  ): ComplianceEmployeesResponse => ({
    items,
    page: 1,
    pageSize: AWAITING_SETUP_PANEL_SIZE,
    total,
    totalPages: Math.max(1, Math.ceil(total / AWAITING_SETUP_PANEL_SIZE)),
  });

  const JANE = "0b0e2e9e-7c0a-4a2b-9e3b-1b4c2a9d8f10";
  const SAM = "c7a1c8f2-4d7e-4d1b-9e55-2a4d8b6c3e21";
  const PRIYA = "9d2f6b1a-3e4c-4f5d-8a6b-7c8d9e0f1a2b";

  it("lists who still needs to set up with a status line and the actions that unblock them", () => {
    const html = render(<AwaitingSetupPanel />, (c) => {
      c.setQueryData(queryKeys.currentUser, currentUser("OWNER"));
      c.setQueryData(
        PANEL_KEY,
        page(
          [
            row(JANE, "Jane", "Smith", "INVITED"),
            row(SAM, "Sam", "Jones", "SETUP_INCOMPLETE", {
              permissionState: "DENIED",
              attentionReason: "Screen Time access was denied",
            }),
            row(PRIYA, "Priya", "Patel", "NOT_INVITED"),
          ],
          10,
        ),
      );
    });
    expect(html).toContain("Invite sent · waiting for them to join");
    expect(html).toContain('aria-label="Copy invite instructions for Jane Smith"');
    expect(html).toContain('aria-label="Resend invite to Jane Smith"');
    expect(html).toContain(`href="/employees/${JANE}"`);

    expect(html).toContain("Permission missing");
    expect(html).toContain("Screen Time access was denied");
    expect(html).not.toContain("Copy invite instructions for Sam Jones");
    expect(html).not.toContain("invite to Sam Jones");

    expect(html).toContain("Not invited yet");
    expect(html).toContain('aria-label="Invite Priya Patel"');

    expect(html).toContain("View all 10");
    // Same API filter as the panel itself, so the full list is exactly the rows behind the count.
    expect(html).toContain('href="/activity?tab=compliance&amp;filter=AWAITING_SETUP"');
  });

  it("celebrates when everyone is set up", () => {
    const html = render(<AwaitingSetupPanel />, (c) => {
      c.setQueryData(queryKeys.currentUser, currentUser("OWNER"));
      c.setQueryData(PANEL_KEY, page([]));
    });
    expect(html).toContain("Everyone is set up");
    expect(html).not.toContain("View all");
  });
});

describe("join code widgets", () => {
  it("shows the code with a copy button on the overview and in the top bar", () => {
    const seed = (c: QueryClient) => c.setQueryData(queryKeys.currentOrganisation, ORGANISATION);
    expect(render(<JoinCodeCard />, seed)).toContain("HARB42");
    const chip = render(<JoinCodeQuickCopy />, seed);
    expect(chip).toContain("HARB42");
    expect(chip).toContain('aria-label="Copy company join code"');
  });

  it("hides the top-bar chip when there is no active code", () => {
    expect(
      render(<JoinCodeQuickCopy />, (c) =>
        c.setQueryData(queryKeys.currentOrganisation, { ...ORGANISATION, joinCode: null }),
      ),
    ).toBe("");
  });
});

describe("NotificationsBell", () => {
  it("announces the unread count and caps the badge at 9+", () => {
    const feed: NotificationsState = {
      available: true,
      unreadCount: 12,
      items: [],
    };
    const html = render(<NotificationsBell />, (c) =>
      c.setQueryData(queryKeys.notifications, feed),
    );
    expect(html).toContain('aria-label="Notifications, 12 unread"');
    expect(html).toContain(">9+<");
  });

  it("has a plain label with nothing unread", () => {
    const feed: NotificationsState = { available: false, unreadCount: 0, items: [] };
    const html = render(<NotificationsBell />, (c) =>
      c.setQueryData(queryKeys.notifications, feed),
    );
    expect(html).toContain('aria-label="Notifications"');
  });
});

describe("BillingOverview", () => {
  it("shows the plan, a past-due warning and the plan catalogue", () => {
    const html = render(<BillingOverview />, (c) => {
      c.setQueryData(queryKeys.currentOrganisation, ORGANISATION);
      c.setQueryData(queryKeys.currentUser, currentUser("OWNER"));
      c.setQueryData<Availability<never>>(queryKeys.billing, { available: false, data: null });
    });
    expect(html).toContain("Payment overdue");
    expect(html).toContain('data-value="PAST_DUE"');
    expect(html).toContain("Current plan");
    // Plan changes go through sales for now; the exact wording belongs to the billing component.
    expect(html).toContain("Contact sales");
    expect((html.match(/<h3/g) ?? []).length).toBe(4);
  });

  it("says when usage couldn't be loaded instead of silently leaving it out", () => {
    const html = render(<BillingOverview />, (c) => {
      c.setQueryData(queryKeys.currentOrganisation, ORGANISATION);
      c.setQueryDefaults(queryKeys.billing, { retryOnMount: false });
      c.getQueryCache()
        .build(c, { queryKey: queryKeys.billing })
        .setState({
          status: "error",
          error: new ApiClientError({
            code: "INTERNAL_ERROR",
            status: 500,
            message: "stack trace here",
          }),
          fetchStatus: "idle",
          errorUpdatedAt: 1,
          errorUpdateCount: 1,
        });
    });
    expect(html).toContain("Usage couldn&#x27;t be loaded");
    expect(html).toContain("Try again");
    expect(html).not.toContain("stack trace here");
  });
});
